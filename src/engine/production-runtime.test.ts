/**
 * PR #12 (v0.4.3.1 §C.2): ProductionRuntime — discriminating tests.
 *
 * The generic Engine must remain unaware of HttpLlmClient. The bundle
 * created by `createProductionRuntime` wires cascade and client together
 * so the Handler can access the client for diagnostics without downcasting
 * the generic Cascade.
 *
 * Three claims:
 *   1. The runtime exposes both `cascade` and `client` as concrete objects.
 *   2. StubCascade + SandboxCascade continue to run through the engine
 *      without any client-side dependency (engine remains generic).
 *   3. Diagnostics OFF path (which will be added in the follow-up commit)
 *      does not change DqlResponse shape today.
 */

import { describe, it, expect } from 'vitest';
import { createProductionRuntime } from './production-runtime.js';
import { HttpLlmClient } from './llm-client.js';
import { PotCliCascade } from './cascade-pot.js';
import { runVerification } from './index.js';
import { StubCascade } from './cascade.js';
import { SandboxCascade } from './sandbox-cascade.js';
import type { DqlRequest } from '../types.js';

const req: Required<Omit<DqlRequest, 'context'>> & Pick<DqlRequest, 'context'> = {
  mandate: 'noop',
  proposed_action: 'noop',
  reasoning: 'noop',
  axes: ['intent', 'scope', 'risk', 'consistency', 'reversibility'],
  sandbox: false,
  context: undefined,
};

describe('PR #12 §C.2 — ProductionRuntime bundle', () => {
  it('createProductionRuntime returns cascade + client with correct concrete types', () => {
    const env = { SERV_API_KEY: 'sk-test' } as unknown as NodeJS.ProcessEnv;
    const runtime = createProductionRuntime(env);

    // Both fields are present and typed correctly. This is a shape check
    // — it does NOT prove `cascade` uses THIS specific client instance.
    // A true injection identity test needs a hook the factory does not
    // currently expose. Once resolveProductionConfig lands, this test will
    // be replaced by a discriminating identity assertion that observes the
    // client via a scripted response (see engine-provider-outcome tests
    // for the pattern).
    expect(runtime.cascade).toBeInstanceOf(PotCliCascade);
    expect(runtime.client).toBeInstanceOf(HttpLlmClient);

    // v0.4.3.1 §C.2-note (Hermes 2026-07-11): the `_env` argument is
    // currently ignored by createProductionRuntime. Do not rely on this
    // test as evidence of controlled env wiring — that will land with
    // resolveProductionConfig / computeConfigHash in the next commit.
  });

  it('engine runs against StubCascade with no production runtime at all', async () => {
    // The engine must not assume the presence of a client-bearing runtime.
    // This asserts the engine has no hidden dependency on HttpLlmClient.
    const response = await runVerification({
      request: req,
      cascade: new StubCascade(),
      sandboxCascade: new SandboxCascade(),
      requestId: 'dql_test_stub_no_runtime',
      version: '0.4.3.1-test',
    });
    expect(response.id).toBe('dql_test_stub_no_runtime');
    expect(response.axes).toHaveLength(5);
    // The Stub returns UNCERTAIN for all axes; the engine successfully
    // aggregates without ever touching a client.
    for (const axis of response.axes) {
      expect(axis.verdict).toBe('UNCERTAIN');
    }
  });

  it('DqlResponse shape stays baseline-identical when no diagnostics are wired', async () => {
    // Diagnostics OFF path: response.meta contains ONLY the fields the
    // v0.4.3 baseline defines. No stray `runtime` key today.
    const response = await runVerification({
      request: req,
      cascade: new StubCascade(),
      sandboxCascade: new SandboxCascade(),
      requestId: 'dql_test_shape_stable',
      version: '0.4.3.1-test',
    });

    const metaKeys = Object.keys(response.meta).sort();
    expect(metaKeys).toEqual(['axes_evaluated', 'duration_ms', 'models_used', 'sandbox'].sort());
    // No `runtime` field yet — will land in the diagnostics wiring commit.
    expect(response.meta).not.toHaveProperty('runtime');
  });
});
