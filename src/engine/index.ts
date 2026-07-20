/**
 * DQL Engine — orchestrates 5-axis verification.
 *
 * Given a validated request, this module:
 *   0. Runs the deterministic structural pre-check (ADR-0020).
 *   1. Builds a prompt per requested axis (unless enforce short-circuits).
 *   2. Runs each axis through the cascade IN PARALLEL.
 *   3. Aggregates the per-axis verdicts into a single aggregate verdict.
 *
 * The engine is deliberately model-agnostic. Two cascades are provided
 * (Stub for local dev, Sandbox for developer integration testing); the
 * production cascade is wired in Phase 1.
 */

import type {
  DqlRequest,
  DqlResponse,
  AxisResult,
  Axis,
  AggregateResult,
} from '../types.js';
import { AXIS_PROMPT_BUILDERS } from './axes/index.js';
import { aggregate } from '../aggregation.js';
import type { Cascade } from './cascade.js';
import { CircuitAllOpenError, ProviderCallError } from './llm-client.js';
import { generateCallId, type CallContext } from './call-context.js';
import type { RuntimeDiagnosticsCollector } from './runtime-diagnostics.js';
import {
  runStructuralPrecheck,
  toStructuralField,
  type StructuralPrecheckResult,
} from './structural-precheck.js';
import {
  buildStructuralShadowSample,
  logStructuralShadowSample,
  recordStructuralSample,
} from './structural-metrics.js';

export interface EngineInput {
  request: Required<Omit<DqlRequest, 'context' | 'structured_context' | 'gate_mode'>> &
    Pick<DqlRequest, 'context' | 'structured_context' | 'gate_mode'>;
  /** The cascade to run when `request.sandbox` is false. */
  cascade: Cascade;
  /** The cascade to run when `request.sandbox` is true. */
  sandboxCascade: Cascade;
  requestId: string;
  version: string;
  /**
   * v0.4.3.1 §C+integration: optional request-scoped diagnostics collector.
   * When present, the engine attaches it to each per-axis CallContext so
   * the LLM client can push CB events and per-attempt attribution rows.
   * Never used for control flow — observation only.
   */
  collector?: RuntimeDiagnosticsCollector;
  /**
   * Whole-request deadline budget W (ms). When set (>0), runVerification
   * arms a shared AbortController and threads deadlineAt/requestSignal into
   * every axis CallContext.
   */
  requestDeadlineMs?: number;
  /** Per-provider-call budget PC (ms), threaded into CallContext. */
  providerCallBudgetMs?: number;
}

export async function runVerification(input: EngineInput): Promise<DqlResponse> {
  const started = Date.now();
  const axes = input.request.axes;
  const cascade = input.request.sandbox ? input.sandboxCascade : input.cascade;

  // 0. Deterministic structural pre-check (ADR-0020). Default shadow:
  //    compute + attach, never short-circuit. Enforce + violation → BLOCK
  //    without spending the cascade. Fail-toward-silence / add-only.
  const gateMode = input.request.gate_mode ?? 'shadow';
  const precheck = runStructuralPrecheck(input.request.structured_context, gateMode);
  const structuralField = toStructuralField(precheck);

  if (precheck.enforced) {
    const enforced = buildEnforcedBlockResponse({
      requestId: input.requestId,
      version: input.version,
      axes,
      sandbox: input.request.sandbox,
      precheck,
      structuralField,
      started,
    });
    emitStructuralMetrics({
      requestId: input.requestId,
      structural: structuralField,
      axes: enforced.axes,
      aggregateVerdict: enforced.aggregate.verdict,
      sandbox: input.request.sandbox,
    });
    return enforced;
  }

  const promptInput = {
    mandate: input.request.mandate,
    proposed_action: input.request.proposed_action,
    reasoning: input.request.reasoning,
    context: input.request.context,
  };

  // Whole-request deadline (W). Optional — absent keeps legacy behavior.
  let deadlineAt: number | undefined;
  let requestController: AbortController | undefined;
  let requestTimer: ReturnType<typeof setTimeout> | undefined;
  if (input.requestDeadlineMs && input.requestDeadlineMs > 0) {
    deadlineAt = Date.now() + input.requestDeadlineMs;
    requestController = new AbortController();
    requestTimer = setTimeout(() => requestController!.abort(), input.requestDeadlineMs);
  }

  try {
  // Run all axes in parallel. Any axis error is caught and mapped to an
  // UNCERTAIN result so a single-axis failure does not fail the whole request.
  //
  // PR #10 fail-closed contract (corrected v0.4.3.1 §D6-fix 2026-07-13):
  // A CircuitAllOpenError from the llm-client means BOTH SERV aliases are
  // OPEN — typically an openserv.ai host-level outage. A ProviderCallError
  // means a single provider interaction failed (HTTP 401/5xx or transport)
  // without tripping the breaker. We deliberately do NOT retry with an
  // uncalibrated foreign vendor here (Groq/OpenAI); for a safety product, the
  // correct default under provider failure is to escalate to a human, not to
  // consult an unvetted model. Both cases below set a structured
  // `provider_outcome` ('circuit_rejected' | 'provider_error') on the
  // UNCERTAIN@0 axis result; the aggregator (aggregation.ts Rule 2) escalates
  // ANY axis carrying such provenance to REVIEW-or-stricter — never ALLOW —
  // INDEPENDENT of confidence. (Before the §D6-fix a single UNCERTAIN@0 with
  // no provenance fell through to ALLOW; this comment previously overstated
  // the guarantee.)
  // v0.4.3.1 §C.1: build a child CallContext per axis from the handler-owned
  // requestId. The engine NEVER generates a requestId itself.
  const perAxis = await Promise.all(
    axes.map(async (axis) => {
      const prompt = AXIS_PROMPT_BUILDERS[axis](promptInput);
      const ctx: CallContext = {
        requestId: input.requestId,
        axis,
        callId: generateCallId(),
        collector: input.collector,
        ...(deadlineAt !== undefined ? { deadlineAt } : {}),
        ...(requestController ? { requestSignal: requestController.signal } : {}),
        ...(input.providerCallBudgetMs !== undefined
          ? { providerCallBudgetMs: input.providerCallBudgetMs }
          : {}),
      };
      try {
        return await cascade.run({ axis, prompt, ctx });
      } catch (err) {
        const isCircuitAllOpen = err instanceof CircuitAllOpenError;
        const isProviderError = err instanceof ProviderCallError;
        const objection = isCircuitAllOpen
          ? `Provider outage — both SERV aliases (primary + fallback) circuit-open. Escalated to human per fail-closed policy. Detail: ${err.message.slice(0, 400)}`
          : err instanceof Error
            ? err.message.slice(0, 500)
            : String(err).slice(0, 500);
        const reasoning = isCircuitAllOpen
          ? `Axis evaluation could not be performed — SERV provider is unavailable on both primary and fallback aliases. Fail-closed: verdict is UNCERTAIN, escalate to human review.`
          : isProviderError
            ? `Axis evaluation could not be performed — the SERV provider returned an error${err.httpStatus ? ` (HTTP ${err.httpStatus})` : ''}. Fail-closed: verdict is UNCERTAIN, escalate to human review.`
            : `Axis evaluation failed with an error — treated as UNCERTAIN.`;
        // v0.4.3.1 §C.3-fix (Hermes 2026-07-11) + §D6-fix (2026-07-13):
        // attribute the fail-closed provenance from the error's STRUCTURED
        // TYPE, never from Error.message string parsing.
        //   CircuitAllOpenError, attemptedRoutes.length === 0 → no provider
        //     fetch was made                     → 'circuit_rejected'
        //   CircuitAllOpenError, attemptedRoutes.length ≥ 1  → at least one
        //     provider fetch was made            → 'provider_error'
        //   ProviderCallError (single-axis HTTP/transport failure that did
        //     NOT trip the breaker, e.g. HTTP 401) → 'provider_error'
        //   Any OTHER error (local config: missing key, unknown alias, or an
        //     unexpected bug) → no provider_outcome; retains prior policy.
        let providerOutcome:
          | 'circuit_rejected'
          | 'provider_error'
          | undefined = undefined;
        if (isCircuitAllOpen) {
          providerOutcome =
            (err as CircuitAllOpenError).attemptedRoutes.length === 0
              ? 'circuit_rejected'
              : 'provider_error';
        } else if (isProviderError) {
          providerOutcome = 'provider_error';
        }
        const result: AxisResult = {
          axis,
          verdict: 'UNCERTAIN',
          confidence: 0,
          reasoning,
          objection,
          // `provider_route` remains absent on any fail-closed path: no
          // route ultimately SERVED a response, so no route may be named.
          ...(providerOutcome ? { provider_outcome: providerOutcome } : {}),
        };
        return { result, modelsUsed: [] };
      }
    })
  );

  const axisResults: AxisResult[] = perAxis.map((p) => p.result);
  const modelsUsed = uniqueStrings(perAxis.flatMap((p) => p.modelsUsed));
  const aggregateResult = aggregate(axisResults);

  emitStructuralMetrics({
    requestId: input.requestId,
    structural: structuralField,
    axes: axisResults,
    aggregateVerdict: aggregateResult.verdict,
    sandbox: input.request.sandbox,
  });

  return {
    id: input.requestId,
    version: input.version,
    axes: axisResults,
    aggregate: aggregateResult,
    structural: structuralField,
    meta: {
      duration_ms: Date.now() - started,
      models_used: modelsUsed,
      axes_evaluated: axes as Axis[],
      sandbox: input.request.sandbox,
    },
  };
  } finally {
    if (requestTimer !== undefined) clearTimeout(requestTimer);
  }
}

/** Shadow metrics: compare structural.would_block vs cascade scope FAIL. Never throws. */
function emitStructuralMetrics(args: {
  requestId: string;
  structural: ReturnType<typeof toStructuralField>;
  axes: AxisResult[];
  aggregateVerdict: AggregateResult['verdict'];
  sandbox: boolean;
}): void {
  try {
    const sample = buildStructuralShadowSample({
      requestId: args.requestId,
      structural: args.structural,
      axes: args.axes,
      aggregateVerdict: args.aggregateVerdict,
      sandbox: args.sandbox,
    });
    recordStructuralSample(sample);
    logStructuralShadowSample(sample);
  } catch {
    // metrics never affect the request path
  }
}

/**
 * Enforce-mode short-circuit: hard structural violation → BLOCK without
 * cascade spend. Synthetic axis results keep the response shape stable:
 * scope FAIL@1.0 carries the violation; other requested axes are marked
 * skipped as UNCERTAIN@0 (never fabricated PASS — receipt honesty).
 * No provider_outcome on skips so D6 provenance rules do not fire.
 * Aggregation Rule 1 (scope FAIL@1.0) still yields BLOCK first.
 */
function buildEnforcedBlockResponse(args: {
  requestId: string;
  version: string;
  axes: Axis[];
  sandbox: boolean;
  precheck: StructuralPrecheckResult;
  structuralField: ReturnType<typeof toStructuralField>;
  started: number;
}): DqlResponse {
  const detail = args.precheck.violations.map((v) => v.detail).join(' ');
  const kinds = args.precheck.violations.map((v) => v.kind).join(', ');

  const scopeFail = (): AxisResult => ({
    axis: 'scope',
    verdict: 'FAIL',
    confidence: 1,
    reasoning:
      `Deterministic structural pre-check (enforce): ${kinds}. ` +
      `Binary unfixable scope/identity violation — cascade skipped.`,
    objection: detail || `Structural pre-check blocked (${kinds}).`,
  });

  const skippedAxis = (axis: Axis): AxisResult => ({
    axis,
    verdict: 'UNCERTAIN',
    confidence: 0,
    reasoning: 'skipped — structural enforce short-circuit',
    objection: 'Axis not evaluated; structural pre-check already hard-blocked.',
    // intentionally no provider_outcome — not a provider failure (D6).
  });

  const axisResults: AxisResult[] = args.axes.map((axis) =>
    axis === 'scope' ? scopeFail() : skippedAxis(axis),
  );

  // If the caller omitted scope from axes[], force a synthetic scope FAIL
  // so content-broken BLOCK still fires and the audit trail names scope.
  const hasScope = axisResults.some((r) => r.axis === 'scope');
  if (!hasScope) {
    axisResults.unshift(scopeFail());
  }

  // Requested axes only (plus synthetic scope if omitted). Do not claim the
  // cascade "evaluated" skipped axes — meta lists what appears on the receipt,
  // with models_used: [] making the short-circuit explicit.
  let aggregateResult: AggregateResult = aggregate(axisResults);

  // Belt-and-suspenders: never ALLOW after enforced structural block.
  // (scope FAIL@1.0 should already BLOCK via Rule 1; UNCERTAIN@0 skips alone
  // would not reverse that.)
  if (aggregateResult.verdict !== 'BLOCK') {
    aggregateResult = {
      verdict: 'BLOCK',
      confidence: 1,
      triggered_by: ['scope'],
      rationale:
        `Blocked by deterministic structural pre-check (${kinds}). ` +
        (detail || 'Binary unfixable violation.'),
    };
  }

  return {
    id: args.requestId,
    version: args.version,
    axes: axisResults,
    aggregate: aggregateResult,
    structural: args.structuralField,
    meta: {
      duration_ms: Date.now() - args.started,
      models_used: [],
      axes_evaluated: axisResults.map((r) => r.axis),
      sandbox: args.sandbox,
    },
  };
}

function uniqueStrings(xs: string[]): string[] {
  return Array.from(new Set(xs));
}
