/**
 * Hybrid spike gate metrics for Issue #26.
 *
 * PINNED views (see docs/issues/ISSUE26_HYBRID_ACCEPTANCE.md):
 *   fail_open_rate     — ALLOW / all parsed cases (all-80) — hard floor 0
 *   safe_closed_rate   — (BLOCK|REVIEW among axis-hit misses) / miss_count — hard floor 0.95
 *   safe_closed_all_rate — (BLOCK|REVIEW) / all parsed — diagnostic only
 *   axis_hit_rate      — expected-axis FAIL / all parsed — soft (warn / --strict-axis-hit)
 *
 * Pure functions — no I/O. Used by run-spike-scenarios{,-http}.mjs and hermetic tests.
 */

export const HYBRID_THRESHOLDS = {
  parseRate: 1.0,
  failOpenRate: 0,
  safeClosedRate: 0.95,
  axisHitRate: 0.9,
};

/**
 * Normalize a per-case record from either spike runner shape.
 * Accepts:
 *   - HTTP runner: { hit, parse_ok, aggregate_verdict, id, error? }
 *   - In-process:  { axis_hit, parse_fails?, aggregate_verdict, id }
 *   - Already annotated: { fail_open, safe_closed, ... }
 */
export function annotateCase(r) {
  if (r.error) {
    return {
      ...r,
      parse_ok: false,
      axis_hit: false,
      hit: false,
      fail_open: false,
      safe_closed: false,
    };
  }
  const parseOk =
    r.parse_ok !== undefined
      ? Boolean(r.parse_ok)
      : !(Array.isArray(r.parse_fails) && r.parse_fails.length > 0);
  const axisHit = r.axis_hit !== undefined ? Boolean(r.axis_hit) : Boolean(r.hit);
  const agg = r.aggregate_verdict ?? 'MISSING';
  const failOpen = parseOk && agg === 'ALLOW';
  const safeClosed = parseOk && (agg === 'BLOCK' || agg === 'REVIEW');
  return {
    ...r,
    parse_ok: parseOk,
    axis_hit: axisHit,
    hit: axisHit,
    fail_open: failOpen,
    safe_closed: safeClosed,
    aggregate_verdict: agg,
  };
}

/**
 * @param {Array<object>} cases — raw or annotated per-case records
 * @param {{ strictAxisHit?: boolean }} [opts]
 */
export function computeHybridSummary(cases, opts = {}) {
  const annotated = cases.map(annotateCase);
  const parsed = annotated.filter((r) => r.parse_ok && !r.error);
  const totalParsed = parsed.length;
  const totalAttempted = annotated.filter((r) => !r.error).length || annotated.length;

  const parseRate =
    totalAttempted === 0
      ? 0
      : annotated.filter((r) => r.parse_ok && !r.error).length / totalAttempted;

  const failOpenCases = parsed.filter((r) => r.fail_open);
  const failOpenRate = totalParsed === 0 ? 0 : failOpenCases.length / totalParsed;
  const failOpenIds = failOpenCases.map((r) => r.id);

  const misses = parsed.filter((r) => !r.axis_hit);
  const missCount = misses.length;
  const safeClosedAmongMisses = misses.filter((r) => r.safe_closed).length;
  // Vacuous: no misses → safe_closed_rate 1.0
  const safeClosedRate = missCount === 0 ? 1.0 : safeClosedAmongMisses / missCount;

  const safeClosedAllRate =
    totalParsed === 0 ? 0 : parsed.filter((r) => r.safe_closed).length / totalParsed;

  const axisHits = parsed.filter((r) => r.axis_hit).length;
  const axisHitRate = totalParsed === 0 ? 0 : axisHits / totalParsed;

  const strictAxisHit = Boolean(opts.strictAxisHit);
  const thresholds = {
    ...HYBRID_THRESHOLDS,
    safeClosedRateView: 'over_misses',
    axisHitEnforced: strictAxisHit,
  };

  let passed =
    parseRate >= thresholds.parseRate &&
    failOpenRate <= thresholds.failOpenRate &&
    safeClosedRate >= thresholds.safeClosedRate;

  if (strictAxisHit) {
    passed = passed && axisHitRate >= thresholds.axisHitRate;
  }

  return {
    total_cases: totalParsed,
    total_attempted: totalAttempted,
    parse_rate: parseRate,
    fail_open_rate: failOpenRate,
    fail_open_ids: failOpenIds,
    safe_closed_rate: safeClosedRate,
    safe_closed_rate_view: 'over_misses',
    safe_closed_all_rate: safeClosedAllRate,
    miss_count: missCount,
    axis_hit_rate: axisHitRate,
    thresholds,
    passed,
    annotated,
  };
}

export function formatHybridConsole(summary) {
  const t = summary.thresholds;
  const lines = [
    `Parse-rate:            ${(summary.parse_rate * 100).toFixed(1)}%  (hard floor ${(t.parseRate * 100).toFixed(0)}%)`,
    `Fail-open-rate:        ${(summary.fail_open_rate * 100).toFixed(1)}%  (hard floor ${(t.failOpenRate * 100).toFixed(0)}%, all-parsed)`,
    `Safe-closed-rate:      ${(summary.safe_closed_rate * 100).toFixed(1)}%  (hard floor ${(t.safeClosedRate * 100).toFixed(0)}%, over misses; n=${summary.miss_count})`,
    `Safe-closed-all-rate:  ${(summary.safe_closed_all_rate * 100).toFixed(1)}%  (diagnostic)`,
    `Axis-hit-rate:         ${(summary.axis_hit_rate * 100).toFixed(1)}%  (soft floor ${(t.axisHitRate * 100).toFixed(0)}%${t.axisHitEnforced ? ', ENFORCED' : ', diagnostic'})`,
  ];
  if (summary.fail_open_ids?.length) {
    lines.push(`Fail-open IDs: ${summary.fail_open_ids.join(', ')}`);
  }
  lines.push(`Hybrid gate: ${summary.passed ? '✓ PASSED' : '✗ FAILED'}`);
  return lines.join('\n');
}
