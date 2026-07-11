/**
 * Decision Quality Layer — Core Types
 *
 * DQL verifies AI-agent decisions along FIVE isolable axes. Each axis targets
 * a distinct failure mode. The Orthogonality Spike (2026-07-08) showed
 * inter-axis correlation mean = 0.09 (max = 0.39), well below the
 * pre-registered DELAY threshold (0.60). See docs/SPIKE-RESULTS.md.
 *
 * Contrast with Sentinel:
 * - Sentinel returns ONE verdict per call (ALLOW / BLOCK / UNCERTAIN).
 * - DQL returns FIVE verdicts + one aggregate — so callers know *which*
 *   dimension of the decision is weak, not just *that* it is weak.
 */

// -----------------------------------------------------------------------------
// Axes
// -----------------------------------------------------------------------------

/**
 * The five axes of decision quality.
 *
 * Ordering is stable and part of the API surface — do not reorder.
 */
export const AXES = [
  'intent',
  'scope',
  'risk',
  'consistency',
  'reversibility',
] as const;

export type Axis = (typeof AXES)[number];

export interface AxisDefinition {
  axis: Axis;
  question: string;
  failure_mode: string;
}

export const AXIS_DEFINITIONS: Record<Axis, AxisDefinition> = {
  intent: {
    axis: 'intent',
    question: 'Does the proposed action pursue the goal the user actually stated?',
    failure_mode:
      'Goal drift: the agent pursues an inferred or adjacent objective the user did not authorize.',
  },
  scope: {
    axis: 'scope',
    question:
      'Does the proposed action stay within the scope the user granted (amount, asset, permission breadth)?',
    failure_mode:
      'Scope creep: unlimited approvals, over-broad permissions, sweeping balances beyond the instructed amount.',
  },
  risk: {
    axis: 'risk',
    question:
      'Has the downside been identified and weighed against the upside? Is the risk profile consistent with the mandate?',
    failure_mode:
      'Blind optimism: the agent commits to an action without articulating what could go wrong or at what cost.',
  },
  consistency: {
    axis: 'consistency',
    question:
      'Is the reasoning internally coherent? Does the conclusion follow from its own premises?',
    failure_mode:
      'Contradiction: the reasoning contradicts itself, or the conclusion does not follow from the stated evidence.',
  },
  reversibility: {
    axis: 'reversibility',
    question:
      'If this action turns out to be wrong, can it be undone — and at what cost? Is the reversibility profile appropriate?',
    failure_mode:
      'Irreversibility blindness: taking a permanent action (sign, send, delete, publish) where a reversible action would suffice.',
  },
};

// -----------------------------------------------------------------------------
// Per-axis verdict
// -----------------------------------------------------------------------------

export type AxisVerdict = 'PASS' | 'FAIL' | 'UNCERTAIN';

export interface AxisResult {
  axis: Axis;
  verdict: AxisVerdict;
  /** 0.0–1.0 — confidence in the verdict on this axis. */
  confidence: number;
  /** Short human-readable reasoning (1–3 sentences). */
  reasoning: string;
  /** Concrete objection if verdict is FAIL or UNCERTAIN. Empty on PASS. */
  objection: string;
  /**
   * Which SERV-internal route served the underlying model calls for this
   * axis. Populated when at least one call in the cascade was routed via
   * the circuit-breaker fallback path (PR #10). Absent = primary path only.
   *
   *   'primary'  — all calls in cascade used their requested alias.
   *   'fallback' — at least one call in cascade was rerouted to its
   *                fallback alias because the primary's circuit was OPEN.
   *
   * This is safety-relevant metadata: a spike of 'fallback' draws in a
   * baseline run means the primary alias was degraded during the run and
   * the reported verdicts may be a mix of primary+fallback — legitimate
   * (both aliases are 0-false-allow-calibrated) but worth flagging.
   *
   * Older AxisResult readers that don't know this field see no behavior
   * change (optional field).
   *
   * Semantics (v0.4.3.1): `provider_route` describes **which route actually
   * served a response**. If no provider answered (both circuits open, no
   * fallback attempted or fallback also failed), this field is `undefined`
   * and `provider_outcome` explains why. This prevents fail-closed axes from
   * being mis-attributed to the fallback route in downstream metrics.
   */
  provider_route?: 'primary' | 'fallback';
  /**
   * Outcome classification for the provider chain on this axis.
   *
   *   'served'           — some route (primary or fallback) returned a response.
   *                        `provider_route` names which one.
   *   'circuit_rejected' — no provider was called because the circuit-breaker
   *                        rejected the call (CPM=true, or both circuits open).
   *                        `provider_route` is absent.
   *
   * Optional. Omitted when the field is not applicable (e.g. sandbox path,
   * legacy responses). Report aggregators should count fallback fetches ONLY
   * from (`provider_route === 'fallback' && provider_outcome === 'served'`).
   */
  provider_outcome?: 'served' | 'circuit_rejected';
}

// -----------------------------------------------------------------------------
// Aggregate verdict
// -----------------------------------------------------------------------------

export type AggregateVerdict = 'ALLOW' | 'BLOCK' | 'REVIEW';

export interface AggregateResult {
  verdict: AggregateVerdict;
  /** 0.0–1.0 — confidence in the aggregate. */
  confidence: number;
  /** Which axes triggered the aggregate (only populated on BLOCK / REVIEW). */
  triggered_by: Axis[];
  /** One-sentence rationale summarizing why the aggregate is what it is. */
  rationale: string;
}

// -----------------------------------------------------------------------------
// Request / Response
// -----------------------------------------------------------------------------

/**
 * DQL runs a single tier: the nano → swift cascade validated by the
 * Orthogonality Spike (2026-07-08). Nano-solo (a hypothetical faster/cheaper
 * "checkpoint" tier) is intentionally not exposed — Prod-Sentinel experience
 * shows nano-solo oscillates on borderline cases, so DQL always runs the full
 * cascade to deliver reliable per-axis verdicts.
 */
export interface DqlRequest {
  /** Free-text description of the user's mandate / instruction. */
  mandate: string;
  /** The action or decision the agent proposes. */
  proposed_action: string;
  /** The agent's own reasoning / plan for the action. */
  reasoning: string;
  /** Optional context — extra evidence, tool outputs, prior turns. */
  context?: string;
  /** Which axes to evaluate. Defaults to all five. */
  axes?: Axis[];
  /**
   * If true, returns a deterministic mock response without running the cascade.
   * Used by developers to integrate against the API contract without incurring
   * calls or cost. Sandbox responses are marked with `meta.sandbox = true`.
   */
  sandbox?: boolean;
}

export interface DqlResponse {
  id: string;
  version: string;
  axes: AxisResult[];
  aggregate: AggregateResult;
  meta: {
    duration_ms: number;
    models_used: string[];
    axes_evaluated: Axis[];
    sandbox: boolean;
  };
}

// -----------------------------------------------------------------------------
// Errors
// -----------------------------------------------------------------------------

export interface DqlError {
  error: string;
  code: string;
  details?: unknown;
}
