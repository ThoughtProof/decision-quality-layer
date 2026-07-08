/**
 * DQL Engine — orchestrates 5-axis verification.
 *
 * Given a validated request, this module:
 *   1. Builds a prompt per requested axis.
 *   2. Runs each axis through the cascade IN PARALLEL.
 *   3. Aggregates the per-axis verdicts into a single aggregate verdict.
 *
 * The engine is deliberately model-agnostic. Swap the Cascade implementation
 * to change how axes are executed (real models, stubs, tests).
 */

import type { DqlRequest, DqlResponse, AxisResult, DqlTier, Axis } from '../types.js';
import { AXIS_PROMPT_BUILDERS } from './axes/index.js';
import { aggregate } from '../aggregation.js';
import type { Cascade } from './cascade.js';

export interface EngineInput {
  request: Required<Omit<DqlRequest, 'context'>> & Pick<DqlRequest, 'context'>;
  tier: DqlTier;
  cascade: Cascade;
  requestId: string;
  version: string;
}

export async function runVerification(input: EngineInput): Promise<DqlResponse> {
  const started = Date.now();
  const axes = input.request.axes;

  const promptInput = {
    mandate: input.request.mandate,
    proposed_action: input.request.proposed_action,
    reasoning: input.request.reasoning,
    context: input.request.context,
  };

  // Run all axes in parallel. Any axis error is caught and mapped to an
  // UNCERTAIN result so a single-axis failure does not fail the whole request.
  const perAxis = await Promise.all(
    axes.map(async (axis) => {
      const prompt = AXIS_PROMPT_BUILDERS[axis](promptInput);
      try {
        return await input.cascade.run({ axis, prompt, tier: input.tier });
      } catch (err) {
        const result: AxisResult = {
          axis,
          verdict: 'UNCERTAIN',
          confidence: 0,
          reasoning: `Axis evaluation failed with an error — treated as UNCERTAIN.`,
          objection: err instanceof Error ? err.message.slice(0, 500) : String(err).slice(0, 500),
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
    tier: input.tier,
    axes: axisResults,
    aggregate: aggregateResult,
    meta: {
      duration_ms: Date.now() - started,
      models_used: modelsUsed,
      axes_evaluated: axes as Axis[],
    },
  };
}

function uniqueStrings(xs: string[]): string[] {
  return Array.from(new Set(xs));
}
