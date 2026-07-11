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
import { HttpLlmClient } from './llm-client.js';
import type { LlmClient } from './llm-client.js';
import { PotCliCascade } from './cascade-pot.js';
import type { Cascade } from './cascade.js';
import {
  resolveProductionConfig,
  computeConfigHash,
  type ProductionConfig,
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
 * that ends up serving cascade calls. Production callers omit both fields.
 */
export interface CreateProductionRuntimeOptions {
  /** Test override for the LlmClient. */
  clientOverride?: LlmClient;
  /** Test override for identity clock/randomness. */
  identityOverride?: { instanceId: string; coldStartAt: number };
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
  // v0.4.3.1 §D: capital_path_mode is passed EXPLICITLY into the client.
  // No `?? false` silent default at any layer below this line.
  const client =
    opts.clientOverride ??
    new HttpLlmClient(undefined, env, {
      capitalPathMode: config.capital_path_mode,
    });
  const cascade = new PotCliCascade(client);
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
