/**
 * Structural shadow metrics (ADR-0020 step 2)
 *
 * Compares the deterministic pre-check (`structural.would_block`) against the
 * cascade scope axis (FAIL vs not) so we can decide when to flip gate_mode
 * clients to enforce.
 *
 * Design:
 *   • Pure comparison helper — no I/O
 *   • Process-local counters (honest about serverless: per-instance only)
 *   • Structured log line shape for Vercel log drains (N-day aggregation)
 *
 * Not a durable warehouse. Durable N-day rates come from log aggregation
 * (Vercel → drain → whatever). In-process counters are for live canary peek.
 */

import type { AxisResult, AggregateVerdict, StructuralField } from '../types.js';

export type StructuralScopeAgreement =
  | 'both_block' // would_block && scope FAIL
  | 'structural_only' // would_block && scope not FAIL (cascade softer / silent scope)
  | 'cascade_only' // !would_block && scope FAIL (pre-check silent/missed)
  | 'neither' // clean both sides
  | 'no_scope_axis' // cascade ran but scope not in axes_evaluated
  | 'enforced_short_circuit' // enforce path — cascade never ran
  | 'silent'; // no structured fields / pre-check silent

export interface StructuralShadowSample {
  request_id: string;
  ts: string;
  mode: 'shadow' | 'enforce';
  sandbox: boolean;
  silent: boolean;
  would_block: boolean;
  enforced: boolean;
  violation_kinds: string[];
  scope_verdict: 'PASS' | 'FAIL' | 'UNCERTAIN' | null;
  scope_confidence: number | null;
  aggregate_verdict: AggregateVerdict | null;
  agreement: StructuralScopeAgreement;
}

export interface StructuralMetricsSnapshot {
  /**
   * Process-local only. On Vercel each instance has its own counters;
   * use structured logs for durable N-day rates.
   */
  process_local: true;
  since: string;
  total: number;
  /** Samples with usable structured_context (not silent). */
  with_structure: number;
  would_block: number;
  enforced: number;
  scope_fail: number;
  agreement: Record<StructuralScopeAgreement, number>;
  violation_kinds: Record<string, number>;
}

const startedAt = new Date().toISOString();

const counters = {
  total: 0,
  with_structure: 0,
  would_block: 0,
  enforced: 0,
  scope_fail: 0,
  agreement: {
    both_block: 0,
    structural_only: 0,
    cascade_only: 0,
    neither: 0,
    no_scope_axis: 0,
    enforced_short_circuit: 0,
    silent: 0,
  } as Record<StructuralScopeAgreement, number>,
  violation_kinds: {} as Record<string, number>,
};

/**
 * Build one shadow sample from structural field + axis results.
 * Pure. Safe on missing scope axis / enforced short-circuit.
 */
export function buildStructuralShadowSample(args: {
  requestId: string;
  structural: StructuralField;
  axes: AxisResult[];
  aggregateVerdict: AggregateVerdict | null;
  sandbox: boolean;
}): StructuralShadowSample {
  const { structural } = args;
  const scope = args.axes.find((a) => a.axis === 'scope');
  const scopeVerdict = scope?.verdict ?? null;
  const scopeConf = scope?.confidence ?? null;

  let agreement: StructuralScopeAgreement;
  if (structural.silent) {
    agreement = 'silent';
  } else if (structural.enforced) {
    agreement = 'enforced_short_circuit';
  } else if (scopeVerdict === null) {
    agreement = 'no_scope_axis';
  } else if (structural.would_block && scopeVerdict === 'FAIL') {
    agreement = 'both_block';
  } else if (structural.would_block && scopeVerdict !== 'FAIL') {
    agreement = 'structural_only';
  } else if (!structural.would_block && scopeVerdict === 'FAIL') {
    agreement = 'cascade_only';
  } else {
    agreement = 'neither';
  }

  return {
    request_id: args.requestId,
    ts: new Date().toISOString(),
    mode: structural.mode,
    sandbox: args.sandbox,
    silent: structural.silent,
    would_block: structural.would_block,
    enforced: structural.enforced,
    violation_kinds: structural.violations.map((v) => v.kind),
    scope_verdict: scopeVerdict,
    scope_confidence: scopeConf,
    aggregate_verdict: args.aggregateVerdict,
    agreement,
  };
}

/** Record one sample into process-local counters. Never throws. */
export function recordStructuralSample(sample: StructuralShadowSample): void {
  try {
    counters.total += 1;
    if (!sample.silent) counters.with_structure += 1;
    if (sample.would_block) counters.would_block += 1;
    if (sample.enforced) counters.enforced += 1;
    if (sample.scope_verdict === 'FAIL') counters.scope_fail += 1;
    counters.agreement[sample.agreement] =
      (counters.agreement[sample.agreement] ?? 0) + 1;
    for (const k of sample.violation_kinds) {
      counters.violation_kinds[k] = (counters.violation_kinds[k] ?? 0) + 1;
    }
  } catch {
    // metrics must never affect the request path
  }
}

/**
 * Emit one JSON log line for drains. Prefix is stable for grep:
 *   `dql.structural_shadow`
 * Never throws.
 */
export function logStructuralShadowSample(sample: StructuralShadowSample): void {
  try {
    // eslint-disable-next-line no-console
    console.log(
      JSON.stringify({
        event: 'dql.structural_shadow',
        ...sample,
      }),
    );
  } catch {
    // ignore
  }
}

export function getStructuralMetricsSnapshot(): StructuralMetricsSnapshot {
  return {
    process_local: true,
    since: startedAt,
    total: counters.total,
    with_structure: counters.with_structure,
    would_block: counters.would_block,
    enforced: counters.enforced,
    scope_fail: counters.scope_fail,
    agreement: { ...counters.agreement },
    violation_kinds: { ...counters.violation_kinds },
  };
}

/** Test-only reset. */
export function _resetStructuralMetricsForTests(): void {
  counters.total = 0;
  counters.with_structure = 0;
  counters.would_block = 0;
  counters.enforced = 0;
  counters.scope_fail = 0;
  for (const k of Object.keys(counters.agreement) as StructuralScopeAgreement[]) {
    counters.agreement[k] = 0;
  }
  for (const k of Object.keys(counters.violation_kinds)) {
    delete counters.violation_kinds[k];
  }
}
