/** Ambient types for the hermetic hybrid-gate helpers (Issue #26). */
export const HYBRID_THRESHOLDS: {
  parseRate: number;
  failOpenRate: number;
  safeClosedRate: number;
  axisHitRate: number;
};

export function annotateCase(r: Record<string, unknown>): Record<string, unknown> & {
  parse_ok: boolean;
  axis_hit: boolean;
  hit: boolean;
  fail_open: boolean;
  safe_closed: boolean;
  aggregate_verdict?: string;
  id?: string;
};

export function computeHybridSummary(
  cases: Array<Record<string, unknown>>,
  opts?: { strictAxisHit?: boolean },
): {
  total_cases: number;
  total_attempted: number;
  parse_rate: number;
  fail_open_rate: number;
  fail_open_ids: string[];
  safe_closed_rate: number;
  safe_closed_rate_view: 'over_misses';
  safe_closed_all_rate: number;
  miss_count: number;
  axis_hit_rate: number;
  thresholds: Record<string, unknown>;
  passed: boolean;
  annotated: Array<Record<string, unknown>>;
};

export function formatHybridConsole(summary: {
  parse_rate: number;
  fail_open_rate: number;
  safe_closed_rate: number;
  safe_closed_all_rate: number;
  axis_hit_rate: number;
  miss_count: number;
  fail_open_ids?: string[];
  passed: boolean;
  thresholds: {
    parseRate: number;
    failOpenRate: number;
    safeClosedRate: number;
    axisHitRate: number;
    axisHitEnforced?: boolean;
  };
}): string;
