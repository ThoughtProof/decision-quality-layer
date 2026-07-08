/**
 * Aggregation: 5 axis verdicts → 1 aggregate verdict.
 *
 * Design principle: We want the aggregate to be MEANINGFUL, not just a majority
 * vote. The Orthogonality Spike showed axes are largely independent — so a
 * FAIL on ONE axis is real information, not noise averaged out by four PASSes.
 *
 * Aggregation rules (v0.1 — subject to calibration once we have production
 * data; see docs/AGGREGATION.md):
 *
 *   1. ANY axis FAIL with confidence ≥ 0.7        → BLOCK
 *   2. TWO OR MORE axes UNCERTAIN                 → REVIEW
 *   3. ANY axis FAIL with confidence 0.5-0.7      → REVIEW
 *   4. ANY axis UNCERTAIN with confidence ≥ 0.7   → REVIEW
 *   5. Otherwise                                  → ALLOW
 *
 * Callers can override — the raw per-axis results are always returned.
 */

import type { AxisResult, AggregateResult, AggregateVerdict, Axis } from './types.js';

const HIGH_CONF_FAIL = 0.7;
const MID_CONF_FAIL = 0.5;
const HIGH_CONF_UNCERTAIN = 0.7;

export function aggregate(axisResults: AxisResult[]): AggregateResult {
  if (axisResults.length === 0) {
    return {
      verdict: 'REVIEW',
      confidence: 0,
      triggered_by: [],
      rationale: 'No axes evaluated — cannot form an aggregate verdict.',
    };
  }

  const highConfFails = axisResults.filter(
    (r) => r.verdict === 'FAIL' && r.confidence >= HIGH_CONF_FAIL
  );
  const midConfFails = axisResults.filter(
    (r) => r.verdict === 'FAIL' && r.confidence >= MID_CONF_FAIL && r.confidence < HIGH_CONF_FAIL
  );
  const highConfUncertain = axisResults.filter(
    (r) => r.verdict === 'UNCERTAIN' && r.confidence >= HIGH_CONF_UNCERTAIN
  );
  const anyUncertain = axisResults.filter((r) => r.verdict === 'UNCERTAIN');

  // Rule 1: any high-confidence FAIL → BLOCK
  if (highConfFails.length > 0) {
    return build(
      'BLOCK',
      axisResults,
      highConfFails.map((r) => r.axis),
      `Blocked on ${namelist(highConfFails.map((r) => r.axis))}. High-confidence axis failure(s).`
    );
  }

  // Rule 2: ≥2 UNCERTAIN → REVIEW
  if (anyUncertain.length >= 2) {
    return build(
      'REVIEW',
      axisResults,
      anyUncertain.map((r) => r.axis),
      `Multiple axes uncertain (${namelist(anyUncertain.map((r) => r.axis))}). Human review recommended.`
    );
  }

  // Rule 3: mid-confidence FAIL → REVIEW
  if (midConfFails.length > 0) {
    return build(
      'REVIEW',
      axisResults,
      midConfFails.map((r) => r.axis),
      `Weak fail on ${namelist(midConfFails.map((r) => r.axis))}. Human review recommended.`
    );
  }

  // Rule 4: high-confidence UNCERTAIN → REVIEW
  if (highConfUncertain.length > 0) {
    return build(
      'REVIEW',
      axisResults,
      highConfUncertain.map((r) => r.axis),
      `${namelist(highConfUncertain.map((r) => r.axis))} uncertain with high confidence. Human review recommended.`
    );
  }

  // Otherwise: ALLOW
  return build('ALLOW', axisResults, [], 'All evaluated axes pass.');
}

function build(
  verdict: AggregateVerdict,
  axisResults: AxisResult[],
  triggered_by: Axis[],
  rationale: string
): AggregateResult {
  return {
    verdict,
    confidence: aggregateConfidence(verdict, axisResults),
    triggered_by,
    rationale,
  };
}

/**
 * Aggregate confidence:
 * - ALLOW: min confidence across axes (we're only as confident as our weakest PASS)
 * - BLOCK / REVIEW: max confidence of the triggering axes
 */
function aggregateConfidence(verdict: AggregateVerdict, axisResults: AxisResult[]): number {
  if (verdict === 'ALLOW') {
    return round(Math.min(...axisResults.map((r) => r.confidence)));
  }
  const relevant = axisResults.filter((r) => r.verdict !== 'PASS');
  if (relevant.length === 0) return 0;
  return round(Math.max(...relevant.map((r) => r.confidence)));
}

function namelist(axes: Axis[]): string {
  return axes.join(', ');
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}
