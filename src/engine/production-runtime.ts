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

import { HttpLlmClient } from './llm-client.js';
import type { LlmClient } from './llm-client.js';
import { PotCliCascade } from './cascade-pot.js';
import type { Cascade } from './cascade.js';

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
   * Non-secret identity of the runtime — for /dql/health and correlation.
   * Populated in the follow-up commit that adds resolveProductionConfig.
   * Reserved as optional for now to keep this commit source-compatible.
   */
  identity?: {
    instanceId: string;
    coldStartAt: number;
  };
}

/**
 * Construct the cold-start production bundle.
 *
 * The `env` argument is threaded through explicitly (instead of reading
 * `process.env` directly) so tests can construct a runtime with a controlled
 * environment. Production callers pass `process.env`.
 *
 * The follow-up commit wires in `resolveProductionConfig(env)` to derive the
 * circuit-breaker per-alias config and CPM value from env. This commit uses
 * the HttpLlmClient defaults so we can prove the wiring shape end-to-end
 * before adding config-resolver complexity.
 */
export function createProductionRuntime(_env: NodeJS.ProcessEnv): ProductionRuntime {
  const client = new HttpLlmClient();
  const cascade = new PotCliCascade(client);
  return { cascade, client };
}
