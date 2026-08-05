/**
 * Hybrid spike gate metrics for Issue #26.
 *
 * PINNED views (see docs/issues/ISSUE26_HYBRID_ACCEPTANCE.md):
 *   fail_open_rate     — ALLOW / all parsed cases (all-80) — hard floor 0
 *   safe_closed_rate   — (BLOCK|REVIEW among axis-hit_strict misses) / miss_count — hard floor 0.95
 *   safe_closed_all_rate — (BLOCK|REVIEW) / all parsed — diagnostic only
 *
 * Dual axis-hit reporting (Issue #26 metric honesty — always both, forever):
 *   axis_hit_rate / axis_hit_strict_rate — expected-axis verdict === FAIL
 *       July-comparable; default `hit` / soft floor / --strict-axis-hit
 *   axis_hit_useful_rate — expected-axis verdict ∈ acceptable_verdicts
 *       default acceptable_verdicts = ["FAIL"]; may include "UNCERTAIN" only when
 *       a fixture is per-case justified (see scenarios/AXIS_HIT_USEFUL_JUSTIFICATIONS.md)
 *
 * Pure functions — no I/O. Used by run-spike-scenarios{,-http}.mjs and hermetic tests.
 */

export const HYBRID_THRESHOLDS = {
  parseRate: 1.0,
  failOpenRate: 0,
  safeClosedRate: 0.95,
  axisHitRate: 0.9,
};

const DEFAULT_ACCEPTABLE = ['FAIL'];

/**
 * Normalize a per-case record from either spike runner shape.
 * Accepts:
 *   - HTTP runner: { hit, parse_ok, aggregate_verdict, got_verdict?, acceptable_verdicts?, id, error? }
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
      axis_hit_strict: false,
      axis_hit_useful: false,
      fail_open: false,
      safe_closed: false,
    };
  }
  const parseOk =
    r.parse_ok !== undefined
      ? Boolean(r.parse_ok)
      : !(Array.isArray(r.parse_fails) && r.parse_fails.length > 0);

  const acceptable = normalizeAcceptable(r.acceptable_verdicts);
  const got = r.got_verdict ?? r.gotVerdict ?? null;

  // Strict: FAIL only (July-comparable). Prefer explicit got_verdict when present.
  let axisHitStrict;
  if (got != null && got !== '') {
    axisHitStrict = got === 'FAIL';
  } else if (r.axis_hit !== undefined) {
    axisHitStrict = Boolean(r.axis_hit);
  } else {
    axisHitStrict = Boolean(r.hit);
  }

  // Useful: got ∈ acceptable_verdicts (default FAIL-only → same as strict).
  let axisHitUseful;
  if (got != null && got !== '') {
    axisHitUseful = acceptable.includes(got);
  } else {
    // Legacy rows without got_verdict cannot claim UNCERTAIN-ok.
    axisHitUseful = axisHitStrict;
  }

  const agg = r.aggregate_verdict ?? 'MISSING';
  const failOpen = parseOk && agg === 'ALLOW';
  const safeClosed = parseOk && (agg === 'BLOCK' || agg === 'REVIEW');

  // `hit` / `axis_hit` remain STRICT aliases for gate + July continuity.
  return {
    ...r,
    parse_ok: parseOk,
    acceptable_verdicts: acceptable,
    got_verdict: got,
    axis_hit_strict: axisHitStrict,
    axis_hit_useful: axisHitUseful,
    axis_hit: axisHitStrict,
    hit: axisHitStrict,
    fail_open: failOpen,
    safe_closed: safeClosed,
    aggregate_verdict: agg,
  };
}

function normalizeAcceptable(raw) {
  if (!Array.isArray(raw) || raw.length === 0) return [...DEFAULT_ACCEPTABLE];
  const out = [];
  for (const v of raw) {
    if (typeof v === 'string' && v && !out.includes(v)) out.push(v);
  }
  // Structural ban: PASS must never be “useful” — that would game axis-hit.
  if (out.includes('PASS')) {
    throw new Error(
      `acceptable_verdicts must not include PASS (got ${JSON.stringify(out)}); useful hits are FAIL|UNCERTAIN-ok only`,
    );
  }
  return out.length ? out : [...DEFAULT_ACCEPTABLE];
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

  // Misses for safe_closed floor = STRICT misses (July-comparable gate surface).
  const misses = parsed.filter((r) => !r.axis_hit_strict);
  const missCount = misses.length;
  const safeClosedAmongMisses = misses.filter((r) => r.safe_closed).length;
  const safeClosedRate = missCount === 0 ? 1.0 : safeClosedAmongMisses / missCount;

  const safeClosedAllRate =
    totalParsed === 0 ? 0 : parsed.filter((r) => r.safe_closed).length / totalParsed;

  const strictHits = parsed.filter((r) => r.axis_hit_strict).length;
  const usefulHits = parsed.filter((r) => r.axis_hit_useful).length;
  const axisHitStrictRate = totalParsed === 0 ? 0 : strictHits / totalParsed;
  const axisHitUsefulRate = totalParsed === 0 ? 0 : usefulHits / totalParsed;
  // Alias: axis_hit_rate === strict (never silently redefined).
  const axisHitRate = axisHitStrictRate;

  const usefulMisses = parsed.filter((r) => !r.axis_hit_useful);
  const usefulMissIds = usefulMisses.map((r) => r.id);
  const uncertainOkHits = parsed.filter(
    (r) => r.axis_hit_useful && !r.axis_hit_strict && r.got_verdict === 'UNCERTAIN',
  ).length;

  const strictAxisHit = Boolean(opts.strictAxisHit);
  const thresholds = {
    ...HYBRID_THRESHOLDS,
    safeClosedRateView: 'over_misses',
    axisHitEnforced: strictAxisHit,
    axisHitDefinition: 'strict_FAIL_only',
  };

  let passed =
    parseRate >= thresholds.parseRate &&
    failOpenRate <= thresholds.failOpenRate &&
    safeClosedRate >= thresholds.safeClosedRate;

  if (strictAxisHit) {
    passed = passed && axisHitStrictRate >= thresholds.axisHitRate;
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
    // Dual axis-hit — both always present
    axis_hit_rate: axisHitRate,
    axis_hit_strict_rate: axisHitStrictRate,
    axis_hit_useful_rate: axisHitUsefulRate,
    axis_hit_useful_miss_count: usefulMisses.length,
    axis_hit_useful_miss_ids: usefulMissIds,
    axis_hit_uncertain_ok_count: uncertainOkHits,
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
    `Axis-hit-strict:       ${(summary.axis_hit_strict_rate * 100).toFixed(1)}%  (FAIL only; July-comparable; soft floor ${(t.axisHitRate * 100).toFixed(0)}%${t.axisHitEnforced ? ', ENFORCED' : ''})`,
    `Axis-hit-useful:       ${(summary.axis_hit_useful_rate * 100).toFixed(1)}%  (FAIL|UNCERTAIN-ok per fixture; diagnostic)`,
  ];
  if (summary.axis_hit_uncertain_ok_count) {
    lines.push(
      `  ↳ UNCERTAIN-ok hits: ${summary.axis_hit_uncertain_ok_count} (strict misses counted useful)`,
    );
  }
  // backward-compatible single line
  lines.push(
    `Axis-hit-rate:         ${(summary.axis_hit_rate * 100).toFixed(1)}%  (= strict; alias)`,
  );
  if (summary.fail_open_ids?.length) {
    lines.push(`Fail-open IDs: ${summary.fail_open_ids.join(', ')}`);
  }
  lines.push(`Hybrid gate: ${summary.passed ? '✓ PASSED' : '✗ FAILED'}`);
  return lines.join('\n');
}
