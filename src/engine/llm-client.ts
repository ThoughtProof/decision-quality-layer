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

import { CircuitBreaker, type CircuitBreakerConfig, CircuitOpenError, type CircuitDomainEvent } from './circuit-breaker.js';
import type { CallContext } from './call-context.js';
import type { AttemptEvent, BindingSummary } from './runtime-diagnostics.js';
import { categorizeFailure } from './runtime-diagnostics.js';

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
   * v0.4.3.1 §C+integration — flat attribution field.
   *
   * The alias that actually served this response. Equal to the alias the
   * cascade requested when `providerRoute === 'primary'`; equal to the
   * primary's `fallbackAlias` when `providerRoute === 'fallback'`. This is
   * the flattened form of what earlier commits derived by inspecting
   * `providerRoute` + the cascade's alias request — it is exposed here so
   * diagnostics and the engine can attribute a response to a concrete
   * SERV model without re-deriving the mapping.
   *
   * Optional for backwards compatibility with older LlmClient impls
   * (StubLlmClient tests that predate the flag).
   */
  attemptAlias?: string;
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
  /**
   * `ctx` (v0.4.3.1 §C.1) is an optional forward-compatible slot for the
   * handler-owned CallContext. Existing callers may omit it; future
   * commits attach a RuntimeDiagnosticsCollector to it for state-transition
   * events. This interface change is additive — no existing test breaks.
   */
  call(modelAlias: string, input: LlmCallInput, ctx?: CallContext): Promise<LlmCallOutput>;
}

/**
 * Thrown when both the primary alias circuit AND its fallback alias circuit
 * are OPEN. The engine (src/engine/index.ts) maps this to a fail-closed
 * UNCERTAIN@0 verdict with an explicit objection — for a safety product,
 * "escalate to human" is the correct default under provider outage.
 *
 * v0.4.3.1 §C.3-fix (Hermes 2026-07-11): the error carries structured
 * provenance of which routes (if any) were actually attempted against the
 * upstream provider in the current axis call. The engine uses this to
 * distinguish `circuit_rejected` (no fetch was made) from `provider_error`
 * (at least one fetch was attempted but failed). This must NEVER be derived
 * from Error.message string parsing.
 *
 * Contract:
 *   attemptedRoutes = []                    → no provider fetch was started
 *   attemptedRoutes = ['primary']           → primary was fetched (and failed)
 *   attemptedRoutes = ['primary','fallback']→ both fetched (both failed)
 *   attemptedRoutes = ['fallback']          → primary skipped (already OPEN),
 *                                              fallback was fetched (failed)
 */
export type AttemptedRoute = 'primary' | 'fallback';
export class CircuitAllOpenError extends Error {
  public readonly attemptedRoutes: readonly AttemptedRoute[];
  constructor(
    public readonly primaryAlias: string,
    public readonly fallbackAlias: string | null,
    public readonly primaryReason: string,
    public readonly fallbackReason: string | null,
    attemptedRoutes: readonly AttemptedRoute[] = []
  ) {
    super(
      fallbackAlias
        ? `[llm-client] both circuits open: ${primaryAlias} (${primaryReason}) and ${fallbackAlias} (${fallbackReason})`
        : fallbackReason
          ? `[llm-client] fail-closed on ${primaryAlias} (${primaryReason}) — ${fallbackReason}`
          : `[llm-client] circuit open and no fallback configured: ${primaryAlias} (${primaryReason})`
    );
    this.name = 'CircuitAllOpenError';
    // Defensive copy — callers must not be able to mutate provenance after
    // the error is thrown.
    this.attemptedRoutes = Object.freeze([...attemptedRoutes]);
  }
}

/**
 * A failure that originates from an actual provider interaction inside
 * singleCall() — a non-OK HTTP response (e.g. 401/403/5xx) or a transport
 * error (fetch failed, timeout/abort, connection reset). It is deliberately
 * DISTINCT from local configuration errors (missing API key, unknown alias),
 * which are plain Errors thrown OUTSIDE singleCall and must NOT be classified
 * as provider failures.
 *
 * v0.4.3.1 §D6-fix: this typed class lets the engine attribute structured
 * `provider_outcome: 'provider_error'` provenance WITHOUT parsing Error.message
 * strings. The `message` is preserved verbatim from the underlying failure so
 * RETRYABLE_PATTERN classification, categorizeFailure(), and existing
 * message-regex test assertions remain unchanged.
 */
export class ProviderCallError extends Error {
  constructor(
    message: string,
    public readonly provider: string,
    public readonly httpStatus?: number,
    options?: { cause?: unknown },
  ) {
    super(message, options as ErrorOptions);
    this.name = 'ProviderCallError';
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
   *
   * v0.4.3.1 hardening: prefer `circuitBreakerConfigByAlias` for per-alias
   * knobs. When both are set, per-alias overrides win for the aliases they
   * name; the global config applies to any unnamed alias.
   */
  circuitBreakerConfig?: CircuitBreakerConfig;
  /**
   * Per-alias CircuitBreaker knobs. When an alias appears here, its
   * breaker is instantiated with the merged (perAlias over global)
   * config. When absent, the global config (or CB defaults) applies.
   *
   * v0.4.3.1 §D-hardening: required for capital-path deploys because
   * nano and swift target different SLA envelopes.
   */
  circuitBreakerConfigByAlias?: Record<string, CircuitBreakerConfig>;
  /**
   * Disable circuit-breaker routing entirely. Every call goes straight to
   * its requested alias; no failover, no fail-closed. Intended for tests
   * and for the specific baseline runs that predate PR #10. Default: false.
   */
  disableCircuitBreaker?: boolean;
  /**
   * v0.4.3.1 §C+integration H1: require a request-scoped diagnostics
   * collector on every `call()`. Set by the factory when the resolver
   * activates the v0431_active canary AND diagnostics_on=true. When set:
   *   - `ctx.collector` MUST be present or the call is rejected before
   *     admission and before any provider fetch is attempted.
   *   - `ctx.collector.requestId` MUST equal `ctx.requestId` (attribution
   *     guarantee). Mismatch is rejected before admission.
   * The check runs BEFORE the disableCircuitBreaker fast path, so a caller
   * cannot bypass diagnostics by opting out of the breaker.
   *
   * This is a factory-side safety option — the factory sets it, tests may
   * NOT override it via clientOptionsOverride (the factory re-spreads it
   * after the override, same policy as disableCircuitBreaker /
   * capitalPathMode).
   */
  requireDiagnostics?: boolean;
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

const DEFAULT_CONFIG: Required<Omit<HttpLlmClientConfig, 'sleep' | 'fetchImpl' | 'circuitBreakerConfig' | 'circuitBreakerConfigByAlias' | 'disableCircuitBreaker' | 'capitalPathMode' | 'requireDiagnostics'>> = {
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
// Retry-failure telemetry (v0.4.3.1 §C M1)
//
// callWithRetry annotates the thrown error with the running attemptCount,
// backoffWaitedMs, and retryReasons so the caller's failure branch can
// compute netLatency symmetrically with the success branch. The annotation
// lives on a NON-ENUMERABLE symbol property so it does not leak into logs
// or JSON serialization by accident.
// -----------------------------------------------------------------------------

const RETRY_TELEMETRY = Symbol.for('dql.llm.retryTelemetry');

interface RetryTelemetry {
  attemptCount: number;
  backoffWaitedMs: number;
  retryReasons: readonly string[];
}

function annotateRetryFailure<E>(err: E, telemetry: RetryTelemetry): E {
  if (err && typeof err === 'object') {
    try {
      Object.defineProperty(err as object, RETRY_TELEMETRY, {
        value: Object.freeze({ ...telemetry, retryReasons: Object.freeze([...telemetry.retryReasons]) }),
        enumerable: false,
        writable: false,
        configurable: false,
      });
    } catch {
      // If the error object is frozen or an exotic value, fall through —
      // caller will use the wall-clock latency (safe upper bound).
    }
  }
  return err;
}

function readRetryTelemetry(err: unknown): RetryTelemetry | null {
  if (err && typeof err === 'object' && RETRY_TELEMETRY in err) {
    const raw = (err as { [k: symbol]: unknown })[RETRY_TELEMETRY];
    if (raw && typeof raw === 'object') return raw as RetryTelemetry;
  }
  return null;
}

// -----------------------------------------------------------------------------
// Real (fetch-based) client
// -----------------------------------------------------------------------------

export class HttpLlmClient implements LlmClient {
  private readonly config: Required<Omit<HttpLlmClientConfig, 'sleep' | 'fetchImpl' | 'circuitBreakerConfig' | 'circuitBreakerConfigByAlias' | 'disableCircuitBreaker' | 'capitalPathMode' | 'requireDiagnostics'>>;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly fetchImpl: typeof fetch;
  private readonly circuitBreakers: Map<string, CircuitBreaker> = new Map();
  private readonly circuitBreakerConfig: CircuitBreakerConfig | undefined;
  private readonly circuitBreakerConfigByAlias:
    | Record<string, CircuitBreakerConfig>
    | undefined;
  private readonly disableCircuitBreaker: boolean;
  private readonly capitalPathMode: boolean;
  private readonly requireDiagnostics: boolean;

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
    this.circuitBreakerConfigByAlias = config.circuitBreakerConfigByAlias;
    this.disableCircuitBreaker = config.disableCircuitBreaker ?? false;
    this.capitalPathMode = config.capitalPathMode ?? false;
    this.requireDiagnostics = config.requireDiagnostics ?? false;
  }

  /**
   * Lazily construct a CircuitBreaker per alias. Kept private — no caller
   * should hold a stable ref because Map identity is per-client-instance.
   */
  private getBreaker(alias: string): CircuitBreaker {
    let cb = this.circuitBreakers.get(alias);
    if (!cb) {
      // v0.4.3.1 hardening: per-alias config wins over global. Shallow
      // merge so unspecified per-alias fields fall back to global then
      // CB defaults. This is the wiring point Hermes Blocker 6 requires.
      const perAlias = this.circuitBreakerConfigByAlias?.[alias];
      const merged: CircuitBreakerConfig | undefined = perAlias
        ? { ...(this.circuitBreakerConfig ?? {}), ...perAlias }
        : this.circuitBreakerConfig;
      cb = new CircuitBreaker(alias, merged);
      this.circuitBreakers.set(alias, cb);
    }
    return cb;
  }

  /**
   * @internal Test-only accessor: return the live CircuitBreaker for an
   * alias. Not part of the public production API. Integration tests use
   * this to drive the state machine directly (e.g. simulate a mid-fetch
   * trip for stale-success assertions). Production callers must not use
   * this — hold no stable references to per-client CircuitBreaker
   * instances.
   */
  _testOnlyGetBreaker(alias: string): CircuitBreaker {
    return this.getBreaker(alias);
  }

  /**
   * K5 admission-safety precondition: fail synchronously if the binding's
   * apiKey env var is missing. Must be called BEFORE breaker.admit() so a
   * local configuration error never appears as a provider failure sample.
   * Contract: throws Error with 'missing env var' in the message; does not
   * touch any circuit breaker; caller is responsible for calling this on
   * the exact binding it is about to attempt (primary or fallback).
   */
  private requireApiKey(binding: ModelBinding): string {
    const value = this.env[binding.apiKeyEnv];
    if (!value) {
      throw new Error(
        `[llm-client] missing env var '${binding.apiKeyEnv}' for provider '${binding.provider}'`
      );
    }
    return value;
  }

  /** Snapshot of every alias circuit — for telemetry / test assertions. */
  circuitSnapshot(): Record<string, ReturnType<CircuitBreaker['snapshot']>> {
    const out: Record<string, ReturnType<CircuitBreaker['snapshot']>> = {};
    for (const [alias, cb] of this.circuitBreakers) {
      out[alias] = cb.snapshot();
    }
    return out;
  }

  async call(
    modelAlias: string,
    input: LlmCallInput,
    ctx?: CallContext,
  ): Promise<LlmCallOutput> {
    const binding = this.modelMap[modelAlias];
    if (!binding) {
      throw new Error(`[llm-client] unknown model alias: ${modelAlias}`);
    }

    // v0.4.3.1 §C+integration H1: enforce diagnostics precondition BEFORE
    // admission and BEFORE any provider fetch. Runs before disableCircuitBreaker
    // so a caller cannot bypass diagnostics by opting out of the breaker.
    //
    // Two invariants:
    //   1. When requireDiagnostics=true (factory-set on the v0431_active
    //      canary), ctx.collector MUST be present. Otherwise reject.
    //   2. When ctx.collector is present, its requestId MUST equal
    //      ctx.requestId. A mismatch means the collector was cross-wired
    //      between requests — attribution would be silently wrong.
    //
    // Rejection at this point emits ZERO breaker mutations and ZERO fetches:
    // the throw happens before `getBreaker(...).admit()` and before the
    // fast-path fetch call.
    if (this.requireDiagnostics && !ctx?.collector) {
      throw new Error('[llm-client] diagnostics collector required (v0431_active canary precondition)');
    }
    if (ctx?.collector && ctx.collector.requestId !== ctx.requestId) {
      throw new Error(
        `[llm-client] diagnostics collector/request mismatch: collector.requestId=${ctx.collector.requestId} ctx.requestId=${ctx.requestId}`,
      );
    }

    // Fast path: circuit-breaker disabled (tests, or explicit opt-out for
    // legacy baseline runs). Behavior identical to pre-PR-10.
    if (this.disableCircuitBreaker) {
      const started = Date.now();
      // v0.4.3.1 §C+integration H2: per-iteration AttemptEvents flow via
      // the callWithRetry hook; the aggregated BindingSummary is recorded
      // after the retry loop resolves.
      const emit = (iter: number, ok: boolean, elapsed: number, err: unknown) => {
        this.recordAttemptEvent(ctx, {
          requestedAlias: modelAlias,
          attemptAlias: modelAlias,
          route: 'primary',
          iteration: iter,
          ok,
          elapsedMs: elapsed,
          errorCategory: ok ? undefined : categorizeFailure(err),
        });
      };
      try {
        const out = await this.callWithRetry(binding, input, emit);
        const wallClock = Date.now() - started;
        const backoff = out.backoffWaitedMs ?? 0;
        this.recordBindingSummary(ctx, {
          requestedAlias: modelAlias,
          attemptAlias: modelAlias,
          route: 'primary',
          ok: true,
          netLatencyMs: Math.max(0, wallClock - backoff),
          backoffWaitedMs: backoff,
          wallClockMs: wallClock,
          attemptCount: out.attemptCount ?? 1,
        });
        return { ...out, providerRoute: 'primary', attemptAlias: modelAlias };
      } catch (err) {
        const telemetry = readRetryTelemetry(err);
        const wallClock = Date.now() - started;
        const backoff = telemetry?.backoffWaitedMs ?? 0;
        this.recordBindingSummary(ctx, {
          requestedAlias: modelAlias,
          attemptAlias: modelAlias,
          route: 'primary',
          ok: false,
          netLatencyMs: Math.max(0, wallClock - backoff),
          backoffWaitedMs: backoff,
          wallClockMs: wallClock,
          attemptCount: telemetry?.attemptCount ?? 1,
        });
        throw err;
      }
    }

    // K5 admission-safety: verify preconditions BEFORE admit(). A missing
    // API key is a local configuration error, not a provider failure. If
    // we admitted first and then discovered the missing key, a small
    // minSamples could trip the circuit on config errors. Throw here so
    // no token is issued and no sample is recorded.
    this.requireApiKey(binding);

    // Try primary. If its circuit is OPEN, route to fallback alias —
    // UNLESS we're in capital-path mode, where fail-closed is mandatory
    // until v0.4.3 recertifies the fallback alias on the full 100-case suite.
    //
    // v0.4.3.1 §E: admit() returns a token; recordOutcome(token, …) reports
    // the outcome. K5 admission-safety: the recordOutcome call sits inside
    // the try{} after the retry loop so its mutation result is available to
    // the routing decision; a completed-flag catch reports a defensive
    // failure only on pathological throws (e.g. bugs, aborts outside the
    // retry loop) so the probe cannot strand HALF_OPEN.
    const primaryBreaker = this.getBreaker(modelAlias);
    let primaryAdmission;
    try {
      primaryAdmission = primaryBreaker.admit();
    } catch (err) {
      if (err instanceof CircuitOpenError) {
        if (this.capitalPathMode) {
          // Primary was already OPEN, CPM=true → no fetch attempted at all.
          throw new CircuitAllOpenError(
            modelAlias, null, err.reason,
            'capital-path-mode: fallback disabled until v0.4.3 recertification',
            [] // attemptedRoutes: no provider fetch was started
          );
        }
        // Primary was already OPEN; hand off to fallback without a primary
        // fetch. `primaryAttempted=false` propagates through callViaFallback.
        return await this.callViaFallback(modelAlias, binding, input, err.reason, false, ctx);
      }
      throw err;
    }
    // v0.4.3.1 §C: forward any admission-time events (open_to_half_open) to
    // the diagnostics collector before the fetch begins.
    this.recordEventsToCtx(ctx, primaryAdmission.events);

    // Circuit admitted (CLOSED, or HALF_OPEN probe was granted) — primary attempt.
    const started = Date.now();
    let completed = false;
    try {
      let out;
      let ok: boolean;
      let netLatency: number;
      let attemptCount = 1;
      let backoffWaitedMs = 0;
      let retryErr: unknown = null;
      // v0.4.3.1 §C+integration H2: per-iteration AttemptEvents on the
      // primary path.
      const emitPrimary = (iter: number, iterOk: boolean, elapsed: number, iterErr: unknown) => {
        this.recordAttemptEvent(ctx, {
          requestedAlias: modelAlias,
          attemptAlias: modelAlias,
          route: 'primary',
          iteration: iter,
          ok: iterOk,
          elapsedMs: elapsed,
          errorCategory: iterOk ? undefined : categorizeFailure(iterErr),
        });
      };
      try {
        out = await this.callWithRetry(binding, input, emitPrimary);
        const wallClock = Date.now() - started;
        // v0.4.3 CB-latency-fix (PR #11): report NETWORK latency to the
        // circuit-breaker, not wall-clock. Backoff waits are retry-policy
        // delay, not provider processing time.
        backoffWaitedMs = out.backoffWaitedMs ?? 0;
        attemptCount = out.attemptCount ?? 1;
        netLatency = Math.max(0, wallClock - backoffWaitedMs);
        ok = true;
      } catch (err) {
        retryErr = err;
        // v0.4.3.1 §C M1 (latency symmetry): read the annotated telemetry
        // from the retry loop so failure path subtracts backoff waits too.
        const telemetry = readRetryTelemetry(err);
        backoffWaitedMs = telemetry?.backoffWaitedMs ?? 0;
        attemptCount = telemetry?.attemptCount ?? 1;
        const wallClock = Date.now() - started;
        netLatency = Math.max(0, wallClock - backoffWaitedMs);
        ok = false;
        out = undefined;
      }

      // K5: recordOutcome runs inside the try{} so the routing decision
      // below can read the post-mutation state (i.e. whether this outcome
      // just tripped the breaker). v0.4.3.1 §C: mutation events (transitions,
      // stale_result, invalid_outcome) are forwarded to the diagnostics
      // collector.
      const mutation = primaryBreaker.recordOutcome(primaryAdmission.token, {
        ok,
        netLatencyMs: netLatency,
      });
      this.recordEventsToCtx(ctx, mutation.events);
      completed = true;

      // v0.4.3.1 §C+integration H2: BindingSummary for the primary binding
      // (one row per completed callWithRetry, regardless of iteration count).
      const wallClockPrimary = Date.now() - started;
      this.recordBindingSummary(ctx, {
        requestedAlias: modelAlias,
        attemptAlias: modelAlias,
        route: 'primary',
        ok,
        netLatencyMs: netLatency,
        backoffWaitedMs,
        wallClockMs: wallClockPrimary,
        attemptCount,
      });

      if (ok && out) {
        // Stale-success (mutation.accepted === false, e.g. wrong_state): the
        // baseline contract is to serve the successful primary response and
        // leave state unchanged. Events were already forwarded above.
        return { ...out, providerRoute: 'primary', attemptAlias: modelAlias };
      }

      // Failure path: decide fallback vs rethrow based on breaker state
      // AFTER the mutation. This mirrors the pre-§E behavior — the caller
      // shouldn't eat one "cold" failure per trip when the fallback is
      // available and CPM=false.
      const postState = primaryBreaker.snapshot().state;
      if (postState === 'OPEN' || postState === 'HALF_OPEN') {
        if (this.capitalPathMode) {
          throw new CircuitAllOpenError(
            modelAlias,
            null,
            primaryBreaker.snapshot().lastTripReason,
            'capital-path-mode: fallback disabled until v0.4.3 recertification',
            ['primary']
          );
        }
        return await this.callViaFallback(
          modelAlias,
          binding,
          input,
          primaryBreaker.snapshot().lastTripReason,
          true, // primaryAttempted
          ctx,
        );
      }
      // Breaker still CLOSED after ordinary failure → rethrow original error.
      throw retryErr instanceof Error ? retryErr : new Error(String(retryErr));
    } catch (unexpected) {
      // K5 defensive path: recordOutcome did not run (pathological throw
      // before we could reach it). Emit a defensive failure-outcome so the
      // token is consumed and the probe slot is released. This is a
      // last-resort guard; production paths are expected to complete=true.
      if (!completed) {
        try {
          const mutation = primaryBreaker.recordOutcome(primaryAdmission.token, {
            ok: false,
            netLatencyMs: 0,
          });
          // Forward events from the defensive report too — the diagnostics
          // collector never causes control flow, and swallow-on-error is
          // enforced inside recordEventsToCtx.
          this.recordEventsToCtx(ctx, mutation.events);
        } catch {
          // Even the defensive report failing must not mutate the response.
        }
      }
      throw unexpected;
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
    primaryReason: string,
    primaryAttempted: boolean,
    ctx?: CallContext,
  ): Promise<LlmCallOutput> {
    const fallbackAlias = primaryBinding.fallbackAlias ?? null;
    if (!fallbackAlias) {
      // No fallback configured → fail-closed. Provenance mirrors whether
      // the primary was actually attempted or the primary breaker was
      // already OPEN.
      throw new CircuitAllOpenError(
        primaryAlias, null, primaryReason, null,
        primaryAttempted ? ['primary'] : []
      );
    }
    const fallbackBinding = this.modelMap[fallbackAlias];
    if (!fallbackBinding) {
      throw new Error(
        `[llm-client] fallbackAlias '${fallbackAlias}' for '${primaryAlias}' not in modelMap`
      );
    }
    // K5 admission-safety for the fallback binding too. Same reasoning:
    // fail-fast on a missing fallback API key rather than letting an
    // admission→config-error→sample sequence occur.
    this.requireApiKey(fallbackBinding);

    const fallbackBreaker = this.getBreaker(fallbackAlias);
    let fallbackAdmission;
    try {
      fallbackAdmission = fallbackBreaker.admit();
    } catch (err) {
      if (err instanceof CircuitOpenError) {
        // Fallback breaker was already OPEN → no fallback fetch attempted.
        // attemptedRoutes reflects only the primary fetch (if any).
        throw new CircuitAllOpenError(
          primaryAlias,
          fallbackAlias,
          primaryReason,
          err.reason,
          primaryAttempted ? ['primary'] : []
        );
      }
      throw err;
    }
    this.recordEventsToCtx(ctx, fallbackAdmission.events);

    const started = Date.now();
    let completed = false;
    try {
      let out;
      let ok: boolean;
      let netLatency: number;
      let attemptCount = 1;
      let backoffWaitedMs = 0;
      let retryErr: unknown = null;
      // v0.4.3.1 §C+integration H2: per-iteration AttemptEvents on the
      // fallback path.
      const emitFallback = (iter: number, iterOk: boolean, elapsed: number, iterErr: unknown) => {
        this.recordAttemptEvent(ctx, {
          requestedAlias: primaryAlias,
          attemptAlias: fallbackAlias,
          route: 'fallback',
          iteration: iter,
          ok: iterOk,
          elapsedMs: elapsed,
          errorCategory: iterOk ? undefined : categorizeFailure(iterErr),
        });
      };
      try {
        out = await this.callWithRetry(fallbackBinding, input, emitFallback);
        const wallClock = Date.now() - started;
        backoffWaitedMs = out.backoffWaitedMs ?? 0;
        attemptCount = out.attemptCount ?? 1;
        netLatency = Math.max(0, wallClock - backoffWaitedMs);
        ok = true;
      } catch (err) {
        retryErr = err;
        // v0.4.3.1 §C M1 (latency symmetry) on the fallback path too.
        const telemetry = readRetryTelemetry(err);
        backoffWaitedMs = telemetry?.backoffWaitedMs ?? 0;
        attemptCount = telemetry?.attemptCount ?? 1;
        const wallClock = Date.now() - started;
        netLatency = Math.max(0, wallClock - backoffWaitedMs);
        ok = false;
        out = undefined;
      }
      const mutation = fallbackBreaker.recordOutcome(fallbackAdmission.token, {
        ok,
        netLatencyMs: netLatency,
      });
      this.recordEventsToCtx(ctx, mutation.events);
      completed = true;
      const wallClockFallback = Date.now() - started;
      this.recordBindingSummary(ctx, {
        requestedAlias: primaryAlias,
        attemptAlias: fallbackAlias,
        route: 'fallback',
        ok,
        netLatencyMs: netLatency,
        backoffWaitedMs,
        wallClockMs: wallClockFallback,
        attemptCount,
      });
      if (ok && out) {
        return { ...out, providerRoute: 'fallback', attemptAlias: fallbackAlias };
      }
      throw retryErr instanceof Error ? retryErr : new Error(String(retryErr));
    } catch (unexpected) {
      if (!completed) {
        try {
          const mutation = fallbackBreaker.recordOutcome(fallbackAdmission.token, {
            ok: false,
            netLatencyMs: 0,
          });
          this.recordEventsToCtx(ctx, mutation.events);
        } catch {
          // best-effort
        }
      }
      throw unexpected;
    }
  }

  /**
   * v0.4.3.1 §C+integration: forward CircuitBreaker domain events to the
   * request-scoped RuntimeDiagnosticsCollector, if attached. Fully guarded:
   * a missing collector, a null event array, or a throw inside the
   * collector MUST NOT alter the response path.
   */
  private recordEventsToCtx(
    ctx: CallContext | undefined,
    events: readonly CircuitDomainEvent[] | undefined,
  ): void {
    const collector = ctx?.collector;
    if (!collector || !events || events.length === 0) return;
    try {
      collector.recordEvents(events);
    } catch {
      // Diagnostics are observation only — never poison the caller.
    }
  }

  /**
   * v0.4.3.1 §C+integration H2: record ONE per-iteration attempt row per
   * singleCall() iteration. Called from inside callWithRetry's per-iteration
   * hook — both on success and on transient/terminal failure. The row is
   * scoped to the handler-owned requestId (with optional axis/callId).
   */
  private recordAttemptEvent(
    ctx: CallContext | undefined,
    row: Omit<AttemptEvent, 'requestId' | 'axis' | 'callId'>,
  ): void {
    const collector = ctx?.collector;
    if (!collector) return;
    try {
      collector.recordAttempt({
        requestId: ctx.requestId,
        axis: ctx.axis,
        callId: ctx.callId,
        ...row,
      });
    } catch {
      // Never throw from diagnostics.
    }
  }

  /**
   * v0.4.3.1 §C+integration H2: record one per-binding aggregated summary
   * per completed callWithRetry(). Complementary to recordAttemptEvent —
   * attempts give iteration detail, this gives binding totals.
   */
  private recordBindingSummary(
    ctx: CallContext | undefined,
    row: Omit<BindingSummary, 'requestId' | 'axis' | 'callId'>,
  ): void {
    const collector = ctx?.collector;
    if (!collector) return;
    try {
      collector.recordBindingSummary({
        requestId: ctx.requestId,
        axis: ctx.axis,
        callId: ctx.callId,
        ...row,
      });
    } catch {
      // Never throw from diagnostics.
    }
  }

  /**
   * The original retry-loop, extracted so both primary and fallback paths
   * share behavior. Does NOT touch any circuit breaker — caller records
   * outcome on the appropriate breaker.
   */
  /**
   * v0.4.3.1 §C+integration H2: per-iteration hook. Called once per
   * singleCall() iteration inside the retry loop — both on success and
   * on transient/terminal failure. The hook is no-throw at the caller
   * boundary: any throw inside is swallowed to preserve the client's
   * response semantics.
   */
  private async callWithRetry(
    binding: ModelBinding,
    input: LlmCallInput,
    onIteration?: (iteration: number, ok: boolean, elapsedMs: number, err: unknown) => void,
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
    // v0.4.3.1 §C M1 (latency symmetry): count attempts even on the failure
    // path so callers can subtract backoff waits from wall-clock and report
    // a meaningful netLatency to the CircuitBreaker on failure too.
    let attemptCount = 0;
    for (let attempt = 1; attempt <= this.config.maxAttempts; attempt++) {
      attemptCount = attempt;
      const iterStarted = Date.now();
      try {
        const out = await this.singleCall(binding, apiKey, input);
        // Per-iteration hook: success case.
        if (onIteration) {
          try { onIteration(attempt, true, Date.now() - iterStarted, null); }
          catch { /* diagnostics must never poison the caller */ }
        }
        return {
          ...out,
          attemptCount: attempt,
          backoffWaitedMs,
          retryReasons,
        };
      } catch (err) {
        // Per-iteration hook: failure case (transient or terminal).
        if (onIteration) {
          try { onIteration(attempt, false, Date.now() - iterStarted, err); }
          catch { /* diagnostics must never poison the caller */ }
        }
        lastErr = err;
        const msg = err instanceof Error ? err.message : String(err);
        const retryable = RETRYABLE_PATTERN.test(msg);
        if (!retryable || attempt === this.config.maxAttempts) {
          // v0.4.3.1 §C M1: annotate the thrown error with the retry-loop
          // instrumentation so the caller can compute netLatency
          // symmetrically with the success path.
          throw annotateRetryFailure(err, {
            attemptCount,
            backoffWaitedMs,
            retryReasons: [...retryReasons],
          });
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
      // A failed fetch is a provider-interaction failure. Preserve the
      // original message verbatim so RETRYABLE_PATTERN / categorizeFailure /
      // existing message-regex tests behave exactly as before; only the error
      // TYPE changes (→ ProviderCallError) so the engine can attribute
      // structured provider provenance without string-parsing.
      // AbortError from our own timeout still surfaces as a retryable
      // "timeout" message so RETRYABLE_PATTERN picks it up.
      if (err instanceof Error && err.name === 'AbortError') {
        throw new ProviderCallError(
          `[llm-client] request timeout after ${this.config.timeoutMs}ms (aborted)`,
          binding.provider,
          undefined,
          { cause: err },
        );
      }
      const msg = err instanceof Error ? err.message : String(err);
      throw new ProviderCallError(msg, binding.provider, undefined, { cause: err });
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new ProviderCallError(
        `[llm-client] ${binding.provider} ${response.status}: ${body.slice(0, 500)}`,
        binding.provider,
        response.status,
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

  async call(
    modelAlias: string,
    input: LlmCallInput,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _ctx?: CallContext,
  ): Promise<LlmCallOutput> {
    return await this.responder(modelAlias, input);
  }
}
