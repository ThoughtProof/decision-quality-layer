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
import {
  HttpLlmClient,
  CircuitAllOpenError,
  ProviderCallError,
  DeadlineExceededError,
} from './llm-client.js';
import type { CallContext } from './call-context.js';

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
    const { axis, prompt, ctx } = input;
    const modelsUsed: string[] = [];

    // ---- Primary --------------------------------------------------------
    const primary = await this.callAxis(this.config.primaryModel, axis, prompt, ctx);
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
    // If whole-request budget is nearly exhausted, skip secondary and
    // fail-closed immediately so we still return 200+REVIEW before platform kill.
    if (ctx?.deadlineAt !== undefined) {
      const remainingW = ctx.deadlineAt - Date.now();
      const pc = ctx.providerCallBudgetMs ?? 40_000;
      const minSecondaryBudget = pc + 3_000;
      if (remainingW < minSecondaryBudget) {
        const err = new DeadlineExceededError(
          `[cascade] skipping secondary — remainingW=${remainingW}ms < minSecondaryBudget=${minSecondaryBudget}ms`,
          'serv',
          'request_deadline',
        );
        const fallbackVerdict: AxisVerdict =
          primary.result.verdict === 'PASS' ? 'UNCERTAIN' : primary.result.verdict;
        const degraded: AxisResult = {
          axis: primary.result.axis,
          verdict: fallbackVerdict,
          confidence: primary.result.confidence,
          reasoning: primary.result.reasoning,
          objection: primary.result.objection,
          provider_outcome: 'provider_error',
        };
        return {
          result: annotate(
            degraded,
            `[cascade] secondary skipped (request_deadline) → degraded (${err.message.slice(0, 200)})`,
          ),
          modelsUsed,
        };
      }
    }

    let secondary: AxisCall;
    try {
      secondary = await this.callAxis(this.config.secondaryModel, axis, prompt, ctx);
      modelsUsed.push(secondary.modelId);
    } catch (err) {
      // Degraded mode: secondary unavailable → be conservative on the verdict
      // AND emit truthful structured provenance so the aggregator can fail
      // closed. Primary=PASS → downgrade to UNCERTAIN. Primary=FAIL → keep FAIL
      // (secondary can never rescue FAIL under our rules). Primary=UNCERTAIN
      // stays UNCERTAIN.
      //
      // VERTRAGSÄNDERUNG (issue #14, 2026-07-13): this branch previously spread
      // `...primary.result`, inheriting the primary's provider_route +
      // provider_outcome='served' onto an axis whose secondary draw FAILED.
      // A 'served' label there is an active falsehood: aggregation Rule 2 trusts
      // provider provenance, so it never fired and a single PASS@<0.7 primary
      // could fall through to ALLOW ("All evaluated axes pass.") — the §D6
      // fail-open, re-opened via the degraded path. We now classify the
      // secondary error from its STRUCTURED TYPE (never message parsing,
      // mirroring the engine's §D6 whole-cascade catch) and:
      //   • provider/auth/circuit failure → attach provider_error |
      //     circuit_rejected. Rule 2 escalates the axis to REVIEW-or-stricter,
      //     INDEPENDENT of confidence.
      //   • any OTHER (generic/local) error → no provider_outcome, matching the
      //     engine's negative-discrimination baseline (a lone UNCERTAIN@<0.7
      //     with no provenance still ALLOWs, unchanged).
      // In BOTH cases the degraded axis DROPS the inherited primary route/
      // outcome, so it never claims 'served' when the secondary failed.
      const fallbackVerdict: AxisVerdict =
        primary.result.verdict === 'PASS' ? 'UNCERTAIN' : primary.result.verdict;
      const providerOutcome = classifySecondaryFailure(err);
      const note = `[cascade] secondary error → degraded (${err instanceof Error ? err.message.slice(0, 200) : 'unknown'})`;
      const degraded: AxisResult = {
        axis: primary.result.axis,
        verdict: fallbackVerdict,
        confidence: primary.result.confidence,
        reasoning: primary.result.reasoning,
        objection: primary.result.objection,
        ...(providerOutcome ? { provider_outcome: providerOutcome } : {}),
      };
      return {
        result: annotate(degraded, note),
        modelsUsed,
      };
    }

    return {
      result: combineVerdicts(primary.result, secondary.result),
      modelsUsed,
    };
  }

  private async callAxis(
    modelAlias: string,
    axis: Axis,
    prompt: AxisPrompt,
    ctx?: CallContext,
  ): Promise<AxisCall> {
    // v0.4.3.1 §C.1: ctx is threaded through cascade → llm-client for
    // handler-owned requestId propagation.
    const out = await this.client.call(
      modelAlias,
      {
        system: prompt.system,
        user: prompt.user,
        maxTokens: this.config.maxTokens,
      },
      ctx,
    );
    const parsed = parseAxisResponse(axis, out.raw);
    // Attach provider_route from the llm-client output. When the client
    // doesn't provide it (e.g. Mock/Stub cascade in tests), leave undefined.
    // v0.4.3.1 (§C.3): a served response also sets provider_outcome='served'
    // so downstream aggregators can distinguish served-fallback from fail-closed.
    if (out.providerRoute) {
      parsed.provider_route = out.providerRoute;
      parsed.provider_outcome = 'served';
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

  // v0.4.3.1 (§C.3): merged provider_outcome is 'served' only if BOTH draws
  // were served (they must have been — combineVerdicts is called with two
  // served AxisResults from the cascade). If either lacks 'served', the
  // merged result carries the more-informative label from primary.
  // v0.4.3.1 §C.3-fix: the union now includes 'provider_error'. The merge
  // rule stays: 'served' iff BOTH draws are 'served', else the primary's
  // outcome (or the secondary's when primary omits one).
  const mergedOutcome:
    | 'served'
    | 'circuit_rejected'
    | 'provider_error'
    | undefined =
    primary.provider_outcome === 'served' && secondary.provider_outcome === 'served'
      ? 'served'
      : primary.provider_outcome ?? secondary.provider_outcome;

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
    ...(mergedOutcome ? { provider_outcome: mergedOutcome } : {}),
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

/**
 * Classify a secondary-draw failure into structured provider provenance,
 * mirroring the engine's §D6 whole-cascade catch (src/engine/index.ts). The
 * classification is driven ENTIRELY by the error's TYPE — never by parsing
 * Error.message.
 *
 *   CircuitAllOpenError, attemptedRoutes === [] → no provider fetch was
 *     started                                    → 'circuit_rejected'
 *   CircuitAllOpenError, attemptedRoutes ≠ []   → at least one provider fetch
 *     was started (and failed)                   → 'provider_error'
 *   ProviderCallError (HTTP 401/5xx or transport failure that did NOT trip the
 *     breaker)                                   → 'provider_error'
 *   Any OTHER error (local config: missing key, unknown alias, parser/logic
 *     bug) → undefined: no provider provenance, prior baseline preserved.
 */
function classifySecondaryFailure(
  err: unknown,
): 'provider_error' | 'circuit_rejected' | undefined {
  if (err instanceof CircuitAllOpenError) {
    return err.attemptedRoutes.length === 0 ? 'circuit_rejected' : 'provider_error';
  }
  // DeadlineExceededError extends ProviderCallError → provider_error → REVIEW.
  if (err instanceof ProviderCallError) {
    return 'provider_error';
  }
  return undefined;
}
