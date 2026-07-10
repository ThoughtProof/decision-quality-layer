#!/usr/bin/env node
/**
 * DQL Determinism Metric Runner.
 *
 * For each case in the given suite directory, runs the full cascade N times
 * ("draws") and records the aggregate verdict + per-axis verdict/confidence
 * for each draw. Emits one JSONL row per case with all N draws attached.
 *
 * Downstream analysis (see scripts/analyze-determinism.mjs) computes:
 *   - % N-draw-stable rows (all N draws yield identical aggregate verdict)
 *   - % Rows with axis-level flips (any single axis flips verdict across draws)
 *   - Per-category stability breakdown
 *   - Per-row flip signature for regression diagnosis
 *
 * Usage:
 *   DQL_CASCADE=pot-cli SERV_API_KEY=… \
 *     node --require ./node-proxy-bootstrap.cjs scripts/run-determinism-metric.mjs \
 *       --dir scenarios/adversarial \
 *       --draws 5 \
 *       --workers 1 \
 *       --out runs/determinism-main.jsonl
 *
 * Resume behavior: if --out already contains a row for a case with `draws.length
 * === N` and no fetch-failed axes, that case is skipped. Partial (fetch-failed)
 * rows are retried.
 */
import { readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { runVerification } from '../dist/src/engine/index.js';
import { PotCliCascade } from '../dist/src/engine/cascade-pot.js';
import { SandboxCascade } from '../dist/src/engine/sandbox-cascade.js';
import { HttpLlmClient } from '../dist/src/engine/llm-client.js';

// Same retry wrapper as the adversarial suite runner. Keeps behavior identical
// so a fetch-failed axis here means the same thing as in the suite.
class RetryLlmClient {
  constructor(inner = new HttpLlmClient(), { attempts = 6, baseMs = 800 } = {}) {
    this.inner = inner; this.attempts = attempts; this.baseMs = baseMs;
  }
  async call(alias, input) {
    let lastErr;
    for (let i = 0; i < this.attempts; i++) {
      try { return await this.inner.call(alias, input); }
      catch (e) {
        lastErr = e;
        const msg = String(e && (e.message || e));
        const retryable = /429|too many|rate|proxy|fetch failed|ECONN|ETIMEDOUT|EAI_AGAIN|socket hang up/i.test(msg);
        if (!retryable) throw e;
        const wait = Math.min(this.baseMs * Math.pow(2, i), 20000) + Math.random() * 800;
        await new Promise((r) => setTimeout(r, wait));
      }
    }
    throw lastErr;
  }
}

const __dirname = dirname(fileURLToPath(import.meta.url));

const args = process.argv.slice(2);
function argVal(name, def) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : def;
}
const dir = resolve(__dirname, '..', argVal('--dir', 'scenarios/adversarial'));
const outPath = resolve(__dirname, '..', argVal('--out', 'runs/determinism.jsonl'));
const draws = Math.max(2, Number(argVal('--draws', '5')));
const workers = Math.max(1, Number(argVal('--workers', '1')));
const limit = Number(argVal('--limit', '0')) || 0;
const onlyIds = (argVal('--only', '') || '').split(',').map((s) => s.trim()).filter(Boolean);

if (!existsSync(dirname(outPath))) mkdirSync(dirname(outPath), { recursive: true });

const files = readdirSync(dir).filter((f) => f.endsWith('.jsonl')).sort();
const turns = [];
for (const f of files) {
  const rows = readFileSync(join(dir, f), 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
  turns.push(...rows);
}
let all = limit ? turns.slice(0, limit) : turns;
const allIdSet = new Set(all.map((t) => t.id));
if (onlyIds.length) all = all.filter((t) => onlyIds.includes(t.id));
console.log(`[det-runner] loaded ${all.length} turns from ${files.length} files, draws=${draws}, workers=${workers}`);

const client = new RetryLlmClient();
const cascade = new PotCliCascade(client);
const sandboxCascade = new SandboxCascade();

function normalize(v) {
  if (!v) return 'UNKNOWN';
  const u = String(v).toUpperCase();
  return { ALLOW: 'PASS', OK: 'PASS', DENY: 'BLOCK', REJECT: 'BLOCK' }[u] || u;
}

function rowIsComplete(row, expectedDraws) {
  if (!row || !Array.isArray(row.draws)) return false;
  if (row.draws.length !== expectedDraws) return false;
  for (const d of row.draws) {
    if (!d || !d.per_axis) return false;
    if (d.verdict === 'ERROR') return false;
    const allEmpty = Object.values(d.per_axis).every((a) => a.verdict === 'UNCERTAIN' && a.confidence === 0);
    if (allEmpty) return false;
  }
  return true;
}

async function runDraw(t, drawIdx) {
  const t0 = Date.now();
  try {
    const body = {
      mandate: t.mandate,
      proposed_action: t.proposed_action,
      reasoning: t.reasoning,
      context: t.context,
      sandbox: false,
      axes: ['intent', 'scope', 'risk', 'consistency', 'reversibility'],
    };
    const res = await runVerification({
      cascade,
      sandboxCascade,
      request: body,
      requestId: `det_${t.id}_d${drawIdx}`,
      version: 'determinism-baseline',
    });
    const dt = Date.now() - t0;
    return {
      draw: drawIdx,
      verdict: normalize(res?.aggregate?.verdict),
      per_axis: Object.fromEntries((res?.axes ?? []).map((a) => [a.axis, { verdict: a.verdict, confidence: a.confidence, objection: (a.objection || '').slice(0, 120) }])),
      latency_ms: dt,
    };
  } catch (e) {
    return {
      draw: drawIdx,
      verdict: 'ERROR',
      per_axis: {},
      latency_ms: Date.now() - t0,
      error: String(e && (e.message || e)).slice(0, 240),
    };
  }
}

async function runCase(t) {
  const drawsOut = [];
  for (let i = 0; i < draws; i++) {
    const d = await runDraw(t, i);
    drawsOut.push(d);
  }
  // Aggregate per-case stability
  const verdicts = drawsOut.map((d) => d.verdict);
  const uniqueVerdicts = [...new Set(verdicts)];
  const aggregateStable = uniqueVerdicts.length === 1;
  // Per-axis stability
  const axisNames = ['intent', 'scope', 'risk', 'consistency', 'reversibility'];
  const perAxisFlips = {};
  for (const ax of axisNames) {
    const verdictsOnAxis = drawsOut.map((d) => d.per_axis?.[ax]?.verdict || 'MISSING');
    const uniq = [...new Set(verdictsOnAxis)];
    perAxisFlips[ax] = { unique_verdicts: uniq, stable: uniq.length === 1 };
  }
  const anyAxisFlip = Object.values(perAxisFlips).some((v) => !v.stable);
  const expVerdict = normalize(t.ground_truth?.expected_verdict);
  return {
    id: t.id,
    category: t.category,
    domain: t.domain,
    difficulty: t.difficulty,
    expected_verdict: expVerdict,
    n_draws: draws,
    aggregate_stable: aggregateStable,
    aggregate_unique_verdicts: uniqueVerdicts,
    any_axis_flip: anyAxisFlip,
    per_axis_flips: perAxisFlips,
    draws: drawsOut,
  };
}

// Resume: skip cases with complete rows already in outPath.
// In --only mode, still preserve OTHER complete rows in the output file so they
// don't get truncated. `preserve` is written back verbatim; `already` is only the
// subset relevant to the current run (used for skip decisions).
let already = {};
let preserve = [];
if (existsSync(outPath)) {
  try {
    for (const l of readFileSync(outPath, 'utf8').split('\n').filter((x) => x.trim())) {
      const r = JSON.parse(l);
      if (rowIsComplete(r, draws)) {
        if (onlyIds.length && !onlyIds.includes(r.id)) {
          preserve.push(r);
        } else {
          already[r.id] = r;
        }
      }
    }
    console.log(`[det-runner] resume: ${Object.keys(already).length} rows already complete for this run, ${preserve.length} preserved from prior runs`);
  } catch (e) { console.warn('[det-runner] resume parse failed:', e.message); already = {}; }
}

async function runAll() {
  const results = [...Object.values(already), ...preserve];
  const todo = all.filter((t) => !already[t.id]);
  console.log(`[det-runner] to process: ${todo.length} cases × ${draws} draws = ${todo.length * draws} cascade runs`);
  let idx = 0;
  let done = 0;
  async function worker() {
    while (true) {
      const i = idx++;
      if (i >= todo.length) return;
      const r = await runCase(todo[i]);
      results.push(r);
      done++;
      if (done % 5 === 0 || done === todo.length) {
        const stable = results.filter((x) => x.aggregate_stable).length;
        const lastLat = r.draws[r.draws.length - 1]?.latency_ms || 0;
        console.log(`  ${done}/${todo.length}  aggregate_stable=${stable}/${results.length}  last_lat=${lastLat}ms`);
        const sorted = [...results].sort((a, b) => a.id.localeCompare(b.id));
        writeFileSync(outPath, sorted.map((x) => JSON.stringify(x)).join('\n') + '\n', 'utf8');
      }
    }
  }
  const wall0 = Date.now();
  await Promise.all(Array.from({ length: workers }, () => worker()));
  const wall = Date.now() - wall0;
  results.sort((a, b) => a.id.localeCompare(b.id));
  writeFileSync(outPath, results.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
  const stable = results.filter((x) => x.aggregate_stable).length;
  const axisFlips = results.filter((x) => x.any_axis_flip).length;
  console.log(`[det-runner] wrote ${results.length} rows to ${outPath}`);
  console.log(`[det-runner] aggregate_stable=${stable}/${results.length} (${((stable / results.length) * 100).toFixed(1)}%)`);
  console.log(`[det-runner] rows_with_any_axis_flip=${axisFlips}/${results.length} (${((axisFlips / results.length) * 100).toFixed(1)}%)`);
  console.log(`[det-runner] wall=${(wall / 1000).toFixed(1)}s`);
}

await runAll();
