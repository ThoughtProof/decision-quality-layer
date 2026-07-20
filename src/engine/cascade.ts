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
import type { AxisResult, Axis } from '../types.js';
import type { CallContext } from './call-context.js';

export interface CascadeInput {
  axis: Axis;
  prompt: AxisPrompt;
  /**
   * v0.4.3.1 §C.1: optional per-call context propagated from the handler.
   * When populated, `ctx.requestId` is the handler-owned canonical id and
   * MUST match `DqlResponse.id`. `ctx.axis` mirrors this input's `axis`
   * (redundant but useful for logging). `ctx.callId` identifies this
   * specific parallel call within the request.
   *
   * Cascades that do not need it (StubCascade, SandboxCascade) may ignore.
   */
  ctx?: CallContext;
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

  // Missing/non-numeric confidence used to become 0, which made both-PASS
// merges show PASS@0% in the UI (Math.min with a real conf). Treat absence
// as a mid default by verdict; explicit 0 stays 0 (model said "no conf").
const hasConf =
    typeof parsed.confidence === 'number' && Number.isFinite(parsed.confidence);
  let confidence = hasConf ? clamp01(parsed.confidence as number) : defaultConfidence(verdict);
  // Degenerate: PASS/FAIL with exact 0 is almost always a model omit-as-zero.
  // Floor to the same mid default so receipt never shows "PASS · 0%".
  if ((verdict === 'PASS' || verdict === 'FAIL') && confidence === 0) {
    confidence = defaultConfidence(verdict);
  }

  const reasoning =
    typeof parsed.reasoning === 'string' ? parsed.reasoning.trim() : '(no reasoning provided)';

  const objection = typeof parsed.objection === 'string' ? parsed.objection.trim() : '';

  return { axis, verdict, confidence, reasoning, objection };
}

/** Mid defaults when the model omits confidence. UNCERTAIN stays low. */
function defaultConfidence(verdict: 'PASS' | 'FAIL' | 'UNCERTAIN'): number {
  if (verdict === 'PASS') return 0.7;
  if (verdict === 'FAIL') return 0.7;
  return 0.4;
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
