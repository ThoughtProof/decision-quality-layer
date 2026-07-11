/**
 * Minimal OpenAI-compatible LLM client for the DQL cascade.
 *
 * The DQL cascade has one hot-path: send a (system, user) prompt to a model,
 * get back a JSON string. We deliberately do NOT reuse pot-cli's evaluator
 * here because pot-cli's EvalInput shape (trace_steps, gold_plan_steps,
 * provenance verification) is designed for graded-support evaluation and
 * carries semantics DQL does not need. Coupling to that shape would force
 * us to synthesise dummy trace/gold data on every call.
 *
 * pot-cli's cascade orchestration logic (early-exit, cross-family checks,
 * confirmBlocks) is instead re-implemented in `cascade-pot.ts` in a shape
 * that matches our PASS/FAIL/UNCERTAIN verdict vocabulary directly. See
 * ADR-0007 in the Sentinel repo for the empirical basis of that pattern.
 *
 * Supported providers:
 *   - `serv`    — SERV provider (openserv.ai) - default for DQL cascade
 *   - `openai`  — raw OpenAI chat-completions API
 *   - `groq`    — Groq chat-completions (OpenAI-compatible)
 *   - `mock`    — in-memory router, driven by MockRegistry (tests only)
 *
 * Model aliases (`serv-nano`, `serv-swift`) resolve via `MODEL_MAP` to
 * concrete (provider, model_id, api_key_env) tuples. This keeps the axis
 * layer completely provider-agnostic.
 *
 * Reliability (2026-07-10, DQL-baseline v0.4.1b determinism study):
 * A determinism-metric run over 100 adversarial cases × N=5 draws surfaced
 * that 28% of individual axis-draws returned UNCERTAIN@0 with objection
 * "fetch failed". Root cause: undici (Node fetch) drops HTTP connections
 * after ~50s of server silence when SERV is under load, and the engine's
 * axis-level try/catch (src/engine/index.ts) mapped these directly onto
 * UNCERTAIN@0 without any retry. The Suite-runner had an outer retry
 * wrapper but its 6×20s cap collapsed together with the fetch cutoff.
 *
 * This client applies:
 *   - Explicit AbortController-based per-request timeout (default 60s)
 *   - In-client retry loop with exponential backoff (default 6 attempts,
 *     base 800ms, cap 90s) on transient network / rate-limit errors
 *   - Retries are *inner* to the engine — the script-side RetryLlmClient
 *     stays as an outer belt-and-suspenders wrapper for suite runs
 *
 * Circuit breaker (PR #10, 2026-07-11):
 * On top of retry+timeout, each SERV model alias has a CircuitBreaker that
 * tracks failure rate AND p90 latency in a sliding window. When either
 * threshold trips (e.g. Sentinel's "degraded but not failed" case at
 * p90=22s), the alias goes OPEN and subsequent calls route to its
 * fallback alias (nano↔swift). Both aliases run on the SAME openserv.ai
 * host and use the SAME SERV_API_KEY — this is deliberate. Both models
 * are 0-false-allow-calibrated against the adversarial suite; a foreign
 * vendor (Groq / OpenAI) would silently downgrade that safety property.
 *
 * The tradeoff we accept:
 *   ✅ SERV model overload (per-model queue, per-tier rate limit) is handled
 *      by cross-tier failover — the common Sentinel-p90=22s case.
 *   ❌ openserv.ai host-level outage (whole endpoint down, or SERV_API_KEY
 *      revoked) collapses both circuits at once. In that state the client
 *      throws CircuitAllOpenError, which the engine maps to a fail-closed
 *      UNCERTAIN@0 verdict with an explicit objection. For a safety product
 *      the correct default under provider outage is "escalate to human",
 *      not "call an uncalibrated model".
 *
 * A cross-vendor fallback (Groq / OpenAI) is deliberately NOT in this PR.
 * It requires a 0-false-allow eval gate on the fallback provider first;
 * that work is tracked separately.
 */

import { CircuitBreaker, type CircuitBreakerConfig, CircuitOpenError } from './circuit-breaker.js';

export interface LlmCallInput {
  system: string;
  user: string;
  maxTokens?: number;
}

export interface LlmCallOutput {
  raw: string;
  modelUsed: string;
  latencyMs: number;
  /**
   * Which route served the call:
   *   - 'primary'  — requested alias
   *   - 'fallback' — fallback alias (primary circuit was OPEN)
   *
   * Populated on every call (not just non-primary) so downstream reporting
   * can attribute EVERY draw to an actual SERV model. Older readers that
   * ignore this field see no behavioral change.
   */
  providerRoute?: 'primary' | 'fallback';
  /**
   * v0.4.3 recert instrumentation — optional, non-breaking.
   *
   * attemptCount: 1 if the call succeeded on the first try; N if N-1 retries
   * were needed. Together with backoffWaitedMs this lets downstream reporting
   * decompose a large latencyMs sample into (network_time) + (backoff_waits)
   * so CircuitBreaker trips can be attributed to "real provider instability
   * with retries" vs "single slow-but-successful call".
   *
   * backoffWaitedMs: sum of sleep(backoff) waits between failed attempts.
   * Zero when attemptCount is 1.
   *
   * retryReasons: message excerpts for each retried attempt (max 4, first
   * 120 chars each). Empty when attemptCount is 1.
   */
  attemptCount?: number;
  backoffWaitedMs?: number;
  retryReasons?: string[];
}

export interface LlmClient {
  call(modelAlias: string, input: LlmCallInput): Promise<LlmCallOutput>;
}

/**
 * Thrown when both the primary alias circuit AND its fallback alias circuit
 * are OPEN. The engine (src/engine/index.ts) maps this to a fail-closed
 * UNCERTAIN@0 verdict with an explicit objection — for a safety product,
 * "escalate to human" is the correct default under provider outage.
 */
export class CircuitAllOpenError extends Error {
  constructor(
    public readonly primaryAlias: string,
    public readonly fallbackAlias: string | null,
    public readonly primaryReason: string,
    public readonly fallbackReason: string | null
  ) {
    super(
      fallbackAlias
        ? `[llm-client] both circuits open: ${primaryAlias} (${primaryReason}) and ${fallbackAlias} (${fallbackReason})`
        : fallbackReason
          ? `[llm-client] fail-closed on ${primaryAlias} (${primaryReason}) — ${fallbackReason}`
          : `[llm-client] circuit open and no fallback configured: ${primaryAlias} (${primaryReason})`
    );
    this.name = 'CircuitAllOpenError';
  }
}

/**
 * Map alias → concrete backend. Keys are the aliases used by the cascade
 * (`serv-nano` = fast/cheap primary; `serv-swift` = stronger secondary).
 *
 * Kept minimal on purpose. NOTE (2026-07-08): DQL runs both stages on the SERV
 * stack (serv-nano primary, serv-swift secondary) — same provider, different
 * capability tiers. This is NOT the ADR-0007 cross-vendor-family setup; the
 * second-opinion value here comes from serv-swift being a stronger SERV model
 * than serv-nano, not from a different vendor. There is intentionally no
 * cross-family assertion at build time (it would reject two 'serv' bindings).
 */
export interface ModelBinding {
  provider: 'openai' | 'groq' | 'serv';
  modelId: string;
  /** Name of the env var that carries the API key. */
  apiKeyEnv: string;
  baseUrl: string;
  /**
   * SERV-internal fallback alias for circuit-breaker routing. When this
   * alias's circuit is OPEN, calls route to the fallback alias's binding
   * (which MUST also be present in the same ModelMap). Set to null / undef
   * for aliases that have no fallback — in that case CircuitAllOpenError is
   * thrown as soon as the alias circuit opens.
   *
   * IMPORTANT: fallback aliases MUST be pre-validated for the same safety
   * property (0 false_allows on the adversarial suite). See PR #10 body.
   */
  fallbackAlias?: string | null;
}

export const DEFAULT_MODEL_MAP: Record<string, ModelBinding> = {
  // Primary — SERV serv-nano (openserv.ai). Same model Sentinel uses as its
  // standard-tier primary. NOT OpenAI gpt-4o-mini — DQL runs on the SERV stack
  // via SERV_API_KEY, identical to pot-cli's model-router bindings.
  'serv-nano': {
    provider: 'serv',
    modelId: 'serv-nano',
    apiKeyEnv: 'SERV_API_KEY',
    baseUrl: process.env.SERV_BASE_URL ?? 'https://inference-api.openserv.ai/v1',
    fallbackAlias: 'serv-swift',
  },
  // Secondary — SERV serv-swift. The cross-family strength comes from serv-swift
  // being a distinct, larger SERV model than serv-nano (mirrors Sentinel's
  // nano→swift standard-tier cascade), not from a second commercial vendor.
  'serv-swift': {
    provider: 'serv',
    modelId: 'serv-swift',
    apiKeyEnv: 'SERV_API_KEY',
    baseUrl: process.env.SERV_BASE_URL ?? 'https://inference-api.openserv.ai/v1',
    fallbackAlias: 'serv-nano',
  },
};

// -----------------------------------------------------------------------------
// Retry + timeout config
// -----------------------------------------------------------------------------

export interface HttpLlmClientConfig {
  /** Per-request timeout in ms (AbortController). Default: 60000. */
  timeoutMs?: number;
  /** Max retry attempts including the first one. Default: 6. */
  maxAttempts?: number;
  /** Base backoff in ms — actual wait = min(base * 2^(i-1), backoffCapMs) + jitter. Default: 800. */
  backoffBaseMs?: number;
  /** Backoff cap in ms. Default: 90000 (raised from suite-runner 20s to survive SERV overload windows). */
  backoffCapMs?: number;
  /** Injection point for tests — clock/sleep. */
  sleep?: (ms: number) => Promise<void>;
  /** Injection point for tests — fetch. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /**
   * Config passed to every CircuitBreaker instance the client creates.
   * Leave undefined to accept CircuitBreaker defaults.
   */
  circuitBreakerConfig?: CircuitBreakerConfig;
  /**
   * Disable circuit-breaker routing entirely. Every call goes straight to
   * its requested alias; no failover, no fail-closed. Intended for tests
   * and for the specific baseline runs that predate PR #10. Default: false.
   */
  disableCircuitBreaker?: boolean;
  /**
   * Capital-path mode: when a Primary circuit is OPEN, DO NOT route to the
   * SERV-internal fallback alias. Instead throw CircuitAllOpenError so the
   * engine emits UNCERTAIN@0 (fail-closed).
   *
   * Rationale (PR #10):
   * The fallback alias (nano↔swift) has only been smoke-verified against
   * Suite v1.1 (8 cases) with 0 safety regressions. The full 100-case
   * adversarial swift-recertification is scheduled as v0.4.3 fast-follow.
   * Until then, code paths that dispatch REAL CAPITAL — live trading,
   * Revolut, sentinel.thoughtproof.ai in prod — MUST set this flag so a
   * SERV-internal outage escalates to human review instead of being served
   * by an under-certified fallback model.
   *
   * Benchmark / eval runners set this to false (default) so Baseline
   * survival during SERV overload windows is preserved.
   *
   * Default: false. Flip to true in prod-capital deploys until v0.4.3.
   */
  capitalPathMode?: boolean;
}

const DEFAULT_CONFIG: Required<Omit<HttpLlmClientConfig, 'sleep' | 'fetchImpl' | 'circuitBreakerConfig' | 'disableCircuitBreaker' | 'capitalPathMode'>> = {
  timeoutMs: 60_000,
  maxAttempts: 6,
  backoffBaseMs: 800,
  backoffCapMs: 90_000,
};

/**
 * Match the exact pattern the script-side RetryLlmClient uses so behavior
 * is identical whether the retry fires in-engine or in the wrapper.
 */
const RETRYABLE_PATTERN =
  /429|too many|rate|proxy|fetch failed|ECONN|ETIMEDOUT|EAI_AGAIN|socket hang up|aborted|timeout/i;

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// -----------------------------------------------------------------------------
// Real (fetch-based) client
// -----------------------------------------------------------------------------

export class HttpLlmClient implements LlmClient {
  private readonly config: Required<Omit<HttpLlmClientConfig, 'sleep' | 'fetchImpl' | 'circuitBreakerConfig' | 'disableCircuitBreaker' | 'capitalPathMode'>>;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly fetchImpl: typeof fetch;
  private readonly circuitBreakers: Map<string, CircuitBreaker> = new Map();
  private readonly circuitBreakerConfig: CircuitBreakerConfig | undefined;
  private readonly disableCircuitBreaker: boolean;
  private readonly capitalPathMode: boolean;

  constructor(
    private readonly modelMap: Record<string, ModelBinding> = DEFAULT_MODEL_MAP,
    private readonly env: NodeJS.ProcessEnv = process.env,
    config: HttpLlmClientConfig = {}
  ) {
    this.config = {
      timeoutMs: config.timeoutMs ?? DEFAULT_CONFIG.timeoutMs,
      maxAttempts: config.maxAttempts ?? DEFAULT_CONFIG.maxAttempts,
      backoffBaseMs: config.backoffBaseMs ?? DEFAULT_CONFIG.backoffBaseMs,
      backoffCapMs: config.backoffCapMs ?? DEFAULT_CONFIG.backoffCapMs,
    };
    this.sleep = config.sleep ?? defaultSleep;
    this.fetchImpl = config.fetchImpl ?? fetch;
    this.circuitBreakerConfig = config.circuitBreakerConfig;
    this.disableCircuitBreaker = config.disableCircuitBreaker ?? false;
    this.capitalPathMode = config.capitalPathMode ?? false;
  }

  /**
   * Lazily construct a CircuitBreaker per alias. Kept private — no caller
   * should hold a stable ref because Map identity is per-client-instance.
   */
  private getBreaker(alias: string): CircuitBreaker {
    let cb = this.circuitBreakers.get(alias);
    if (!cb) {
      cb = new CircuitBreaker(alias, this.circuitBreakerConfig);
      this.circuitBreakers.set(alias, cb);
    }
    return cb;
  }

  /** Snapshot of every alias circuit — for telemetry / test assertions. */
  circuitSnapshot(): Record<string, ReturnType<CircuitBreaker['snapshot']>> {
    const out: Record<string, ReturnType<CircuitBreaker['snapshot']>> = {};
    for (const [alias, cb] of this.circuitBreakers) {
      out[alias] = cb.snapshot();
    }
    return out;
  }

  async call(modelAlias: string, input: LlmCallInput): Promise<LlmCallOutput> {
    const binding = this.modelMap[modelAlias];
    if (!binding) {
      throw new Error(`[llm-client] unknown model alias: ${modelAlias}`);
    }

    // Fast path: circuit-breaker disabled (tests, or explicit opt-out for
    // legacy baseline runs). Behavior identical to pre-PR-10.
    if (this.disableCircuitBreaker) {
      const out = await this.callWithRetry(binding, input);
      return { ...out, providerRoute: 'primary' };
    }

    // Try primary. If its circuit is OPEN, route to fallback alias —
    // UNLESS we're in capital-path mode, where fail-closed is mandatory
    // until v0.4.3 recertifies the fallback alias on the full 100-case suite.
    const primaryBreaker = this.getBreaker(modelAlias);
    try {
      primaryBreaker.canProceed();
    } catch (err) {
      if (err instanceof CircuitOpenError) {
        if (this.capitalPathMode) {
          throw new CircuitAllOpenError(modelAlias, null, err.reason, 'capital-path-mode: fallback disabled until v0.4.3 recertification');
        }
        return await this.callViaFallback(modelAlias, binding, input, err.reason);
      }
      throw err;
    }

    // Circuit is CLOSED (or HALF_OPEN probe was granted) — primary attempt.
    const started = Date.now();
    try {
      const out = await this.callWithRetry(binding, input);
      // v0.4.3 CB-latency-fix (PR #11): report NETWORK latency to the
      // circuit-breaker, not wall-clock. Backoff waits are retry-policy
      // delay, not provider processing time. Successful retry clusters
      // must not inflate the latency signal; exhausted retry loops are
      // independently represented by the failure-rate path (throw path
      // below), which feeds recordFailure() only once the retry loop is
      // exhausted — successful retry clusters emit no failure sample.
      const wallClock = Date.now() - started;
      const netLatency = Math.max(0, wallClock - (out.backoffWaitedMs ?? 0));
      primaryBreaker.recordSuccess(netLatency);
      return { ...out, providerRoute: 'primary' };
    } catch (err) {
      // Wall-clock elapsed for failures — the retry loop exhausted, so the
      // TOTAL time is the meaningful signal for the failure_rate window.
      // (There is no LlmCallOutput to read backoffWaitedMs from on this path.)
      primaryBreaker.recordFailure(Date.now() - started);
      // If the circuit just tripped from this failure, try fallback for the
      // very SAME call — the caller shouldn't eat one "cold" failure per trip.
      // In capital-path mode, fail-closed instead of routing to fallback.
      if (primaryBreaker.snapshot().state === 'OPEN') {
        if (this.capitalPathMode) {
          throw new CircuitAllOpenError(
            modelAlias,
            null,
            primaryBreaker.snapshot().lastTripReason,
            'capital-path-mode: fallback disabled until v0.4.3 recertification'
          );
        }
        return await this.callViaFallback(
          modelAlias,
          binding,
          input,
          primaryBreaker.snapshot().lastTripReason
        );
      }
      throw err;
    }
  }

  /**
   * Route a call to the primary's fallback alias. If the primary has no
   * fallback configured, or the fallback's own circuit is also OPEN, throw
   * CircuitAllOpenError — the engine will map that to a fail-closed verdict.
   */
  private async callViaFallback(
    primaryAlias: string,
    primaryBinding: ModelBinding,
    input: LlmCallInput,
    primaryReason: string
  ): Promise<LlmCallOutput> {
    const fallbackAlias = primaryBinding.fallbackAlias ?? null;
    if (!fallbackAlias) {
      throw new CircuitAllOpenError(primaryAlias, null, primaryReason, null);
    }
    const fallbackBinding = this.modelMap[fallbackAlias];
    if (!fallbackBinding) {
      throw new Error(
        `[llm-client] fallbackAlias '${fallbackAlias}' for '${primaryAlias}' not in modelMap`
      );
    }
    const fallbackBreaker = this.getBreaker(fallbackAlias);
    try {
      fallbackBreaker.canProceed();
    } catch (err) {
      if (err instanceof CircuitOpenError) {
        throw new CircuitAllOpenError(
          primaryAlias,
          fallbackAlias,
          primaryReason,
          err.reason
        );
      }
      throw err;
    }

    const started = Date.now();
    try {
      const out = await this.callWithRetry(fallbackBinding, input);
      // v0.4.3 CB-latency-fix (PR #11): see primary path for rationale.
      const wallClock = Date.now() - started;
      const netLatency = Math.max(0, wallClock - (out.backoffWaitedMs ?? 0));
      fallbackBreaker.recordSuccess(netLatency);
      return { ...out, providerRoute: 'fallback' };
    } catch (err) {
      fallbackBreaker.recordFailure(Date.now() - started);
      throw err;
    }
  }

  /**
   * The original retry-loop, extracted so both primary and fallback paths
   * share behavior. Does NOT touch any circuit breaker — caller records
   * outcome on the appropriate breaker.
   */
  private async callWithRetry(
    binding: ModelBinding,
    input: LlmCallInput
  ): Promise<LlmCallOutput> {
    const apiKey = this.env[binding.apiKeyEnv];
    if (!apiKey) {
      throw new Error(
        `[llm-client] missing env var ${binding.apiKeyEnv} for provider ${binding.provider}`
      );
    }

    let lastErr: unknown;
    let backoffWaitedMs = 0;
    const retryReasons: string[] = [];
    for (let attempt = 1; attempt <= this.config.maxAttempts; attempt++) {
      try {
        const out = await this.singleCall(binding, apiKey, input);
        return {
          ...out,
          attemptCount: attempt,
          backoffWaitedMs,
          retryReasons,
        };
      } catch (err) {
        lastErr = err;
        const msg = err instanceof Error ? err.message : String(err);
        const retryable = RETRYABLE_PATTERN.test(msg);
        if (!retryable || attempt === this.config.maxAttempts) {
          throw err;
        }
        if (retryReasons.length < 4) retryReasons.push(msg.slice(0, 120));
        const wait =
          Math.min(this.config.backoffBaseMs * Math.pow(2, attempt - 1), this.config.backoffCapMs) +
          Math.floor(Math.random() * 800);
        backoffWaitedMs += wait;
        await this.sleep(wait);
      }
    }
    // Unreachable — the loop above either returns or throws.
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }

  private async singleCall(
    binding: ModelBinding,
    apiKey: string,
    input: LlmCallInput
  ): Promise<LlmCallOutput> {
    const started = Date.now();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs);

    let response: Response;
    try {
      response = await this.fetchImpl(`${binding.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: binding.modelId,
          messages: [
            { role: 'system', content: input.system },
            { role: 'user', content: input.user },
          ],
          // Deterministic decoding — matches Sentinel's cascade (temperature: 0,
          // seed: 42). The DQL orthogonality spike was itself run through the
          // pot-cli grader at temp 0 / seed 42; running the live cascade at 0.1
          // without a seed would reintroduce exactly the verdict non-determinism
          // that the Sentinel RCA (2026-07-08) tracked down. Keep it pinned.
          temperature: 0,
          seed: 42,
          // SERV (openserv.ai) requires 'max_completion_tokens', not the legacy
          // 'max_tokens' (returns HTTP 400 unsupported_parameter otherwise).
          max_completion_tokens: input.maxTokens ?? 512,
          // JSON mode: SERV (openserv.ai) is OpenAI-compatible and accepts
          // response_format. If a model rejects the field we fall back to plain
          // text and let parseAxisResponse handle it.
          response_format: { type: 'json_object' },
        }),
        signal: controller.signal,
      });
    } catch (err) {
      // AbortError from our own timeout should surface as a retryable
      // "timeout" message so RETRYABLE_PATTERN picks it up.
      if (err instanceof Error && err.name === 'AbortError') {
        throw new Error(`[llm-client] request timeout after ${this.config.timeoutMs}ms (aborted)`);
      }
      throw err;
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(
        `[llm-client] ${binding.provider} ${response.status}: ${body.slice(0, 500)}`
      );
    }

    const json = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const raw = json?.choices?.[0]?.message?.content ?? '';
    return {
      raw,
      modelUsed: `${binding.provider}:${binding.modelId}`,
      latencyMs: Date.now() - started,
    };
  }
}

// -----------------------------------------------------------------------------
// Mock client — used by tests to drive the cascade without network calls.
// -----------------------------------------------------------------------------

export type MockResponder = (modelAlias: string, input: LlmCallInput) => LlmCallOutput | Promise<LlmCallOutput>;

export class MockLlmClient implements LlmClient {
  constructor(private readonly responder: MockResponder) {}

  async call(modelAlias: string, input: LlmCallInput): Promise<LlmCallOutput> {
    return await this.responder(modelAlias, input);
  }
}
