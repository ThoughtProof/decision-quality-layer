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

export type DqlTier = 'checkpoint' | 'standard';

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
  /** Verification tier — checkpoint is faster/cheaper, standard is stronger. */
  tier?: DqlTier;
}

export interface DqlResponse {
  id: string;
  version: string;
  tier: DqlTier;
  axes: AxisResult[];
  aggregate: AggregateResult;
  meta: {
    duration_ms: number;
    models_used: string[];
    axes_evaluated: Axis[];
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
