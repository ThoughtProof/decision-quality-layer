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
import { CircuitAllOpenError } from './llm-client.js';

export interface EngineInput {
  request: Required<Omit<DqlRequest, 'context'>> & Pick<DqlRequest, 'context'>;
  /** The cascade to run when `request.sandbox` is false. */
  cascade: Cascade;
  /** The cascade to run when `request.sandbox` is true. */
  sandboxCascade: Cascade;
  requestId: string;
  version: string;
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
  // PR #10 fail-closed contract:
  // A CircuitAllOpenError from the llm-client means BOTH SERV aliases are
  // OPEN — typically an openserv.ai host-level outage. We deliberately do
  // NOT retry with an uncalibrated foreign vendor here (Groq/OpenAI); for a
  // safety product, the correct default under provider outage is to escalate
  // to a human, not to consult an unvetted model. The UNCERTAIN@0 result
  // below propagates that decision to the aggregator, which will emit a
  // REVIEW or worse — never ALLOW — because UNCERTAIN cannot upgrade to PASS.
  const perAxis = await Promise.all(
    axes.map(async (axis) => {
      const prompt = AXIS_PROMPT_BUILDERS[axis](promptInput);
      try {
        return await cascade.run({ axis, prompt });
      } catch (err) {
        const isCircuitAllOpen = err instanceof CircuitAllOpenError;
        const objection = isCircuitAllOpen
          ? `Provider outage — both SERV aliases (primary + fallback) circuit-open. Escalated to human per fail-closed policy. Detail: ${err.message.slice(0, 400)}`
          : err instanceof Error
            ? err.message.slice(0, 500)
            : String(err).slice(0, 500);
        const reasoning = isCircuitAllOpen
          ? `Axis evaluation could not be performed — SERV provider is unavailable on both primary and fallback aliases. Fail-closed: verdict is UNCERTAIN, escalate to human review.`
          : `Axis evaluation failed with an error — treated as UNCERTAIN.`;
        const result: AxisResult = {
          axis,
          verdict: 'UNCERTAIN',
          confidence: 0,
          reasoning,
          objection,
          // Fail-closed events must be attributable to a provider incident.
          // Tag as 'fallback' so post-hoc reports can filter these draws out
          // of "normal primary-served" statistics.
          ...(isCircuitAllOpen ? { provider_route: 'fallback' as const } : {}),
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
