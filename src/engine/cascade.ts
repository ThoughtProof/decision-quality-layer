/**
 * Cascade adapter — routes an axis prompt through the model stack.
 *
 * Validated by the Orthogonality Spike (2026-07-08):
 *   - Cascade path: serv-nano → serv-swift
 *   - Standard tier: 100% parse-rate, 95% axis-hit-rate over 40 hand-crafted
 *     cases (see docs/SPIKE-RESULTS.md).
 *
 * This wrapper isolates the model-call interface so we can swap the underlying
 * cascade (pot-cli, HF endpoints, local models) without touching axis logic.
 */

import type { AxisPrompt } from './axes/types.js';
import type { AxisResult, Axis, DqlTier } from '../types.js';

export interface CascadeInput {
  axis: Axis;
  prompt: AxisPrompt;
  tier: DqlTier;
}

export interface CascadeOutput {
  result: AxisResult;
  modelsUsed: string[];
}

export interface Cascade {
  run(input: CascadeInput): Promise<CascadeOutput>;
}

/**
 * Placeholder cascade for local development and tests.
 *
 * Always returns UNCERTAIN with a note. Replace with a real cascade adapter
 * (pot-cli, HF endpoint, or provider SDK) before deploying.
 */
export class StubCascade implements Cascade {
  async run(input: CascadeInput): Promise<CascadeOutput> {
    return {
      result: {
        axis: input.axis,
        verdict: 'UNCERTAIN',
        confidence: 0,
        reasoning: 'StubCascade — replace with a real cascade adapter before deploying.',
        objection: '',
      },
      modelsUsed: ['stub'],
    };
  }
}

// -----------------------------------------------------------------------------
// Parsing helpers — shared across real cascade implementations.
// -----------------------------------------------------------------------------

/**
 * Parse a model response that is expected to contain a single JSON object
 * matching { verdict, confidence, reasoning, objection }.
 *
 * The parser is deliberately permissive:
 *   - Accepts fenced code blocks (```json ... ```).
 *   - Accepts leading/trailing prose.
 *   - Clamps confidence into [0, 1].
 *   - Uppercases verdict, defaults to UNCERTAIN.
 */
export function parseAxisResponse(axis: Axis, raw: string): AxisResult {
  const jsonText = extractJson(raw);

  let parsed: {
    verdict?: unknown;
    confidence?: unknown;
    reasoning?: unknown;
    objection?: unknown;
  } = {};

  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return {
      axis,
      verdict: 'UNCERTAIN',
      confidence: 0,
      reasoning: `Could not parse model output as JSON. Raw output preserved in objection.`,
      objection: raw.slice(0, 500),
    };
  }

  const verdictRaw = typeof parsed.verdict === 'string' ? parsed.verdict.toUpperCase() : '';
  const verdict =
    verdictRaw === 'PASS' || verdictRaw === 'FAIL' || verdictRaw === 'UNCERTAIN'
      ? verdictRaw
      : 'UNCERTAIN';

  const confidence =
    typeof parsed.confidence === 'number' && Number.isFinite(parsed.confidence)
      ? clamp01(parsed.confidence)
      : 0;

  const reasoning =
    typeof parsed.reasoning === 'string' ? parsed.reasoning.trim() : '(no reasoning provided)';

  const objection = typeof parsed.objection === 'string' ? parsed.objection.trim() : '';

  return { axis, verdict, confidence, reasoning, objection };
}

function extractJson(raw: string): string {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenced && fenced[1]) return fenced[1].trim();

  const firstBrace = raw.indexOf('{');
  const lastBrace = raw.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    return raw.slice(firstBrace, lastBrace + 1);
  }

  return raw.trim();
}

function clamp01(n: number): number {
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}
