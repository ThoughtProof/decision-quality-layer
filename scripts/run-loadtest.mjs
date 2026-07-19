#!/usr/bin/env node
/**
 * Staged, NON-CERTIFYING reliability/load harness runner.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHAT THIS IS (and is NOT)
 *   This drives a FIXED, frozen selection of 8 representative spike-80 scenarios
 *   through the REAL DQL production Option-A path (serv-nano primary → serv-swift
 *   secondary, deadline layering armed, per-alias circuit breakers ON) under
 *   bounded concurrency with NO pacing. It measures RELIABILITY and LOAD
 *   behaviour only: per-alias route/outcome, circuit transitions, deadline
 *   sources, retries/backoff/latency, REVIEW amplification, throughput.
 *
 *   It is NOT a certification, calibration, FAR/FBR, or decision-quality
 *   measurement. Every artefact is stamped { certifying:false,
 *   load_test_only:true } and `assertNonCertifying` fails closed if any
 *   certification/calibration-shaped field ever appears.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * OFFLINE BY DEFAULT — no provider call is made unless you pass --live.
 *   • default (dry-run): a deterministic in-process executor returns a served
 *     BLOCK with the expected axis FAILing. Zero network I/O. Proves the full
 *     harness/checkpoint/guard/identity plumbing.
 *   • --live: constructs the production runtime from process.env (requires
 *     SERV_API_KEY) and makes REAL provider calls. Refuses to start without a key.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * THE MATRIX (defensible <=24-execution design)
 *   8 fixed cases (all 5 axes; coarse + subtle), run at three concurrencies:
 *     stage c1  (control)  concurrency=1   N=8
 *     stage c2             concurrency=2   N=8
 *     stage c4             concurrency=4   N=8
 *   = 24 total executions. Each stage is a SEPARATE invocation with its own
 *   checkpoint dir + identity hash, so a stage only proceeds after the prior
 *   stage's guards (identity/provenance/storm/wall-clock) have been inspected.
 *
 * MAX PROVIDER CALLS (hard upper bound the caps enforce), per stage:
 *   8 cases × 5 axes × 2 (primary+secondary) × 2 (nano↔swift fallback route)
 *          × 2 (pinned maxAttempts) = 320  →  ×3 stages = 960 absolute ceiling.
 *   Expected HEALTHY per stage ≈ 8 × 5 × 2 = 80 (primary+secondary, 1 attempt,
 *   served, no fallback) → ≈240 across the matrix. maxAttempts is pinned to 2
 *   and the selection is fixed, so no drift can exceed the ceiling.
 *
 * USAGE
 *   Build first:  npm run build
 *   Dry-run one stage (offline, no calls):
 *     node scripts/run-loadtest.mjs --concurrency 1 --run-id lt-dry-c1
 *   Live one stage (real calls; needs SERV_API_KEY):
 *     node scripts/run-loadtest.mjs --live --concurrency 1 --run-id lt-live-c1
 *
 * FLAGS
 *   --live                make real provider calls (default: offline dry-run)
 *   --concurrency <n>     bounded concurrency for this stage (default 1)
 *   --run-id <id>         checkpoint + report basename (default lt-<mode>-c<n>)
 *   --out <path>          report JSON output path (default runs/loadtest/<runId>/report.json)
 *   --w-ms <n>            requestDeadlineMs (default 45000)
 *   --pc-ms <n>          providerCallBudgetMs (default 18000)
 *   --t-ms <n>            per-attempt timeoutMs (default 15000)
 *   --max-attempts <n>    pinned retry attempts (default 2)
 *   --wall-cap-ms <n>     wall-clock cap for the stage (default 600000)
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import {
  LoadTestHarness,
  assertNonCertifying,
  sha256Hex,
} from '../dist/src/loadtest/harness.js';
import { createLiveBackend } from '../dist/src/loadtest/live-executor.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');

// ── args ────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const val = (f, d) => {
  const i = args.indexOf(f);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : d;
};

const live = has('--live');
const concurrency = Number(val('--concurrency', '1'));
const mode = live ? 'live' : 'dry';
const runId = val('--run-id', `lt-${mode}-c${concurrency}`);
const wMs = Number(val('--w-ms', '45000'));
const pcMs = Number(val('--pc-ms', '18000'));
const tMs = Number(val('--t-ms', '15000'));
const maxAttempts = Number(val('--max-attempts', '2'));
const wallCapMs = Number(val('--wall-cap-ms', '600000'));

const runDir = join(repoRoot, 'runs', 'loadtest', runId);
const outPath = val('--out', join(runDir, 'report.json'));

// ── fixed, frozen selection: 8 representative cases, all 5 axes, coarse+subtle ─
const SELECTED_IDS = [
  'int-01',
  'scp-01',
  'rsk-01',
  'cns-01',
  'rev-01',
  'subtle-int-01',
  'subtle-scp-01',
  'subtle-rsk-01',
];

const VERSION = 'loadtest';

function loadSelection() {
  const scenarioPath = resolve(repoRoot, 'scenarios', 'spike-80.jsonl');
  const raw = readFileSync(scenarioPath, 'utf8');
  const byId = new Map();
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    const s = JSON.parse(line);
    byId.set(s.id, s);
  }
  const selected = [];
  for (const id of SELECTED_IDS) {
    const s = byId.get(id);
    if (!s) throw new Error(`[loadtest] fixed case '${id}' not found in spike-80.jsonl — fail closed`);
    selected.push({ id: s.id, expected_fail_axis: s.expected_fail_axis, request: s.request });
  }
  return { selected, scenarioFileHash: sha256Hex(raw) };
}

// ── file-backed, append-only checkpoint I/O ───────────────────────────────────
function fileCheckpointIO(dir) {
  mkdirSync(dir, { recursive: true });
  const manifestPath = join(dir, 'manifest.json');
  const resultsPath = join(dir, 'results.jsonl');
  return {
    readManifest() {
      return existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, 'utf8')) : null;
    },
    writeManifest(m) {
      writeFileSync(manifestPath, JSON.stringify(m, null, 2));
    },
    readResultLines() {
      return existsSync(resultsPath)
        ? readFileSync(resultsPath, 'utf8').split('\n').filter((l) => l.trim())
        : [];
    },
    appendResult(line) {
      appendFileSync(resultsPath, line + '\n');
    },
  };
}

// ── offline deterministic executor: served BLOCK, expected axis FAILs ─────────
const OFFLINE_PINS = {
  'serv-nano': 'serv:serv-nano:offline',
  'serv-swift': 'serv:serv-swift:offline',
};
function offlineExecutor() {
  const AXES = ['intent', 'scope', 'risk', 'consistency', 'reversibility'];
  return async ({ loadCase }) => {
    const axes = AXES.map((name) => ({
      axis: name,
      verdict: name === loadCase.expected_fail_axis ? 'FAIL' : 'PASS',
      confidence: 0.9,
      reasoning: 'x',
      objection: name === loadCase.expected_fail_axis ? 'o' : '',
      provider_route: 'primary',
      provider_outcome: 'served',
    }));
    return {
      response: {
        id: loadCase.id,
        version: VERSION,
        axes,
        aggregate: { verdict: 'BLOCK', confidence: 0.9, triggered_by: [], rationale: 'x' },
        meta: { duration_ms: 1, models_used: ['serv:serv-nano'], axes_evaluated: AXES, sandbox: false },
      },
    };
  };
}

async function main() {
  const { selected, scenarioFileHash } = loadSelection();

  if (live && !process.env.SERV_API_KEY) {
    console.error('[loadtest] --live requires SERV_API_KEY in the environment. Refusing to start.');
    process.exit(2);
  }

  let deps;
  let aliasPins;
  if (live) {
    const backend = createLiveBackend({
      env: process.env,
      version: VERSION,
      deadline: { requestDeadlineMs: wMs, providerCallBudgetMs: pcMs },
      // Pin the hard-cap math: exactly maxAttempts iterations, T per attempt.
      clientOptionsOverride: { maxAttempts, timeoutMs: tMs },
    });
    aliasPins = backend.aliasPins;
    deps = {
      executor: backend.executor,
      io: fileCheckpointIO(runDir),
      resolveFingerprints: backend.resolveFingerprints,
      probeCircuits: backend.probeCircuits,
    };
    // secretScanValues sourced from env at runtime, never printed.
    var secretScanValues = backend.secretScanValues;
  } else {
    aliasPins = { ...OFFLINE_PINS };
    deps = {
      executor: offlineExecutor(),
      io: fileCheckpointIO(runDir),
      resolveFingerprints: () => ({ ...OFFLINE_PINS }),
    };
    var secretScanValues = [];
  }

  const config = {
    runId,
    concurrency,
    hardConcurrencyCap: 4,
    n: selected.length,
    aliasPins,
    deadline: { requestDeadlineMs: wMs, providerCallBudgetMs: pcMs },
    scenarioFileHash,
    wallClockCapMs: wallCapMs,
    // Storm budget: one stage's worth of axis draws (8×5). A degraded provider
    // that errors every axis aborts the stage instead of hammering.
    maxProviderErrorStorm: selected.length * 5,
    maxOpenTransitions: selected.length,
    secretScanValues,
  };

  const harness = new LoadTestHarness(config, selected, deps);

  const perStageMax = selected.length * 5 * 2 * 2 * maxAttempts;
  console.error(
    `[loadtest] mode=${mode} runId=${runId} concurrency=${concurrency} N=${selected.length}\n` +
      `[loadtest] deadline W=${wMs}ms PC=${pcMs}ms T=${tMs}ms maxAttempts=${maxAttempts}\n` +
      `[loadtest] max provider calls this stage (hard ceiling) = ${perStageMax}`,
  );

  let report;
  try {
    report = await harness.run();
  } catch (err) {
    console.error(`[loadtest] ABORTED (fail-closed): ${err?.reason ?? ''} ${err?.message ?? err}`);
    process.exit(1);
  }

  assertNonCertifying(report);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(report, null, 2));

  console.error(
    `[loadtest] completed=${report.completed}/${config.n} aborted=${report.aborted}` +
      (report.abort_reason ? ` reason=${report.abort_reason}` : ''),
  );
  console.error(
    `[loadtest] verdicts=${JSON.stringify(report.aggregate_verdicts)} ` +
      `movements=${JSON.stringify(report.movements)}`,
  );
  console.error(
    `[loadtest] deadline_sources=${JSON.stringify(report.deadline_sources)} ` +
      `transitions=${JSON.stringify(report.circuit_transitions)}`,
  );
  console.error(`[loadtest] live_totals=${JSON.stringify(report.live_totals)}`);
  console.error(
    `[loadtest] throughput=${report.throughput_cases_per_s.toFixed(3)} cases/s ` +
      `latency_ms=${JSON.stringify(report.latency_ms)}`,
  );
  console.error(`[loadtest] report → ${outPath}`);

  // A stage that aborted is measured data, not a crash — exit non-zero so an
  // orchestrator halts progression to the next concurrency stage.
  process.exit(report.aborted ? 3 : 0);
}

main().catch((err) => {
  console.error('[loadtest] unexpected failure:', err);
  process.exit(1);
});
