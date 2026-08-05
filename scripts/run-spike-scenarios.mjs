#!/usr/bin/env node
/**
 * Regression runner for scenarios/spike-*.jsonl.
 *
 * Streams each frozen scenario through the configured DQL cascade and
 * reports hybrid gate metrics (Issue #26):
 *   • parse-rate       — hard floor 100%
 *   • fail-open-rate   — ALLOW / all parsed — hard floor 0
 *   • safe-closed-rate — BLOCK|REVIEW among axis-hit misses — hard floor 95%
 *   • axis-hit-rate    — soft (diagnostic; enforce with --strict-axis-hit)
 *
 * OFF-CI by design: this script talks to real LLMs and costs real money.
 * Do NOT wire it into the default `npm test`. Invoke explicitly via
 * `npm run scenarios:spike`.
 *
 * Usage:
 *   node scripts/run-spike-scenarios.mjs [--file path] [--limit N] [--ids id1,id2] [--out path] [--expect N] [--strict-axis-hit]
 *
 * Defaults to scenarios/spike-40.jsonl with an expected count of 40. Override
 * with --file for pilots or Spike-80. Pass --expect 0 to skip the count check.
 *
 * Env:
 *   DQL_CASCADE=pot-cli
 *   SERV_API_KEY=...
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { runVerification } from '../dist/src/engine/index.js';
import { PotCliCascade } from '../dist/src/engine/cascade-pot.js';
import { StubCascade } from '../dist/src/engine/cascade.js';
import { SandboxCascade } from '../dist/src/engine/sandbox-cascade.js';
import {
  computeHybridSummary,
  formatHybridConsole,
} from './lib/spike-hybrid-metrics.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---- args ------------------------------------------------------------------

const args = process.argv.slice(2);
function argVal(name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}
const limit = Number(argVal('--limit') ?? '0') || 0;
const idsFilter = (argVal('--ids') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const outPath = argVal('--out') ?? resolve(__dirname, '..', 'scenarios', 'last-run.json');
const fileArg = argVal('--file') ?? 'scenarios/spike-40.jsonl';
const expected = argVal('--expect');
const expectedCount = expected === undefined ? 40 : Number(expected);
const strictAxisHit = args.includes('--strict-axis-hit');

// ---- load scenarios --------------------------------------------------------

const scenarioPath = resolve(__dirname, '..', fileArg);
const scenarios = readFileSync(scenarioPath, 'utf8')
  .split('\n')
  .filter((l) => l.trim())
  .map((l) => JSON.parse(l));

if (expectedCount > 0 && scenarios.length !== expectedCount) {
  throw new Error(`expected ${expectedCount} scenarios in ${fileArg}, got ${scenarios.length}`);
}

const filtered = scenarios
  .filter((s) => idsFilter.length === 0 || idsFilter.includes(s.id))
  .slice(0, limit || undefined);

if (filtered.length === 0) {
  throw new Error('no scenarios selected — check --ids and --limit');
}

// ---- cascade selection (mirrors api/dql/verify.ts) -------------------------

function pickCascade() {
  const mode = (process.env.DQL_CASCADE ?? 'stub').toLowerCase();
  if (mode === 'pot-cli' || mode === 'potcli' || mode === 'live') return new PotCliCascade();
  return new StubCascade();
}
const cascade = pickCascade();
const sandboxCascade = new SandboxCascade();

if (cascade instanceof StubCascade) {
  console.warn('⚠  DQL_CASCADE not set to pot-cli — running against StubCascade will report low axis-hit-rate.');
  console.warn('   For a real regression run, export DQL_CASCADE=pot-cli plus SERV_API_KEY.');
}

// ---- runner ----------------------------------------------------------------

const AXES = ['intent', 'scope', 'risk', 'consistency', 'reversibility'];

/** Detect that an axis result was UNCERTAIN because the model output failed
 *  to parse. The parseAxisResponse contract embeds the raw output in
 *  `objection` for that case; the reasoning also starts with a fixed
 *  sentinel string. Either signal is enough. */
function isParseFail(axisResult) {
  return (
    axisResult.verdict === 'UNCERTAIN' &&
    axisResult.confidence === 0 &&
    axisResult.reasoning.startsWith('Could not parse')
  );
}

const perCase = [];
const startAll = Date.now();

for (const s of filtered) {
  const started = Date.now();
  const response = await runVerification({
    request: {
      ...s.request,
      sandbox: false,
    },
    cascade,
    sandboxCascade,
    requestId: `spike_${s.id}`,
    version: 'regression',
  });

  const axisMap = Object.fromEntries(response.axes.map((a) => [a.axis, a]));
  const expectedAxis = axisMap[s.expected_fail_axis];
  const parseFails = response.axes.filter(isParseFail).map((a) => a.axis);
  const failedAxes = response.axes.filter((a) => a.verdict === 'FAIL').map((a) => a.axis);
  const passedAxes = response.axes.filter((a) => a.verdict === 'PASS').map((a) => a.axis);
  const uncertainAxes = response.axes
    .filter((a) => a.verdict === 'UNCERTAIN' && !isParseFail(a))
    .map((a) => a.axis);

  const others = AXES.filter((a) => a !== s.expected_fail_axis);
  const otherFireCount = others.filter((a) => axisMap[a].verdict === 'FAIL').length;

  const axisHit = expectedAxis.verdict === 'FAIL';
  const agg = response.aggregate.verdict;
  const failOpen = agg === 'ALLOW';
  const safeClosed = agg === 'BLOCK' || agg === 'REVIEW';

  const record = {
    id: s.id,
    expected_fail_axis: s.expected_fail_axis,
    axis_hit: axisHit,
    hit: axisHit,
    expected_verdict: expectedAxis.verdict,
    expected_confidence: expectedAxis.confidence,
    aggregate_verdict: agg,
    fail_open: failOpen,
    safe_closed: safeClosed,
    parse_ok: parseFails.length === 0,
    parse_fails: parseFails,
    failed_axes: failedAxes,
    passed_axes: passedAxes,
    uncertain_axes: uncertainAxes,
    other_axes_fired: otherFireCount,
    models_used: response.meta.models_used,
    latency_ms: Date.now() - started,
  };
  perCase.push(record);

  const mark = record.axis_hit ? '✓' : '✗';
  const fo = record.fail_open ? ' FAIL-OPEN' : '';
  process.stdout.write(
    `${mark} ${s.id.padEnd(6)} exp=${s.expected_fail_axis.padEnd(13)} got=${expectedAxis.verdict}@${expectedAxis.confidence.toFixed(2)}  ` +
      `agg=${agg.padEnd(6)}  others_fired=${otherFireCount}  ${record.latency_ms}ms${fo}\n`,
  );
}

// ---- summary (hybrid gate) -------------------------------------------------

const hybrid = computeHybridSummary(perCase, { strictAxisHit });

const perAxisTotals = {};
for (const axis of AXES) {
  const cases = perCase.filter((r) => r.expected_fail_axis === axis);
  perAxisTotals[axis] = {
    total: cases.length,
    hits: cases.filter((r) => r.axis_hit).length,
    hit_rate: cases.length ? cases.filter((r) => r.axis_hit).length / cases.length : 0,
  };
}
const nonQuiet = perCase.reduce((n, r) => n + r.other_axes_fired, 0);
const otherFireRate = perCase.length ? nonQuiet / (perCase.length * 4) : 0;

const summary = {
  total_cases: hybrid.total_cases,
  parse_rate: hybrid.parse_rate,
  fail_open_rate: hybrid.fail_open_rate,
  fail_open_ids: hybrid.fail_open_ids,
  safe_closed_rate: hybrid.safe_closed_rate,
  safe_closed_rate_view: hybrid.safe_closed_rate_view,
  safe_closed_all_rate: hybrid.safe_closed_all_rate,
  miss_count: hybrid.miss_count,
  axis_hit_rate: hybrid.axis_hit_rate,
  other_axes_fire_rate: otherFireRate,
  per_axis: perAxisTotals,
  duration_ms: Date.now() - startAll,
  cascade_mode: process.env.DQL_CASCADE ?? 'stub',
  thresholds: hybrid.thresholds,
  passed: hybrid.passed,
};

const report = { summary, cases: perCase };
writeFileSync(outPath, JSON.stringify(report, null, 2));

console.log('\n───────────────────────────────────────────────');
console.log(`Total:               ${summary.total_cases}`);
console.log(formatHybridConsole(hybrid));
console.log(`Other-axes fire:     ${(otherFireRate * 100).toFixed(1)}%  (lower = more orthogonal)`);
console.log('\nPer-axis hit-rate:');
for (const axis of AXES) {
  const p = perAxisTotals[axis];
  console.log(`  ${axis.padEnd(14)} ${p.hits}/${p.total}  (${(p.hit_rate * 100).toFixed(1)}%)`);
}
console.log(`\nReport written to ${outPath}`);
console.log(`Overall: ${summary.passed ? '✓ PASSED' : '✗ FAILED (below hybrid threshold)'}`);
process.exit(summary.passed ? 0 : 1);
