/**
 * DQL Engine — orchestrates 5-axis verification.
 *
 * Given a validated request, this module:
 *   1. Builds a prompt per requested axis.
 *   2. Runs each axis through the cascade IN PARALLEL.
 *   3. Aggregates the per-axis verdicts into a single aggregate verdict.
 *
 * The engine is deliberately model-agnostic. Two cascades are provided
 * (Stub for local dev, Sandbox for developer integration testing); the
 * production cascade is wired in Phase 1.
 */

import type { DqlRequest, DqlResponse, AxisResult, Axis } from '../types.js';
import { AXIS_PROMPT_BUILDERS } from './axes/index.js';
import { aggregate } from '../aggregation.js';
import type { Cascade } from './cascade.js';
import { CircuitAllOpenError, ProviderCallError } from './llm-client.js';
import { generateCallId, type CallContext } from './call-context.js';
import type { RuntimeDiagnosticsCollector } from './runtime-diagnostics.js';

export interface EngineInput {
  request: Required<Omit<DqlRequest, 'context'>> & Pick<DqlRequest, 'context'>;
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
}

export async function runVerification(input: EngineInput): Promise<DqlResponse> {
  const started = Date.now();
  const axes = input.request.axes;
  const cascade = input.request.sandbox ? input.sandboxCascade : input.cascade;

  const promptInput = {
    mandate: input.request.mandate,
    proposed_action: input.request.proposed_action,
    reasoning: input.request.reasoning,
    context: input.request.context,
  };

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

  return {
    id: input.requestId,
    version: input.version,
    axes: axisResults,
    aggregate: aggregateResult,
    meta: {
      duration_ms: Date.now() - started,
      models_used: modelsUsed,
      axes_evaluated: axes as Axis[],
      sandbox: input.request.sandbox,
    },
  };
}

function uniqueStrings(xs: string[]): string[] {
  return Array.from(new Set(xs));
}
