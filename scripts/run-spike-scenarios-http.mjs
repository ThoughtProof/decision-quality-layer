#!/usr/bin/env node
/**
 * HTTP variant of run-spike-scenarios.mjs — posts to a live DQL endpoint
 * instead of invoking the cascade in-process.
 *
 * Use this when running scenarios against dql.thoughtproof.ai (or any
 * deployed instance) rather than a local cascade with a local SERV key.
 *
 * OFF-CI by design — talks to real LLMs and costs real money.
 *
 * Usage:
 *   node scripts/run-spike-scenarios-http.mjs \
 *     --file scenarios/spike-80-pilot.jsonl \
 *     --base https://dql.thoughtproof.ai \
 *     --expect 10 \
 *     --out scenarios/pilot-live.json
 *
 * Env:
 *   DQL_API_KEY  optional, sent as x-api-key header if set
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

const args = process.argv.slice(2);
function argVal(name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}
const fileArg = argVal('--file') ?? 'scenarios/spike-40.jsonl';
const baseUrl = (argVal('--base') ?? 'https://dql.thoughtproof.ai').replace(/\/$/, '');
const outPath = argVal('--out') ?? resolve(__dirname, '..', 'scenarios', 'last-run.json');
const expectedCount = Number(argVal('--expect') ?? '0');
const limit = Number(argVal('--limit') ?? '0') || 0;

const scenarioPath = resolve(__dirname, '..', fileArg);
const scenarios = readFileSync(scenarioPath, 'utf8')
  .split('\n')
  .filter((l) => l.trim())
  .map((l) => JSON.parse(l));

if (expectedCount > 0 && scenarios.length !== expectedCount) {
  throw new Error(`expected ${expectedCount} scenarios in ${fileArg}, got ${scenarios.length}`);
}

const filtered = limit > 0 ? scenarios.slice(0, limit) : scenarios;
console.log(`Running ${filtered.length} scenarios against ${baseUrl}/dql/verify\n`);

const results = [];
const headers = { 'content-type': 'application/json' };
if (process.env.DQL_API_KEY) headers['x-api-key'] = process.env.DQL_API_KEY;

for (const s of filtered) {
  const t0 = Date.now();
  let response;
  try {
    const r = await fetch(`${baseUrl}/dql/verify`, {
      method: 'POST',
      headers,
      body: JSON.stringify(s.request),
    });
    response = await r.json();
    if (!r.ok) throw new Error(`HTTP ${r.status}: ${JSON.stringify(response)}`);
  } catch (err) {
    console.log(`✗ ${s.id} — ERROR: ${err.message}`);
    results.push({ id: s.id, expected: s.expected_fail_axis, error: err.message });
    continue;
  }
  const dt = Date.now() - t0;

  const axesArr = Array.isArray(response.axes) ? response.axes : [];
  const expected = s.expected_fail_axis;
  const expectedAxis = axesArr.find((a) => a.axis === expected);
  const gotVerdict = expectedAxis?.verdict ?? 'MISSING';
  const gotConf = Number(expectedAxis?.confidence ?? 0).toFixed(2);
  const hit = gotVerdict === 'FAIL';
  const othersFired = axesArr.filter((a) => a.axis !== expected && a.verdict === 'FAIL').length;
  const parseOk = axesArr.length === 5;
  const agg = response.aggregate?.verdict ?? 'MISSING';
  const mark = hit ? '✓' : '✗';
  console.log(
    `${mark} ${s.id.padEnd(16)} exp=${expected.padEnd(13)} got=${gotVerdict}@${gotConf}  agg=${agg}  others_fired=${othersFired}  ${dt}ms`,
  );
  results.push({
    id: s.id,
    expected,
    got_verdict: gotVerdict,
    got_confidence: Number(gotConf),
    hit,
    parse_ok: parseOk,
    aggregate_verdict: agg,
    others_fired: othersFired,
    axes: axesArr.map((a) => ({ axis: a.axis, verdict: a.verdict, confidence: a.confidence })),
    ms: dt,
  });
}

// ---- summary ---------------------------------------------------------------

const total = results.filter((r) => !r.error).length;
const parseRate = results.filter((r) => r.parse_ok).length / total;
const hits = results.filter((r) => r.hit).length;
const axisHitRate = hits / total;
const othersFireRate = results.filter((r) => !r.error).reduce((s, r) => s + r.others_fired, 0) / (total * 4);
const perAxis = {};
for (const r of results.filter((r) => !r.error)) {
  perAxis[r.expected] ??= { total: 0, hits: 0 };
  perAxis[r.expected].total += 1;
  if (r.hit) perAxis[r.expected].hits += 1;
}

console.log('\n───────────────────────────────────────────────');
console.log(`Total:               ${total}`);
console.log(`Parse-rate:          ${(parseRate * 100).toFixed(1)}%  (floor 100%)`);
console.log(`Axis-hit-rate:       ${(axisHitRate * 100).toFixed(1)}%  (floor 90%)`);
console.log(`Other-axes fire:     ${(othersFireRate * 100).toFixed(1)}%  (lower = more orthogonal)`);
console.log('\nPer-axis hit-rate:');
for (const [ax, v] of Object.entries(perAxis)) {
  console.log(`  ${ax.padEnd(14)} ${v.hits}/${v.total}  (${((v.hits / v.total) * 100).toFixed(1)}%)`);
}

const summary = {
  summary: {
    base_url: baseUrl,
    scenario_file: fileArg,
    total_cases: total,
    parse_rate: parseRate,
    axis_hit_rate: axisHitRate,
    other_axes_fire_rate: othersFireRate,
    per_axis: perAxis,
  },
  results,
};
writeFileSync(outPath, JSON.stringify(summary, null, 2));
console.log(`\nReport written to ${outPath}`);
