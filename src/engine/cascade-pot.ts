/**
 * DQL production cascade — Standard tier (nano → swift).
 *
 * This adapter implements the two-stage cascade validated by the
 * Orthogonality Spike (2026-07-08, 40 hand-crafted cases):
 *   • Standard tier: 100% parse-rate, 95% axis-hit-rate, mean pairwise
 *     axis correlation 0.09 (max 0.39) — orthogonality target met.
 *
 * Cascade semantics (mirrors pot-cli/cross-model-cascade.ts, ADR-0007
 * "Cross-Model Verification Principle"):
 *
 *   1. Primary (serv-nano) evaluates first.
 *   2. Primary verdict = FAIL     → EARLY-EXIT with FAIL (with confidence≥τ_fail).
 *   3. Primary verdict = UNCERTAIN → CASCADE to secondary (serv-swift).
 *   4. Primary verdict = PASS      → CASCADE to secondary.
 *   5. Secondary evaluates. Agreement → keep verdict.
 *   6. Disagreement (primary=PASS, secondary=FAIL) → downgrade to FAIL.
 *      Disagreement (primary=FAIL, secondary=PASS) → downgrade to UNCERTAIN
 *      (never silently promote FAIL → PASS). This mirrors Sentinel's
 *      HOLD-on-disagreement rule (docs/sentinel-verdict-nondeterminism-rca-
 *      2026-07-08.md).
 *
 * Design note — why not reuse pot-cli/cascade at runtime?
 *   pot-cli's `runCascade` is generic over an `EvaluatorResult` (=ItemResult)
 *   shape that carries step_evaluations, provenance_violations, conditions —
 *   fields designed for graded-support evaluation with trace evidence. DQL
 *   emits {PASS, FAIL, UNCERTAIN, confidence, reasoning, objection} per axis.
 *   Rebuilding this thin cascade lets us keep our verdict vocabulary and
 *   avoid synthesising dummy step_evaluations on every call. The ADR-0007
 *   invariant used here is disagreement→more-conservative. (The cross-vendor-
 *   family part of ADR-0007 does NOT apply: DQL runs serv-nano→serv-swift, two
 *   SERV models of different capability tiers on the same provider.) The
 *   early-exit and conservative-aggregation guards are ported wholesale — see below.
 */

import type { AxisPrompt } from './axes/types.js';
import type { AxisResult, Axis, AxisVerdict } from '../types.js';
import type { Cascade, CascadeInput, CascadeOutput } from './cascade.js';
import { parseAxisResponse } from './cascade.js';
import type { LlmClient } from './llm-client.js';
import { HttpLlmClient } from './llm-client.js';

export interface PotCliCascadeConfig {
  /** Primary model alias. Default: 'serv-nano'. */
  primaryModel?: string;
  /** Secondary model alias. Default: 'serv-swift'. */
  secondaryModel?: string;
  /**
   * If the primary emits FAIL with confidence ≥ this threshold, we early-exit
   * without calling the secondary. Below the threshold, we still cascade so
   * the secondary can either confirm or downgrade to UNCERTAIN. Default: 0.7
   * — chosen to align with the aggregation rule "FAIL≥0.7 → BLOCK".
   */
  earlyExitFailConfidence?: number;
  /**
   * confirmFail (2026-07-08, env-gated via DQL_CONFIRM_FAIL, default OFF):
   * mirrors Sentinel's confirmBlocks fix. When ON, a high-confidence primary
   * FAIL no longer early-exits — the secondary is called to confirm. If the
   * secondary agrees (FAIL/UNCERTAIN) the FAIL stands; if it disagrees (PASS)
   * combineVerdicts applies (disagreement → FAIL stays, but now it's a
   * two-model decision, not a single unstable serv-nano call). Default OFF
   * keeps the cheap early-exit. Rationale: today's Sentinel RCA showed
   * nano-solo verdicts can be unstable; confirming them removes that risk.
   */
  confirmFail?: boolean;
  /** Per-call maxTokens for the underlying LLM client. Default: 512. */
  maxTokens?: number;
}

const DEFAULT_CONFIG: Required<PotCliCascadeConfig> = {
  primaryModel: 'serv-nano',
  secondaryModel: 'serv-swift',
  earlyExitFailConfidence: 0.7,
  confirmFail: process.env.DQL_CONFIRM_FAIL === '1',
  maxTokens: 512,
};

export class PotCliCascade implements Cascade {
  private readonly config: Required<PotCliCascadeConfig>;

  constructor(
    private readonly client: LlmClient = new HttpLlmClient(),
    config: PotCliCascadeConfig = {}
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  async run(input: CascadeInput): Promise<CascadeOutput> {
    const { axis, prompt } = input;
    const modelsUsed: string[] = [];

    // ---- Primary --------------------------------------------------------
    const primary = await this.callAxis(this.config.primaryModel, axis, prompt);
    modelsUsed.push(primary.modelId);

    // Early-exit on high-confidence FAIL — conservative and cheap.
    // Skipped when confirmFail is ON: then even a high-confidence primary FAIL
    // is confirmed by the secondary (mirrors Sentinel confirmBlocks), so a
    // single unstable serv-nano call can't decide a FAIL alone.
    if (
      !this.config.confirmFail &&
      primary.result.verdict === 'FAIL' &&
      primary.result.confidence >= this.config.earlyExitFailConfidence
    ) {
      return {
        result: annotate(primary.result, `[cascade] early-exit on primary FAIL@${primary.result.confidence.toFixed(2)}`),
        modelsUsed,
      };
    }

    // ---- Secondary ------------------------------------------------------
    let secondary: AxisCall;
    try {
      secondary = await this.callAxis(this.config.secondaryModel, axis, prompt);
      modelsUsed.push(secondary.modelId);
    } catch (err) {
      // Degraded mode: secondary unavailable → be conservative.
      // Primary=PASS → downgrade to UNCERTAIN. Primary=FAIL → keep FAIL
      // (secondary can never rescue FAIL under our rules). Primary=UNCERTAIN
      // stays UNCERTAIN.
      const fallbackVerdict: AxisVerdict =
        primary.result.verdict === 'PASS' ? 'UNCERTAIN' : primary.result.verdict;
      const note = `[cascade] secondary error → degraded (${err instanceof Error ? err.message.slice(0, 200) : 'unknown'})`;
      return {
        result: annotate({ ...primary.result, verdict: fallbackVerdict }, note),
        modelsUsed,
      };
    }

    return {
      result: combineVerdicts(primary.result, secondary.result),
      modelsUsed,
    };
  }

  private async callAxis(modelAlias: string, axis: Axis, prompt: AxisPrompt): Promise<AxisCall> {
    const out = await this.client.call(modelAlias, {
      system: prompt.system,
      user: prompt.user,
      maxTokens: this.config.maxTokens,
    });
    const parsed = parseAxisResponse(axis, out.raw);
    // Attach provider_route from the llm-client output. When the client
    // doesn't provide it (e.g. Mock/Stub cascade in tests), leave undefined.
    if (out.providerRoute) {
      parsed.provider_route = out.providerRoute;
    }
    return {
      modelId: out.modelUsed,
      route: out.providerRoute,
      result: parsed,
    };
  }
}

interface AxisCall {
  modelId: string;
  route: 'primary' | 'fallback' | undefined;
  result: AxisResult;
}

/**
 * Combine primary + secondary verdicts under DQL's conservative rules.
 *
 * Rules (mirrors Sentinel HOLD-on-disagreement, adapted to PASS/FAIL/UNCERTAIN):
 *   • Both PASS       → PASS (confidence = min).
 *   • Both FAIL       → FAIL (confidence = max).
 *   • PASS ↔ FAIL     → FAIL (secondary as the more-cautious voice, but keep
 *                       primary's confidence floored, then take the max).
 *                       Rationale: a disagreement where one side sees a real
 *                       problem should not be dismissed. Symmetric FAIL wins.
 *   • X   ↔ UNCERTAIN → downgrade non-UNCERTAIN side to UNCERTAIN
 *                       (either signal is unreliable → the pair is unreliable).
 *   • Both UNCERTAIN  → UNCERTAIN.
 */
export function combineVerdicts(primary: AxisResult, secondary: AxisResult): AxisResult {
  const p = primary.verdict;
  const s = secondary.verdict;

  // If EITHER draw was served via the SERV-internal fallback route, the
  // merged axis-result inherits 'fallback'. Rationale: an aggregated axis
  // verdict where any part was rerouted must carry that provenance.
  const mergedRoute: 'primary' | 'fallback' | undefined =
    primary.provider_route === 'fallback' || secondary.provider_route === 'fallback'
      ? 'fallback'
      : primary.provider_route ?? secondary.provider_route;

  const merged = (verdict: AxisVerdict, confidence: number, note: string): AxisResult => ({
    axis: primary.axis,
    verdict,
    confidence,
    reasoning: `${primary.reasoning}\n\n[secondary] ${secondary.reasoning}\n\n${note}`,
    objection:
      verdict === 'PASS'
        ? ''
        : [primary.objection, secondary.objection].filter(Boolean).join(' | ') ||
          (secondary.objection || primary.objection),
    ...(mergedRoute ? { provider_route: mergedRoute } : {}),
  });

  if (p === 'PASS' && s === 'PASS') {
    return merged('PASS', Math.min(primary.confidence, secondary.confidence), '[cascade] agreement PASS');
  }
  if (p === 'FAIL' && s === 'FAIL') {
    return merged('FAIL', Math.max(primary.confidence, secondary.confidence), '[cascade] agreement FAIL');
  }
  if ((p === 'PASS' && s === 'FAIL') || (p === 'FAIL' && s === 'PASS')) {
    return merged(
      'FAIL',
      Math.max(primary.confidence, secondary.confidence),
      `[cascade] disagreement (${p}↔${s}) → FAIL (conservative)`
    );
  }
  if (p === 'UNCERTAIN' || s === 'UNCERTAIN') {
    return merged(
      'UNCERTAIN',
      Math.max(primary.confidence, secondary.confidence),
      `[cascade] one side UNCERTAIN (${p}↔${s})`
    );
  }
  // Fallback (should be unreachable given the Verdict union).
  return merged('UNCERTAIN', 0, `[cascade] unhandled verdict pair ${p}↔${s}`);
}

function annotate(r: AxisResult, note: string): AxisResult {
  return {
    ...r,
    reasoning: `${r.reasoning}\n\n${note}`,
  };
}
