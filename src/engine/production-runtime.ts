/**
 * ProductionRuntime — the cold-start bundle for the DQL production API.
 *
 * v0.4.3.1 §C.2 amendment: the generic Engine (src/engine/index.ts) must
 * remain unaware of HttpLlmClient and its circuit-breaker internals. That
 * knowledge lives here, exclusively behind the DQL_CASCADE=pot-cli path.
 * The Handler (api/dql/verify.ts) constructs a ProductionRuntime once at
 * cold-start and holds it in module scope; per-request work reads
 * `runtime.cascade` (for the engine) and `runtime.client` (for the
 * isolate-scope circuit-breaker snapshot in meta.runtime — wired in a
 * follow-up commit).
 *
 * Stub/Sandbox paths do NOT get a ProductionRuntime. The engine's ability
 * to run against StubCascade or SandboxCascade is untouched.
 *
 * This file is intentionally small and side-effect-free at import time.
 * `createProductionRuntime` reads env once and constructs the bundle.
 */

import crypto from 'node:crypto';
import {
  HttpLlmClient,
  type HttpLlmClientConfig,
  type ModelBinding,
} from './llm-client.js';
import type { LlmClient } from './llm-client.js';
import { PotCliCascade } from './cascade-pot.js';
import type { Cascade } from './cascade.js';
import type { CircuitBreakerConfig } from './circuit-breaker.js';
import {
  resolveProductionConfig,
  computeConfigHash,
  KNOWN_ALIASES,
  type ProductionConfig,
  type KnownAlias,
} from './production-config.js';

/**
 * Everything the production request path needs, resolved once at cold-start.
 *
 * `cascade` and `client` are wired together: `cascade` was constructed with
 * `client` as its LLM adapter. The Handler can read `client` directly to
 * fetch circuit-breaker snapshots for diagnostics without downcasting the
 * generic Cascade — the Engine never touches `client`.
 */
export interface ProductionRuntime {
  cascade: Cascade;
  client: LlmClient;
  /**
   * Fully-resolved, validated config used to construct this runtime.
   * The value hashed into `configHash` is derived from EXACTLY these
   * fields — no secret ever appears here.
   */
  config: ProductionConfig;
  /** Deterministic SHA-256 of the canonicalised config. */
  configHash: string;
  /** Non-secret identity for /dql/health and cross-service correlation. */
  identity: {
    /** Per-cold-start random id — stable for the life of this bundle. */
    instanceId: string;
    /** ms since epoch of the cold-start moment. */
    coldStartAt: number;
  };
}

/**
 * Optional overrides for tests: injecting a controlled client lets a test
 * prove that the exact instance the factory returns is the SAME instance
 * that ends up serving cascade calls. Production callers omit all fields.
 */
/**
 * Test-only whitelist of HttpLlmClientConfig fields the factory allows
 * callers to inject via `clientOptionsOverride`. Deliberately EXCLUDES
 * every safety-relevant knob:
 *   - `capitalPathMode`             — set from resolver
 *   - `circuitBreakerConfig(ByAlias)` — set from resolver + v0431_active gate
 *   - `disableCircuitBreaker`       — set from resolver
 * Only instrumental fields (clock, fetch, sleep, retry/timing knobs) are
 * exposed here so tests cannot silently subvert the safety posture the
 * factory just wired. This is the Hermes design-hint fix (post-260d125
 * review) that replaces the previous `Record<string, unknown>`.
 */
export interface ClientOptionsOverride {
  /** Test override for global fetch. */
  fetchImpl?: HttpLlmClientConfig['fetchImpl'];
  /** Test override for backoff sleep. */
  sleep?: HttpLlmClientConfig['sleep'];
  /** Test override for per-request timeout. */
  timeoutMs?: HttpLlmClientConfig['timeoutMs'];
  /** Test override for max retry attempts. */
  maxAttempts?: HttpLlmClientConfig['maxAttempts'];
  /** Test override for base backoff. */
  backoffBaseMs?: HttpLlmClientConfig['backoffBaseMs'];
  /** Test override for backoff cap. */
  backoffCapMs?: HttpLlmClientConfig['backoffCapMs'];
}

export interface CreateProductionRuntimeOptions {
  /** Test override for the LlmClient. */
  clientOverride?: LlmClient;
  /** Test override for identity clock/randomness. */
  identityOverride?: { instanceId: string; coldStartAt: number };
  /**
   * Test-only extra options merged into the HttpLlmClientConfig the factory
   * uses. Enables tests to inject `fetchImpl` / `sleep` / retry knobs
   * WITHOUT bypassing the factory's own wiring of `serv_base_url`,
   * per-alias CB, `capital_path_mode`, and `disable_circuit_breaker`.
   * The whitelisted shape (`ClientOptionsOverride`) intentionally omits
   * every safety-relevant field; the factory further re-applies safety
   * options AFTER the override so a stray override can never win over
   * resolver-derived safety knobs (Hermes design-hint fix, post-260d125).
   * Production callers omit this field.
   */
  clientOptionsOverride?: ClientOptionsOverride;
}

/**
 * Construct the cold-start production bundle.
 *
 * The `env` argument is threaded through explicitly (instead of reading
 * `process.env` directly) so tests can construct a runtime with a
 * controlled environment. Production callers pass `process.env`.
 *
 * When `opts.clientOverride` is provided (tests only), that exact instance
 * is passed to `PotCliCascade` and stored on the returned bundle. This
 * enables a discriminating identity assertion that observes the wired
 * client through cascade output.
 *
 * Errors:
 *   - Throws `ProductionConfigError` when resolution fails (from
 *     `resolveProductionConfig`). Callers upstream (handler cold-start)
 *     should catch and surface as a 503 on /dql/health.
 */
export function createProductionRuntime(
  env: NodeJS.ProcessEnv,
  opts: CreateProductionRuntimeOptions = {},
): ProductionRuntime {
  const config = resolveProductionConfig(env, { requiredMode: 'pot-cli' });
  const configHash = computeConfigHash(config);
  const bindings = resolveModelBindings(config);

  // B2 (Hermes 2026-07-11): per-alias CB knobs are ONLY wired into the
  // client when v0431_active=true. With the canary flag OFF the client
  // uses the PR #10 global default (baseline behaviour), preserving the
  // shadow-mode contract byte-identically. With v0431_active=true the
  // resolver has already required an explicit DQL_CB_CONFIG_BY_ALIAS for
  // every known alias — no unkalibrated per-alias values slip through.
  const cbByAliasForClient: Record<string, CircuitBreakerConfig> | undefined =
    config.v0431_active ? resolveCbByAlias(config) : undefined;

  // v0.4.3.1 hardening: capital_path_mode, per-alias CB config and the
  // validated ModelBindings all flow through EXPLICITLY. No silent default
  // and no reliance on the ambient DEFAULT_MODEL_MAP anywhere below.
  // Instrumental timeout/retry knobs from resolver. Applied as DEFAULTS so
  // clientOptionsOverride (tests) can still pin maxAttempts/timeoutMs.
  const deadlineClientOptions = {
    timeoutMs: config.attempt_timeout_ms,
    maxAttempts: config.max_attempts,
    backoffBaseMs: config.backoff_base_ms,
    backoffCapMs: config.backoff_cap_ms,
  };
  // Safety options — always win over override.
  const safetyClientOptions = {
    capitalPathMode: config.capital_path_mode,
    circuitBreakerConfigByAlias: cbByAliasForClient,
    disableCircuitBreaker: config.disable_circuit_breaker,
    // v0.4.3.1 §C+integration H1: enforce diagnostics precondition on
    // every call() when the canary is active AND diagnostics_on=true.
    requireDiagnostics: config.v0431_active && config.diagnostics_on,
  };
  // Order: deadline defaults → test/instrumental override → safety last.
  const mergedClientOptions: HttpLlmClientConfig = {
    ...deadlineClientOptions,
    ...(opts.clientOptionsOverride ?? {}),
    ...safetyClientOptions,
  };

  const client =
    opts.clientOverride ??
    new HttpLlmClient(bindings, env, mergedClientOptions);

  // B1 (Hermes 2026-07-11): confirm_fail is now REALLY wired into the
  // cascade. Previously the resolver hashed it but the cascade fell back
  // to its own env read; this closes that invariant gap.
  const cascade = new PotCliCascade(client, {
    confirmFail: config.confirm_fail,
  });
  const identity = opts.identityOverride ?? {
    instanceId: crypto.randomBytes(8).toString('hex'),
    coldStartAt: Date.now(),
  };
  return { cascade, client, config, configHash, identity };
}

/**
 * Stub-mode variant of the runtime factory. Used by the /dql/health
 * endpoint when it needs to answer WITHOUT contacting a provider. Callers
 * that expect real cascade behavior MUST use createProductionRuntime.
 */
export function resolveHealthConfig(env: NodeJS.ProcessEnv): {
  config: ProductionConfig;
  configHash: string;
} {
  const config = resolveProductionConfig(env, { requiredMode: 'stub' });
  return { config, configHash: computeConfigHash(config) };
}

/**
 * Build the ModelBinding map from resolved config so the client's fetch
 * URL is exactly `config.serv_base_url` — not a stale value captured at
 * module-load time by DEFAULT_MODEL_MAP.
 *
 * All KNOWN_ALIASES (nano + swift) receive the same normalised base URL
 * and cross-alias fallback wiring per PR #10.
 */
export function resolveModelBindings(
  config: ProductionConfig,
): Record<string, ModelBinding> {
  // In stub mode with no override, servBaseUrl is null; keep the OpenServ
  // default so the client can still be constructed. HttpLlmClient will
  // never actually reach out because the caller uses StubCascade in that
  // path (see api/dql/verify.ts).
  const baseUrl =
    config.serv_base_url ?? 'https://inference-api.openserv.ai/v1';
  return {
    'serv-nano': {
      provider: 'serv',
      modelId: 'serv-nano',
      apiKeyEnv: 'SERV_API_KEY',
      baseUrl,
      fallbackAlias: 'serv-swift',
    },
    'serv-swift': {
      provider: 'serv',
      modelId: 'serv-swift',
      apiKeyEnv: 'SERV_API_KEY',
      baseUrl,
      fallbackAlias: 'serv-nano',
    },
  };
}

/**
 * Translate the resolver's per-alias CB knobs into the HttpLlmClient's
 * `circuitBreakerConfigByAlias` shape. Field names align 1:1 today; this
 * indirection keeps a single boundary point for future divergence.
 */
export function resolveCbByAlias(
  config: ProductionConfig,
): Record<string, CircuitBreakerConfig> {
  const out: Record<string, CircuitBreakerConfig> = {};
  for (const alias of KNOWN_ALIASES) {
    const src = config.circuit_breaker_config_by_alias[alias as KnownAlias];
    out[alias] = {
      tripP90LatencyMs: src.tripP90LatencyMs,
      tripFailureRate: src.tripFailureRate,
      cooldownMs: src.cooldownMs,
      windowSize: src.windowSize,
      windowAgeMs: src.windowAgeMs,
      minSamples: src.minSamples,
      probeMaxLatencyMs: src.probeMaxLatencyMs,
    };
  }
  return out;
}
