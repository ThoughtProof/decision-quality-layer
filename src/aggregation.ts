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
 *   1. ANY axis FAIL with confidence ≥ 0.7                  → BLOCK
 *   2. ANY axis that could not be evaluated because of a
 *      provider/auth/circuit failure (structured
 *      provider_outcome ∈ {provider_error, circuit_rejected}) → REVIEW
 *   3. TWO OR MORE axes UNCERTAIN                            → REVIEW
 *   4. ANY axis FAIL with confidence 0.5-0.7                 → REVIEW
 *   5. ANY axis UNCERTAIN with confidence ≥ 0.7             → REVIEW
 *   6. Otherwise                                            → ALLOW
 *
 * VERTRAGSÄNDERUNG (v0.4.3.1 §D6-fix, 2026-07-13): Rule 2 is NEW. Previously a
 * SINGLE axis that failed to evaluate due to a provider/auth error surfaced as
 * UNCERTAIN@confidence=0 with no matching rule and fell through to ALLOW with a
 * false "All evaluated axes pass." rationale (D6 fail-open). Rule 2 closes that
 * gap using the STRUCTURED provenance the engine now attaches — NOT confidence,
 * NOT message parsing. It fires INDEPENDENT of confidence, so confidence=0 is
 * caught. Axes that were successfully SERVED (provider_outcome === 'served') are
 * explicitly excluded. Deliberate non-provider behavior is preserved: a single
 * low-confidence UNCERTAIN with NO provider provenance still falls through to
 * ALLOW exactly as before (Rules 3/5 unchanged, only renumbered).
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

  // Rule 2 (VERTRAGSÄNDERUNG §D6-fix): any axis that could not be evaluated
  // because of a provider/auth/circuit failure → REVIEW, INDEPENDENT of
  // confidence. Uses the engine's structured provider_outcome provenance;
  // 'served' is NOT a failure and is excluded. Sits directly below BLOCK so a
  // genuine high-confidence FAIL on another axis still wins (REVIEW-or-stricter).
  const providerFailed = axisResults.filter(
    (r) => r.provider_outcome === 'provider_error' || r.provider_outcome === 'circuit_rejected'
  );
  if (providerFailed.length > 0) {
    return build(
      'REVIEW',
      axisResults,
      providerFailed.map((r) => r.axis),
      `${namelist(providerFailed.map((r) => r.axis))} could not be evaluated — provider/auth failure. Fail-closed: human review required (not ALLOW).`
    );
  }

  // Rule 3: ≥2 UNCERTAIN → REVIEW
  if (anyUncertain.length >= 2) {
    return build(
      'REVIEW',
      axisResults,
      anyUncertain.map((r) => r.axis),
      `Multiple axes uncertain (${namelist(anyUncertain.map((r) => r.axis))}). Human review recommended.`
    );
  }

  // Rule 4: mid-confidence FAIL → REVIEW
  if (midConfFails.length > 0) {
    return build(
      'REVIEW',
      axisResults,
      midConfFails.map((r) => r.axis),
      `Weak fail on ${namelist(midConfFails.map((r) => r.axis))}. Human review recommended.`
    );
  }

  // Rule 5: high-confidence UNCERTAIN → REVIEW
  if (highConfUncertain.length > 0) {
    return build(
      'REVIEW',
      axisResults,
      highConfUncertain.map((r) => r.axis),
      `${namelist(highConfUncertain.map((r) => r.axis))} uncertain with high confidence. Human review recommended.`
    );
  }

  // Rule 6 (otherwise): ALLOW
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
