/**
 * PR #12 (v0.4.3.1 §C.2 + §D): ProductionRuntime — discriminating tests.
 *
 * Contract:
 *   1. The runtime bundle exposes cascade + client + config + configHash +
 *      identity. All fields are populated.
 *   2. `identity.instanceId` and `identity.coldStartAt` are non-empty and
 *      differ across two cold-starts.
 *   3. **Factory-injection identity**: when a test passes `clientOverride`,
 *      the exact instance provided ends up serving cascade calls. Proven
 *      via a scripted client whose per-call responses appear in axis
 *      outputs (this is stronger than an instanceof shape check).
 *   4. Failure mode: missing pot-cli config throws ProductionConfigError
 *      through the runtime factory (i.e. the resolver error is not swallowed).
 *   5. The engine remains client-free: StubCascade paths still work with
 *      no production runtime at all.
 *   6. Response `meta` remains baseline-identical (no stray `runtime` key
 *      until the diagnostics wiring commit).
 */

import { describe, it, expect } from 'vitest';
import {
  createProductionRuntime,
  resolveHealthConfig,
} from './production-runtime.js';
import { HttpLlmClient } from './llm-client.js';
import { PotCliCascade } from './cascade-pot.js';
import { runVerification } from './index.js';
import { StubCascade } from './cascade.js';
import { SandboxCascade } from './sandbox-cascade.js';
import { ProductionConfigError } from './production-config.js';
import type { LlmClient, LlmCallInput, LlmCallOutput } from './llm-client.js';
import type { CallContext } from './call-context.js';
import type { DqlRequest } from '../types.js';

const req: Required<Omit<DqlRequest, 'context'>> & Pick<DqlRequest, 'context'> = {
  mandate: 'noop',
  proposed_action: 'noop',
  reasoning: 'noop',
  axes: ['intent', 'scope', 'risk', 'consistency', 'reversibility'],
  sandbox: false,
  context: undefined,
};

const potCliEnv = () =>
  ({
    SERV_API_KEY: 'sk-test',
    DQL_CAPITAL_PATH_MODE: '0',
  }) as unknown as NodeJS.ProcessEnv;

// ---------------------------------------------------------------------------
// A minimally-scripted LlmClient used to prove factory-injection identity.
// It returns a caller-supplied "marker" verdict so we can assert that this
// exact instance served the request — not merely an instance of a shape-
// compatible class.
// ---------------------------------------------------------------------------
class ScriptedClient implements LlmClient {
  public callCount = 0;
  public seenAliases: string[] = [];
  constructor(private readonly markerAlias: string) {}
  async call(
    modelAlias: string,
    _input: LlmCallInput,
    _ctx?: CallContext,
  ): Promise<LlmCallOutput> {
    this.callCount++;
    this.seenAliases.push(modelAlias);
    // Return a valid JSON payload the axis parser will accept, with a
    // per-instance marker embedded in `reasoning`. If a different client
    // served the call, the marker never appears in axis.reasoning.
    const raw = JSON.stringify({
      verdict: 'PASS',
      confidence: 0.9,
      reasoning: `MARKER:${this.markerAlias}:${modelAlias}`,
      objection: '',
    });
    return {
      raw,
      modelUsed: modelAlias,
      latencyMs: 0,
      providerRoute: 'primary',
      attemptCount: 1,
      backoffWaitedMs: 0,
      retryReasons: [],
    };
  }
}

describe('PR #12 §C.2 + §D — ProductionRuntime bundle', () => {
  it('createProductionRuntime returns cascade + client + config + configHash + identity', () => {
    const runtime = createProductionRuntime(potCliEnv());

    expect(runtime.cascade).toBeInstanceOf(PotCliCascade);
    expect(runtime.client).toBeInstanceOf(HttpLlmClient);
    expect(runtime.config.runtime_mode).toBe('pot-cli');
    expect(runtime.config.capital_path_mode).toBe(false);
    expect(runtime.configHash).toMatch(/^[0-9a-f]{64}$/);
    expect(runtime.identity.instanceId).toMatch(/^[0-9a-f]{16}$/);
    expect(runtime.identity.coldStartAt).toBeGreaterThan(0);
  });

  it('two cold starts produce distinct instanceId values', () => {
    const r1 = createProductionRuntime(potCliEnv());
    const r2 = createProductionRuntime(potCliEnv());
    expect(r1.identity.instanceId).not.toBe(r2.identity.instanceId);
    // With identical env the config-hash must be identical.
    expect(r1.configHash).toBe(r2.configHash);
  });

  it('missing DQL_CAPITAL_PATH_MODE surfaces as ProductionConfigError from factory (not swallowed)', () => {
    const env = { SERV_API_KEY: 'sk-test' } as unknown as NodeJS.ProcessEnv;
    let caught: unknown = null;
    try {
      createProductionRuntime(env);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ProductionConfigError);
  });

  it('resolveHealthConfig admits stub env without SERV_API_KEY', () => {
    const { config, configHash } = resolveHealthConfig(
      {} as unknown as NodeJS.ProcessEnv,
    );
    expect(config.runtime_mode).toBe('stub');
    expect(config.serv_api_key_bound).toBe(false);
    expect(configHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('factory-injection identity: the exact scripted client instance is wired into the cascade', async () => {
    // Stronger than instanceOf: we prove the SAME instance is called, by
    // observing a per-instance marker in raw output.
    const scripted = new ScriptedClient('scripted-1');
    const runtime = createProductionRuntime(potCliEnv(), {
      clientOverride: scripted,
      identityOverride: { instanceId: 'test-instance', coldStartAt: 1 },
    });
    expect(runtime.client).toBe(scripted); // same reference

    const response = await runVerification({
      request: req,
      cascade: runtime.cascade,
      sandboxCascade: new SandboxCascade(),
      requestId: 'dql_test_injection',
      version: '0.4.3.1-test',
    });

    // The scripted client fired at least once per axis call.
    expect(scripted.callCount).toBeGreaterThan(0);
    // Every axis served by our scripted client carries the marker in the
    // parsed reasoning (parse-through evidence stronger than instanceof).
    for (const axis of response.axes) {
      expect(axis.reasoning).toContain('MARKER:scripted-1');
    }
    // Identity is stable across the run.
    expect(runtime.identity.instanceId).toBe('test-instance');
  });

  it('engine runs against StubCascade with no production runtime at all', async () => {
    const response = await runVerification({
      request: req,
      cascade: new StubCascade(),
      sandboxCascade: new SandboxCascade(),
      requestId: 'dql_test_stub_no_runtime',
      version: '0.4.3.1-test',
    });
    expect(response.id).toBe('dql_test_stub_no_runtime');
    expect(response.axes).toHaveLength(5);
    for (const axis of response.axes) {
      expect(axis.verdict).toBe('UNCERTAIN');
    }
  });

  it('DqlResponse shape stays baseline-identical when no diagnostics are wired', async () => {
    const response = await runVerification({
      request: req,
      cascade: new StubCascade(),
      sandboxCascade: new SandboxCascade(),
      requestId: 'dql_test_shape_stable',
      version: '0.4.3.1-test',
    });

    const metaKeys = Object.keys(response.meta).sort();
    expect(metaKeys).toEqual(
      ['axes_evaluated', 'duration_ms', 'models_used', 'sandbox'].sort(),
    );
    expect(response.meta).not.toHaveProperty('runtime');
  });
});
