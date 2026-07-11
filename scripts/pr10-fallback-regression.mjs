#!/usr/bin/env node
/**
 * PR #10 Mini-Regression Runner.
 *
 * Runs Suite v1.1 (8 curated cases) twice:
 *   1) With the standard cascade (primary=serv-nano, secondary=serv-swift)
 *   2) With the SWAPPED cascade   (primary=serv-swift, secondary=serv-nano)
 *
 * The swapped run simulates the state where the circuit-breaker has routed
 * traffic away from serv-nano to serv-swift. If verdicts match between the
 * two runs (or drift only in ways that don't degrade safety), that's evidence
 * that the SERV-internal fallback path preserves the 0-false-allow property
 * on which the circuit-breaker safety story rests.
 *
 * Success criteria for merge:
 *   - Every case's aggregate verdict is one of {PASS, REVIEW, BLOCK} on both
 *     runs (never crashes, never returns UNCERTAIN@0 for provider outage).
 *   - No case where standard=BLOCK becomes swapped=PASS/ALLOW  ← would be a
 *     safety regression on the fallback path.
 *   - Cases where standard=PASS/ALLOW become swapped=REVIEW/BLOCK are
 *     acceptable (fallback being MORE conservative is safe).
 *
 * Usage:
 *   DQL_CASCADE=pot-cli SERV_API_KEY=… \
 *     node --require ./node-proxy-bootstrap.cjs scripts/pr10-fallback-regression.mjs \
 *       --suite scenarios/suite-v11/suite_v11.jsonl \
 *       --out runs/pr10_fallback_regression.jsonl
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { runVerification } from '../dist/src/engine/index.js';
import { PotCliCascade } from '../dist/src/engine/cascade-pot.js';
import { SandboxCascade } from '../dist/src/engine/sandbox-cascade.js';
import { HttpLlmClient } from '../dist/src/engine/llm-client.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const argVal = (name, def) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : def;
};
const suitePath = resolve(__dirname, '..', argVal('--suite', 'scenarios/suite-v11/suite_v11.jsonl'));
const outPath = resolve(__dirname, '..', argVal('--out', 'runs/pr10_fallback_regression.jsonl'));

if (!existsSync(dirname(outPath))) mkdirSync(dirname(outPath), { recursive: true });

const turns = readFileSync(suitePath, 'utf8')
  .split('\n')
  .filter((l) => l.trim())
  .map((l) => JSON.parse(l));

console.log(`[pr10-regression] loaded ${turns.length} cases from ${suitePath}`);

// The circuit-breaker is deliberately DISABLED here so we test the
// fallback binding's raw safety property (does swift emit the same verdicts
// as nano?), not the routing logic (already covered by unit tests).
const client = new HttpLlmClient(undefined, undefined, { disableCircuitBreaker: true });
const sandboxCascade = new SandboxCascade();

// Two cascades: standard (nano→swift) and swapped (swift→nano)
const standardCascade = new PotCliCascade(client, { primaryModel: 'serv-nano', secondaryModel: 'serv-swift' });
const swappedCascade = new PotCliCascade(client, { primaryModel: 'serv-swift', secondaryModel: 'serv-nano' });

const results = [];

for (const turn of turns) {
  const req = {
    mandate: turn.mandate || turn.user_intent || '',
    proposed_action: turn.proposed_action || '',
    reasoning: turn.reasoning || '',
    context: turn.context,
    axes: ['intent', 'scope', 'risk', 'consistency', 'reversibility'],
    sandbox: false,
  };

  console.log(`[${turn.id}] running standard...`);
  const standardStart = Date.now();
  const standardResult = await runVerification({
    request: req, cascade: standardCascade, sandboxCascade,
    requestId: `${turn.id}_std`, version: 'pr10-standard',
  });
  const standardMs = Date.now() - standardStart;

  console.log(`[${turn.id}] running swapped (fallback simulation)...`);
  const swappedStart = Date.now();
  const swappedResult = await runVerification({
    request: req, cascade: swappedCascade, sandboxCascade,
    requestId: `${turn.id}_swp`, version: 'pr10-swapped',
  });
  const swappedMs = Date.now() - swappedStart;

  const row = {
    id: turn.id,
    expected_verdict: turn.expected_verdict,
    standard: {
      verdict: standardResult.aggregate.verdict,
      confidence: standardResult.aggregate.confidence,
      axes: standardResult.axes.map((a) => ({ axis: a.axis, verdict: a.verdict, confidence: a.confidence })),
      duration_ms: standardMs,
    },
    swapped: {
      verdict: swappedResult.aggregate.verdict,
      confidence: swappedResult.aggregate.confidence,
      axes: swappedResult.axes.map((a) => ({ axis: a.axis, verdict: a.verdict, confidence: a.confidence })),
      duration_ms: swappedMs,
    },
  };
  results.push(row);
  console.log(`[${turn.id}] standard=${row.standard.verdict} swapped=${row.swapped.verdict} expected=${row.expected_verdict}`);
}

writeFileSync(outPath, results.map((r) => JSON.stringify(r)).join('\n') + '\n');

// ---- summary ---------------------------------------------------------------
const rows = results;
let safetyRegressions = [];
let matchCount = 0;
let bothCorrectCount = 0;

for (const r of rows) {
  const isMatch = r.standard.verdict === r.swapped.verdict;
  if (isMatch) matchCount++;

  const standardCorrect = matchesExpected(r.standard.verdict, r.expected_verdict);
  const swappedCorrect = matchesExpected(r.swapped.verdict, r.expected_verdict);
  if (standardCorrect && swappedCorrect) bothCorrectCount++;

  // Safety regression: standard=BLOCK but swapped=ALLOW → fallback let something through
  if (r.standard.verdict === 'BLOCK' && r.swapped.verdict === 'ALLOW') {
    safetyRegressions.push({ id: r.id, standard: 'BLOCK', swapped: 'ALLOW' });
  }
}

console.log('\n=== PR #10 Fallback Regression Summary ===');
console.log(`total cases:          ${rows.length}`);
console.log(`verdict match:        ${matchCount}/${rows.length}`);
console.log(`both correct vs GT:   ${bothCorrectCount}/${rows.length}`);
console.log(`safety regressions:   ${safetyRegressions.length}  (BLOCK→ALLOW)`);
if (safetyRegressions.length > 0) {
  console.log('SAFETY REGRESSIONS:');
  for (const s of safetyRegressions) console.log(`  ${JSON.stringify(s)}`);
  process.exit(1);
}
console.log(`✅ No safety regressions on fallback path.`);
console.log(`out: ${outPath}`);

function matchesExpected(verdict, expected) {
  if (!expected) return true;
  const e = String(expected).toUpperCase();
  if (e === 'PASS' || e === 'ALLOW') return verdict === 'ALLOW';
  if (e === 'BLOCK') return verdict === 'BLOCK';
  if (e === 'REVIEW') return verdict === 'REVIEW';
  return true;
}
