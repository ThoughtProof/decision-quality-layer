/**
 * PR #12 v0.4.3.1 hardening: ProductionRuntime wiring — discriminating tests.
 *
 * Contract (updated for Hermes hardening review):
 *   1. Bundle exposes cascade + client + config + configHash + identity.
 *   2. runtime.client === scripted (direct-reference invariant, cheap).
 *   3. Marker propagates through cascade → engine → axis.reasoning
 *      (behavioural evidence that this exact instance served the call).
 *   4. SERV_BASE_URL is actually WIRED through: a custom fetchImpl injected
 *      into HttpLlmClient sees fetch calls whose URL begins with the
 *      config's normalised URL.
 *   5. Per-alias CB knobs are actually WIRED: nano and swift breakers
 *      report distinct config values via their snapshots (proxy: they
 *      would trip at different p90 latencies).
 *   6. Missing pot-cli config surfaces as ProductionConfigError from
 *      the factory (not swallowed).
 *   7. Engine remains client-free (StubCascade path stays usable).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  createProductionRuntime,
  resolveHealthConfig,
  resolveModelBindings,
  resolveCbByAlias,
} from './production-runtime.js';
import { HttpLlmClient, type LlmClient, type LlmCallInput, type LlmCallOutput } from './llm-client.js';
import { PotCliCascade } from './cascade-pot.js';
import { runVerification } from './index.js';
import { StubCascade } from './cascade.js';
import { SandboxCascade } from './sandbox-cascade.js';
import {
  ProductionConfigError,
  computeConfigHash,
  resolveProductionConfig,
} from './production-config.js';
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

/**
 * B1 (Hermes 2026-07-11) test double: HIGH-FAIL primary + always-PASS
 * fallback. The cascade decides based on the primary's verdict + confidence
 * whether to consult the fallback — with confirmFail=true, a low-confidence
 * FAIL must trigger a fallback call. With confirmFail=false, exactly one
 * primary call, no fallback. Distinct MARKERs let us also verify the
 * config_hash view of the two runs would differ.
 */
class ConfirmFailProbeClient implements LlmClient {
  public seenAliases: string[] = [];
  async call(modelAlias: string): Promise<LlmCallOutput> {
    this.seenAliases.push(modelAlias);
    const isPrimary = modelAlias === 'serv-nano';
    // Primary returns a HIGH-confidence FAIL (0.9 > earlyExitFailConfidence
    // default 0.7). Secondary would ratify with PASS if consulted.
    //   confirmFail=false → early-exit → 1 call total (serv-nano).
    //   confirmFail=true  → secondary consulted → 2 calls total.
    const raw = JSON.stringify({
      verdict: isPrimary ? 'FAIL' : 'PASS',
      confidence: 0.9,
      reasoning: `probe:${modelAlias}`,
      objection: '',
    });
    return {
      raw,
      modelUsed: modelAlias,
      latencyMs: 0,
      providerRoute: isPrimary ? 'primary' : 'fallback',
      attemptCount: 1,
      backoffWaitedMs: 0,
      retryReasons: [],
    };
  }
}

describe('PR #12 §D-hardening — ProductionRuntime bundle', () => {
  it('exposes cascade + client + config + configHash + identity', () => {
    const runtime = createProductionRuntime(potCliEnv());
    expect(runtime.cascade).toBeInstanceOf(PotCliCascade);
    expect(runtime.client).toBeInstanceOf(HttpLlmClient);
    expect(runtime.config.runtime_mode).toBe('pot-cli');
    expect(runtime.configHash).toMatch(/^[0-9a-f]{64}$/);
    expect(runtime.identity.instanceId).toMatch(/^[0-9a-f]{16}$/);
    expect(runtime.identity.coldStartAt).toBeGreaterThan(0);
  });

  it('two cold starts → distinct instanceId, identical configHash for identical env', () => {
    const r1 = createProductionRuntime(potCliEnv());
    const r2 = createProductionRuntime(potCliEnv());
    expect(r1.identity.instanceId).not.toBe(r2.identity.instanceId);
    expect(r1.configHash).toBe(r2.configHash);
  });

  it('missing DQL_CAPITAL_PATH_MODE surfaces as ProductionConfigError (code CONFIG_INVALID)', () => {
    const env = { SERV_API_KEY: 'sk-test' } as unknown as NodeJS.ProcessEnv;
    let caught: unknown = null;
    try {
      createProductionRuntime(env);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ProductionConfigError);
    expect((caught as ProductionConfigError).code).toBe('CONFIG_INVALID');
  });

  it('resolveHealthConfig admits stub env without SERV_API_KEY', () => {
    const { config, configHash } = resolveHealthConfig(
      {} as unknown as NodeJS.ProcessEnv,
    );
    expect(config.runtime_mode).toBe('stub');
    expect(configHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('factory injection identity: runtime.client === scripted (direct invariant)', () => {
    const scripted = new ScriptedClient('scripted-A');
    const runtime = createProductionRuntime(potCliEnv(), {
      clientOverride: scripted,
      identityOverride: { instanceId: 't', coldStartAt: 1 },
    });
    // Cheap direct assertion Hermes explicitly requested alongside the
    // behavioural marker check.
    expect(runtime.client).toBe(scripted);
  });

  it('factory injection identity: MARKER from scripted client reaches every axis.reasoning', async () => {
    const scripted = new ScriptedClient('scripted-B');
    const runtime = createProductionRuntime(potCliEnv(), {
      clientOverride: scripted,
      identityOverride: { instanceId: 't', coldStartAt: 1 },
    });
    const response = await runVerification({
      request: req,
      cascade: runtime.cascade,
      sandboxCascade: new SandboxCascade(),
      requestId: 'dql_test_marker',
      version: '0.4.3.1-test',
    });
    expect(scripted.callCount).toBeGreaterThan(0);
    for (const axis of response.axes) {
      expect(axis.reasoning).toContain('MARKER:scripted-B');
    }
  });
});

describe('PR #12 §D-hardening — SERV_BASE_URL wiring (Blocker 2)', () => {
  it('resolveModelBindings uses config.serv_base_url exactly', () => {
    const config = resolveProductionConfig(
      {
        SERV_API_KEY: 'sk-test',
        DQL_CAPITAL_PATH_MODE: '0',
        SERV_BASE_URL: 'https://example.test/v1',
      } as unknown as NodeJS.ProcessEnv,
      { requiredMode: 'pot-cli' },
    );
    const bindings = resolveModelBindings(config);
    expect(bindings['serv-nano']!.baseUrl).toBe('https://example.test/v1');
    expect(bindings['serv-swift']!.baseUrl).toBe('https://example.test/v1');
  });

  it('HttpLlmClient constructed via the factory ACTUALLY fetches from config.serv_base_url', async () => {
    // Inject a mock fetchImpl and observe the URL the client requests.
    const observedUrls: string[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
      const url = typeof input === 'string' ? input : input.toString();
      observedUrls.push(url);
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  verdict: 'PASS',
                  confidence: 0.9,
                  reasoning: 'ok',
                  objection: '',
                }),
              },
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as unknown as typeof fetch;

    const config = resolveProductionConfig(
      {
        SERV_API_KEY: 'sk-test',
        DQL_CAPITAL_PATH_MODE: '0',
        SERV_BASE_URL: 'https://example.test/v1',
      } as unknown as NodeJS.ProcessEnv,
      { requiredMode: 'pot-cli' },
    );
    const bindings = resolveModelBindings(config);
    const client = new HttpLlmClient(bindings, { SERV_API_KEY: 'sk-test' } as NodeJS.ProcessEnv, {
      fetchImpl,
      capitalPathMode: false,
    });
    await client.call('serv-nano', {
      system: 's',
      user: 'u',
    });
    expect(observedUrls.length).toBeGreaterThan(0);
    for (const u of observedUrls) {
      expect(u.startsWith('https://example.test/v1')).toBe(true);
    }
  });
});

describe('PR #12 §D-hardening — per-alias CB wiring (Blocker 6)', () => {
  it('resolveCbByAlias emits distinct records for nano and swift', () => {
    const config = resolveProductionConfig(
      {
        SERV_API_KEY: 'sk-test',
        DQL_CAPITAL_PATH_MODE: '0',
        DQL_CB_CONFIG_BY_ALIAS: JSON.stringify({
          'serv-nano': { tripP90LatencyMs: 4000 },
          'serv-swift': { tripP90LatencyMs: 20000 },
        }),
      } as unknown as NodeJS.ProcessEnv,
      { requiredMode: 'pot-cli' },
    );
    const cb = resolveCbByAlias(config);
    expect(cb['serv-nano']!.tripP90LatencyMs).toBe(4000);
    expect(cb['serv-swift']!.tripP90LatencyMs).toBe(20000);
    expect(cb['serv-nano']!.tripP90LatencyMs).not.toBe(cb['serv-swift']!.tripP90LatencyMs);
  });

  // B3 (Hermes 2026-07-11): the previous "trips at low p90" test was
  // non-discriminating (mocked fetch had ~0ms latency, so both breakers
  // saw the same near-zero p90 and neither actually tripped based on the
  // threshold difference). The new test uses vi.useFakeTimers +
  // vi.setSystemTime to make Date.now() advance by a KNOWN latency per
  // call, then verifies:
  //   1. nano threshold=10ms   → OPEN after two 50ms samples
  //   2. swift threshold=100ms → CLOSED after two 50ms samples
  // Plus a Gegenprobe with SWAPPED thresholds — same input latencies,
  // opposite states — proving the threshold difference is what drives
  // the state, not any external factor.
  describe('B3 — per-alias CB thresholds actually drive state (deterministic)', () => {
    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(1_000_000);
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    async function runTwoCallsPerAlias(
      cbConfigByAlias: NonNullable<
        ConstructorParameters<typeof HttpLlmClient>[2]
      >['circuitBreakerConfigByAlias'],
    ): Promise<Record<string, { state: string; sampleCount: number }>> {
      // fetchImpl: advance the fake clock by 50ms BEFORE returning a valid
      // body. The client wraps its fetch with `Date.now()` before/after —
      // with fake timers, the measured netLatency is exactly 50ms.
      const fetchImpl = vi.fn(async (): Promise<Response> => {
        vi.setSystemTime(Date.now() + 50);
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    verdict: 'PASS',
                    confidence: 0.9,
                    reasoning: 'ok',
                    objection: '',
                  }),
                },
              },
            ],
          }),
          { status: 200 },
        );
      }) as unknown as typeof fetch;

      const bindings = resolveModelBindings(
        resolveProductionConfig(potCliEnv(), { requiredMode: 'pot-cli' }),
      );
      const client = new HttpLlmClient(
        bindings,
        { SERV_API_KEY: 'sk-test' } as NodeJS.ProcessEnv,
        {
          fetchImpl,
          capitalPathMode: false,
          circuitBreakerConfigByAlias: cbConfigByAlias,
        },
      );
      for (let i = 0; i < 2; i++)
        await client.call('serv-nano', { system: 's', user: 'u' });
      for (let i = 0; i < 2; i++)
        await client.call('serv-swift', { system: 's', user: 'u' });
      const snap = client.circuitSnapshot();
      return {
        'serv-nano': { state: snap['serv-nano']!.state, sampleCount: snap['serv-nano']!.sampleCount },
        'serv-swift': { state: snap['serv-swift']!.state, sampleCount: snap['serv-swift']!.sampleCount },
      };
    }

    it('nano threshold=10ms → OPEN; swift threshold=100ms → CLOSED (same 50ms samples)', async () => {
      const snap = await runTwoCallsPerAlias({
        'serv-nano': { tripP90LatencyMs: 10, tripFailureRate: 1, minSamples: 1 },
        'serv-swift': { tripP90LatencyMs: 100, tripFailureRate: 1, minSamples: 1 },
      });
      expect(snap['serv-nano']!.sampleCount).toBeGreaterThan(0);
      expect(snap['serv-swift']!.sampleCount).toBeGreaterThan(0);
      expect(snap['serv-nano']!.state).toBe('OPEN');
      expect(snap['serv-swift']!.state).toBe('CLOSED');
    });

    it('Gegenprobe: swapped thresholds → swift OPEN + nano CLOSED (state follows threshold, not alias)', async () => {
      const snap = await runTwoCallsPerAlias({
        'serv-nano': { tripP90LatencyMs: 100, tripFailureRate: 1, minSamples: 1 },
        'serv-swift': { tripP90LatencyMs: 10, tripFailureRate: 1, minSamples: 1 },
      });
      expect(snap['serv-nano']!.state).toBe('CLOSED');
      expect(snap['serv-swift']!.state).toBe('OPEN');
    });
  });
});

// ---------------------------------------------------------------------------
// B1 (Hermes 2026-07-11) — confirm_fail flows FROM config INTO cascade
// ---------------------------------------------------------------------------
describe('B1 — confirm_fail wiring is behavioural, not just cosmetic', () => {
  const axisInput = {
    axis: 'intent' as const,
    prompt: { system: 's', user: 'u' },
  };

  it('config.confirm_fail=false → exactly 1 primary call on high-confidence FAIL (early-exit)', async () => {
    const probe = new ConfirmFailProbeClient();
    const runtime = createProductionRuntime(potCliEnv(), {
      clientOverride: probe,
      identityOverride: { instanceId: 't', coldStartAt: 1 },
    });
    expect(runtime.config.confirm_fail).toBe(false);
    await runtime.cascade.run(axisInput);
    expect(probe.seenAliases).toEqual(['serv-nano']);
  });

  it('config.confirm_fail=true → secondary is consulted (2 calls) on high-confidence FAIL', async () => {
    const probe = new ConfirmFailProbeClient();
    const env = {
      SERV_API_KEY: 'sk-test',
      DQL_CAPITAL_PATH_MODE: '0',
      DQL_CONFIRM_FAIL: '1',
    } as unknown as NodeJS.ProcessEnv;
    const runtime = createProductionRuntime(env, {
      clientOverride: probe,
      identityOverride: { instanceId: 't', coldStartAt: 1 },
    });
    expect(runtime.config.confirm_fail).toBe(true);
    await runtime.cascade.run(axisInput);
    expect(probe.seenAliases).toEqual(['serv-nano', 'serv-swift']);
  });

  it('config.confirm_fail flip produces DISTINCT configHashes (fingerprint discipline)', () => {
    const rOff = createProductionRuntime(potCliEnv(), {
      identityOverride: { instanceId: 't1', coldStartAt: 1 },
    });
    const envOn = {
      SERV_API_KEY: 'sk-test',
      DQL_CAPITAL_PATH_MODE: '0',
      DQL_CONFIRM_FAIL: '1',
    } as unknown as NodeJS.ProcessEnv;
    const rOn = createProductionRuntime(envOn, {
      identityOverride: { instanceId: 't2', coldStartAt: 1 },
    });
    expect(rOff.configHash).not.toBe(rOn.configHash);
  });
});

// ---------------------------------------------------------------------------
// B2 (Hermes 2026-07-11) — v0431_active gates per-alias CB delivery
// ---------------------------------------------------------------------------
describe('B2 — v0431_active gates per-alias CB delivery to client', () => {
  it('v0431_active=false: per-alias CB behaviour is IDENTICAL to CircuitBreaker global default (byte-equivalent shadow mode)', async () => {
    // Behavioural equivalence: run the SAME sequence of two 50ms samples
    // through both aliases with v0431_active=false. Both breakers use the
    // PR #10 global default (tripP90LatencyMs=15_000, tripFailureRate=0.5,
    // minSamples=5), so neither can trip after two 50ms samples. That is
    // the property v0.4.3 users rely on — the canary flag must not silently
    // change their runtime.
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    try {
      const fetchImpl = vi.fn(async (): Promise<Response> => {
        vi.setSystemTime(Date.now() + 50);
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    verdict: 'PASS',
                    confidence: 0.9,
                    reasoning: 'ok',
                    objection: '',
                  }),
                },
              },
            ],
          }),
          { status: 200 },
        );
      }) as unknown as typeof fetch;
      const runtime = createProductionRuntime(potCliEnv(), {
        clientOptionsOverride: { fetchImpl },
      });
      expect(runtime.config.v0431_active).toBe(false);
      for (let i = 0; i < 2; i++)
        await runtime.client.call('serv-nano', { system: 's', user: 'u' });
      for (let i = 0; i < 2; i++)
        await runtime.client.call('serv-swift', { system: 's', user: 'u' });
      const snap = (runtime.client as HttpLlmClient).circuitSnapshot();
      // Both breakers received the SAME latency samples — in baseline mode
      // they share the SAME threshold, so their states MUST be identical.
      expect(snap['serv-nano']!.state).toBe(snap['serv-swift']!.state);
      expect(snap['serv-nano']!.state).toBe('CLOSED');
      expect(snap['serv-nano']!.sampleCount).toBe(snap['serv-swift']!.sampleCount);
    } finally {
      vi.useRealTimers();
    }
  });

  it('v0431_active=true (with explicit per-alias CB) DOES pass per-alias config to the client', () => {
    const env = {
      SERV_API_KEY: 'sk-test',
      DQL_CAPITAL_PATH_MODE: '1',
      DQL_V0431_ACTIVE: '1',
      DQL_RUNTIME_DIAGNOSTICS: '1',
      DQL_CB_CONFIG_BY_ALIAS: JSON.stringify({
        'serv-nano': { tripP90LatencyMs: 6_000, tripFailureRate: 0.5, cooldownMs: 30_000, windowSize: 20, windowAgeMs: 60_000, minSamples: 5, probeMaxLatencyMs: 15_000 },
        'serv-swift': { tripP90LatencyMs: 20_000, tripFailureRate: 0.5, cooldownMs: 30_000, windowSize: 20, windowAgeMs: 60_000, minSamples: 5, probeMaxLatencyMs: 15_000 },
      }),
    } as unknown as NodeJS.ProcessEnv;
    const runtime = createProductionRuntime(env);
    expect(runtime.config.v0431_active).toBe(true);
    expect(runtime.config.circuit_breaker_config_by_alias['serv-nano'].tripP90LatencyMs).toBe(
      6_000,
    );
  });

  it('v0431_active=false baseline: nano and swift resolver defaults are equal (no shadow-mode drift)', () => {
    const config = resolveProductionConfig(potCliEnv(), { requiredMode: 'pot-cli' });
    expect(config.circuit_breaker_config_by_alias['serv-nano'].tripP90LatencyMs).toBe(
      config.circuit_breaker_config_by_alias['serv-swift'].tripP90LatencyMs,
    );
  });
});

// ---------------------------------------------------------------------------
// M6 (Hermes 2026-07-11) — clientOptionsOverride hook: real factory-owned
// wiring test (previously the SERV_BASE_URL test manually constructed a
// client, bypassing the factory).
// ---------------------------------------------------------------------------
describe('M6 — factory wiring is honest via clientOptionsOverride', () => {
  it('createProductionRuntime with fetchImpl override actually issues fetch to config.serv_base_url', async () => {
    const observedUrls: string[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
      const url = typeof input === 'string' ? input : input.toString();
      observedUrls.push(url);
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  verdict: 'PASS',
                  confidence: 0.9,
                  reasoning: 'ok',
                  objection: '',
                }),
              },
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as unknown as typeof fetch;

    const env = {
      SERV_API_KEY: 'sk-test',
      DQL_CAPITAL_PATH_MODE: '0',
      SERV_BASE_URL: 'https://example.test/v1',
    } as unknown as NodeJS.ProcessEnv;
    const runtime = createProductionRuntime(env, {
      clientOptionsOverride: { fetchImpl },
    });
    await runtime.client.call('serv-nano', { system: 's', user: 'u' });
    expect(observedUrls.length).toBeGreaterThan(0);
    for (const u of observedUrls) {
      expect(u.startsWith('https://example.test/v1')).toBe(true);
    }
  });
});

describe('PR #12 §D-hardening — engine independence', () => {
  it('engine runs against StubCascade with no production runtime', async () => {
    const response = await runVerification({
      request: req,
      cascade: new StubCascade(),
      sandboxCascade: new SandboxCascade(),
      requestId: 'dql_test_stub_no_runtime',
      version: '0.4.3.1-test',
    });
    expect(response.id).toBe('dql_test_stub_no_runtime');
    for (const axis of response.axes) {
      expect(axis.verdict).toBe('UNCERTAIN');
    }
  });

  it('DqlResponse.meta shape stays baseline-identical', async () => {
    const response = await runVerification({
      request: req,
      cascade: new StubCascade(),
      sandboxCascade: new SandboxCascade(),
      requestId: 'dql_test_shape',
      version: '0.4.3.1-test',
    });
    const metaKeys = Object.keys(response.meta).sort();
    expect(metaKeys).toEqual(
      ['axes_evaluated', 'duration_ms', 'models_used', 'sandbox'].sort(),
    );
  });
});

// ---------------------------------------------------------------------------
// Hermes E-core H3: seven-field policy fingerprint — hash flip + behavioral
// counter-proof at the live factory-constructed breaker for EVERY tunable.
// ---------------------------------------------------------------------------
//
// For each of the 7 CB tunables (tripP90LatencyMs, tripFailureRate,
// cooldownMs, windowSize, windowAgeMs, minSamples, probeMaxLatencyMs) this
// block proves TWO things at once:
//   (1) computeConfigHash(configA) !== computeConfigHash(configB) when the
//       ONLY differing input is that field.
//   (2) A discriminating test sequence executed via createProductionRuntime
//       through the real HttpLlmClient produces observably different
//       CircuitBreaker snapshots between configA and configB.
//
// Behavioral counter-proofs use fake timers so latency and cooldown are
// deterministic. The base env is v0431_active=true so the resolver's
// required-per-alias config flows THROUGH resolveCbByAlias INTO the client's
// factory-created CircuitBreaker — which is the wiring path Hermes wants
// proven.
describe('Hermes E-core H3 — seven-field policy fingerprint via factory wiring', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  type CbTunables = {
    tripP90LatencyMs: number;
    tripFailureRate: number;
    cooldownMs: number;
    windowSize: number;
    windowAgeMs: number;
    minSamples: number;
    probeMaxLatencyMs: number;
  };
  const BASE_CB: CbTunables = {
    tripP90LatencyMs: 1_000,
    tripFailureRate: 0.5,
    cooldownMs: 30_000,
    windowSize: 10,
    windowAgeMs: 60_000,
    minSamples: 5,
    probeMaxLatencyMs: 15_000,
  };

  function envWithCb(overrides: {
    nano?: Partial<CbTunables>;
    swift?: Partial<CbTunables>;
  } = {}): NodeJS.ProcessEnv {
    const nanoCb = { ...BASE_CB, ...overrides.nano };
    const swiftCb = { ...BASE_CB, ...overrides.swift };
    return {
      SERV_API_KEY: 'sk-test',
      DQL_CAPITAL_PATH_MODE: '1',
      DQL_V0431_ACTIVE: '1',
      DQL_RUNTIME_DIAGNOSTICS: '1',
      DQL_CB_CONFIG_BY_ALIAS: JSON.stringify({
        'serv-nano': nanoCb,
        'serv-swift': swiftCb,
      }),
    } as unknown as NodeJS.ProcessEnv;
  }

  function hashOf(env: NodeJS.ProcessEnv): string {
    const cfg = resolveProductionConfig(env, { requiredMode: 'pot-cli' });
    return computeConfigHash(cfg);
  }

  // Hermes review round 2 (v0431-e-core-6ca5e61 follow-up): use the REAL
  // createProductionRuntime factory with the whitelisted clientOptionsOverride
  // so the sevenField behavioral counter-proofs traverse the full wiring
  // path Resolver → Factory → Client → Breaker. clientOptionsOverride is
  // typed to only expose instrumental knobs (fetchImpl, sleep, maxAttempts);
  // the factory re-spreads safety-relevant options (capitalPathMode,
  // circuitBreakerConfigByAlias, disableCircuitBreaker) AFTER the override,
  // so this cannot subvert the per-alias CB wiring being tested.
  function buildFactoryClient(
    env: NodeJS.ProcessEnv,
    fetchImpl: typeof fetch,
  ): HttpLlmClient {
    const runtime = createProductionRuntime(env, {
      clientOptionsOverride: {
        fetchImpl,
        // Deterministic under fake timers.
        maxAttempts: 1,
        sleep: async () => {},
      },
    });
    // The factory-built client is our subject of test. Cast to HttpLlmClient
    // so we can call circuitSnapshot / _testOnlyGetBreaker — the interface
    // LlmClient hides these introspection hooks by design.
    return runtime.client as HttpLlmClient;
  }

  function makeCbResponse(): Response {
    return new Response(
      JSON.stringify({
        choices: [{ message: { content: JSON.stringify({ verdict: 'PASS', confidence: 0.9, reasoning: 'ok', objection: '' }) } }],
      }),
      { status: 200 },
    );
  }

  // Fetch that succeeds with configurable synthetic net-latency.
  function slowFetchMs(ms: number): typeof fetch {
    return (async () => {
      vi.setSystemTime(Date.now() + ms);
      return makeCbResponse();
    }) as unknown as typeof fetch;
  }

  // Fetch that always rejects with 'fetch failed'.
  function failingFetch(): typeof fetch {
    return (async () => {
      throw new Error('fetch failed');
    }) as unknown as typeof fetch;
  }

  // ---- Field 1: tripP90LatencyMs -------------------------------------------
  it('field #1 tripP90LatencyMs — hash flip + behavioral: same 500ms samples → lower threshold OPEN, higher CLOSED', async () => {
    const envLow = envWithCb({ nano: { tripP90LatencyMs: 100, minSamples: 2, tripFailureRate: 1 } });
    const envHigh = envWithCb({ nano: { tripP90LatencyMs: 5_000, minSamples: 2, tripFailureRate: 1 } });
    expect(hashOf(envLow)).not.toBe(hashOf(envHigh));

    const clientLow = buildFactoryClient(envLow, slowFetchMs(500));
    for (let i = 0; i < 2; i++) await clientLow.call('serv-nano', { system: 's', user: 'u' });
    expect(clientLow.circuitSnapshot()['serv-nano']!.state).toBe('OPEN');

    vi.setSystemTime(1_000_000);
    const clientHigh = buildFactoryClient(envHigh, slowFetchMs(500));
    for (let i = 0; i < 2; i++) await clientHigh.call('serv-nano', { system: 's', user: 'u' });
    expect(clientHigh.circuitSnapshot()['serv-nano']!.state).toBe('CLOSED');
  });

  // ---- Field 2: tripFailureRate --------------------------------------------
  it('field #2 tripFailureRate — hash flip + behavioral: same 3/5 failure rate → threshold 0.5 OPEN, threshold 0.7 CLOSED', async () => {
    // Sequence: 3 failures then 2 successes with minSamples=5, windowSize=5.
    // Failure rate lands at 3/5 = 60%.
    const envLow = envWithCb({ nano: { tripFailureRate: 0.5, minSamples: 5, windowSize: 5, tripP90LatencyMs: 999_999 } });
    const envHigh = envWithCb({ nano: { tripFailureRate: 0.7, minSamples: 5, windowSize: 5, tripP90LatencyMs: 999_999 } });
    expect(hashOf(envLow)).not.toBe(hashOf(envHigh));

    async function driveSequence(env: NodeJS.ProcessEnv): Promise<string> {
      // 3 failing calls followed by 2 succeeding calls.
      let callIdx = 0;
      const fetchImpl = (async () => {
        callIdx++;
        if (callIdx <= 3) throw new Error('fetch failed');
        return makeCbResponse();
      }) as unknown as typeof fetch;
      const client = buildFactoryClient(env, fetchImpl);
      for (let i = 0; i < 5; i++) {
        try {
          await client.call('serv-nano', { system: 's', user: 'u' });
        } catch {
          // expected for the failing ones — CPM=true isolates from fallback
        }
      }
      return client.circuitSnapshot()['serv-nano']!.state;
    }

    expect(await driveSequence(envLow)).toBe('OPEN');
    vi.setSystemTime(1_000_000);
    expect(await driveSequence(envHigh)).toBe('CLOSED');
  });

  // ---- Field 3: cooldownMs -------------------------------------------------
  it('field #3 cooldownMs — hash flip + behavioral: after 20s wait, short cooldown → HALF_OPEN admit, long → still OPEN reject', async () => {
    const envShort = envWithCb({ nano: { cooldownMs: 10_000, minSamples: 2, tripFailureRate: 1, tripP90LatencyMs: 999_999 } });
    const envLong = envWithCb({ nano: { cooldownMs: 60_000, minSamples: 2, tripFailureRate: 1, tripP90LatencyMs: 999_999 } });
    expect(hashOf(envShort)).not.toBe(hashOf(envLong));

    async function tripAndProbe(env: NodeJS.ProcessEnv): Promise<{ postOpenAdmitOk: boolean }> {
      const client = buildFactoryClient(env, failingFetch());
      // 2 failures trip the primary.
      for (let i = 0; i < 2; i++) {
        try {
          await client.call('serv-nano', { system: 's', user: 'u' });
        } catch {
          // expected
        }
      }
      expect(client.circuitSnapshot()['serv-nano']!.state).toBe('OPEN');
      // Advance 20s.
      vi.setSystemTime(Date.now() + 20_000);
      // Try one more call: with short cooldown, admit succeeds (probe);
      // with long cooldown, admit is rejected as OPEN.
      const cb = client._testOnlyGetBreaker('serv-nano');
      let admitted = false;
      try {
        cb.admit();
        admitted = true;
      } catch {
        admitted = false;
      }
      return { postOpenAdmitOk: admitted };
    }

    expect((await tripAndProbe(envShort)).postOpenAdmitOk).toBe(true);
    vi.setSystemTime(1_000_000);
    expect((await tripAndProbe(envLong)).postOpenAdmitOk).toBe(false);
  });

  // ---- Field 4: windowSize -------------------------------------------------
  it('field #4 windowSize — hash flip + behavioral: same F,S,S,S sequence → window=2 forgets F (CLOSED), window=10 remembers F but sample count differs', async () => {
    // With tripFailureRate=0.99, minSamples=2, tripP90LatencyMs=huge, the
    // failure rate needs to be near 100% to trip — so a single F in a stream
    // of successes NEVER trips either config. This isolates the eviction
    // behavior we want to measure.
    //
    // Sequence: F, S, S, S (4 total).
    //   windowSize=2 → final window = [S, S] → sampleCount = 2, failureRate = 0.
    //   windowSize=10 → final window = [F, S, S, S] → sampleCount = 4, failureRate = 0.25.
    // Discriminator: reported sampleCount differs (2 vs 4).
    const envSmall = envWithCb({ nano: { windowSize: 2, minSamples: 2, tripFailureRate: 0.99, tripP90LatencyMs: 999_999 } });
    const envLarge = envWithCb({ nano: { windowSize: 10, minSamples: 2, tripFailureRate: 0.99, tripP90LatencyMs: 999_999 } });
    expect(hashOf(envSmall)).not.toBe(hashOf(envLarge));

    async function driveFSSS(env: NodeJS.ProcessEnv): Promise<{ state: string; sampleCount: number }> {
      let callIdx = 0;
      const fetchImpl = (async () => {
        callIdx++;
        if (callIdx === 1) throw new Error('fetch failed');
        return makeCbResponse();
      }) as unknown as typeof fetch;
      const client = buildFactoryClient(env, fetchImpl);
      for (let i = 0; i < 4; i++) {
        try { await client.call('serv-nano', { system: 's', user: 'u' }); } catch { /* first call fails */ }
      }
      const s = client.circuitSnapshot()['serv-nano']!;
      return { state: s.state, sampleCount: s.sampleCount };
    }

    const small = await driveFSSS(envSmall);
    vi.setSystemTime(1_000_000);
    const large = await driveFSSS(envLarge);
    // Both configs stay CLOSED (failure rate too low to trip at threshold=0.99).
    expect(small.state).toBe('CLOSED');
    expect(large.state).toBe('CLOSED');
    // Discriminator: retained-sample count differs deterministically.
    expect(small.sampleCount).toBe(2);
    expect(large.sampleCount).toBe(4);
  });

  // ---- Field 5: windowAgeMs ------------------------------------------------
  it('field #5 windowAgeMs — hash flip + behavioral: same time shift → short age evicts, long age retains', async () => {
    const envShort = envWithCb({ nano: { windowAgeMs: 5_000, windowSize: 100, minSamples: 2, tripFailureRate: 0.5, tripP90LatencyMs: 999_999 } });
    const envLong = envWithCb({ nano: { windowAgeMs: 600_000, windowSize: 100, minSamples: 2, tripFailureRate: 0.5, tripP90LatencyMs: 999_999 } });
    expect(hashOf(envShort)).not.toBe(hashOf(envLong));

    async function driveAcrossGap(env: NodeJS.ProcessEnv): Promise<number> {
      let callIdx = 0;
      const fetchImpl = (async () => {
        callIdx++;
        if (callIdx <= 1) throw new Error('fetch failed');
        return makeCbResponse();
      }) as unknown as typeof fetch;
      const client = buildFactoryClient(env, fetchImpl);
      // 1 failure sample
      try { await client.call('serv-nano', { system: 's', user: 'u' }); } catch { /* expected */ }
      // 30 seconds elapse
      vi.setSystemTime(Date.now() + 30_000);
      // 1 success sample — evicts old failure only if windowAgeMs<30_000
      await client.call('serv-nano', { system: 's', user: 'u' });
      return client.circuitSnapshot()['serv-nano']!.sampleCount;
    }

    const shortCount = await driveAcrossGap(envShort);
    vi.setSystemTime(1_000_000);
    const longCount = await driveAcrossGap(envLong);
    // Short age evicts the 30s-old failure, long age retains it → count differs.
    expect(shortCount).toBeLessThan(longCount);
    expect(shortCount).toBe(1);
    expect(longCount).toBe(2);
  });

  // ---- Field 6: minSamples -------------------------------------------------
  it('field #6 minSamples — hash flip + behavioral: 3 failures → minSamples=2 trips, minSamples=5 does not', async () => {
    const envLow = envWithCb({ nano: { minSamples: 2, tripFailureRate: 0.5, windowSize: 10, tripP90LatencyMs: 999_999 } });
    const envHigh = envWithCb({ nano: { minSamples: 5, tripFailureRate: 0.5, windowSize: 10, tripP90LatencyMs: 999_999 } });
    expect(hashOf(envLow)).not.toBe(hashOf(envHigh));

    async function threeFailures(env: NodeJS.ProcessEnv): Promise<string> {
      const client = buildFactoryClient(env, failingFetch());
      for (let i = 0; i < 3; i++) {
        try { await client.call('serv-nano', { system: 's', user: 'u' }); } catch { /* expected */ }
      }
      return client.circuitSnapshot()['serv-nano']!.state;
    }

    expect(await threeFailures(envLow)).toBe('OPEN');
    vi.setSystemTime(1_000_000);
    expect(await threeFailures(envHigh)).toBe('CLOSED');
  });

  // ---- Field 7: probeMaxLatencyMs ------------------------------------------
  it('field #7 probeMaxLatencyMs — hash flip + behavioral: same 500ms probe → threshold 200ms REOPEN, threshold 5s CLOSE', async () => {
    const envTight = envWithCb({ nano: { probeMaxLatencyMs: 200, minSamples: 2, tripFailureRate: 1, cooldownMs: 10_000, tripP90LatencyMs: 999_999 } });
    const envLoose = envWithCb({ nano: { probeMaxLatencyMs: 5_000, minSamples: 2, tripFailureRate: 1, cooldownMs: 10_000, tripP90LatencyMs: 999_999 } });
    expect(hashOf(envTight)).not.toBe(hashOf(envLoose));

    async function tripThenProbeWith500ms(env: NodeJS.ProcessEnv): Promise<string> {
      let callIdx = 0;
      const fetchImpl = (async () => {
        callIdx++;
        if (callIdx <= 2) throw new Error('fetch failed');
        // Probe attempt: 500ms latency.
        vi.setSystemTime(Date.now() + 500);
        return makeCbResponse();
      }) as unknown as typeof fetch;
      const client = buildFactoryClient(env, fetchImpl);
      // Trip: 2 failures.
      for (let i = 0; i < 2; i++) {
        try { await client.call('serv-nano', { system: 's', user: 'u' }); } catch { /* expected */ }
      }
      expect(client.circuitSnapshot()['serv-nano']!.state).toBe('OPEN');
      // Advance past cooldown so admit returns a probe.
      vi.setSystemTime(Date.now() + 11_000);
      // Probe call takes 500ms of synthetic net latency.
      try {
        await client.call('serv-nano', { system: 's', user: 'u' });
      } catch { /* CPM=true rethrows on trip; fine */ }
      return client.circuitSnapshot()['serv-nano']!.state;
    }

    // Tight probe threshold rejects 500ms probe → REOPEN (state=OPEN).
    // Loose probe threshold accepts 500ms probe → CLOSE (state=CLOSED).
    expect(await tripThenProbeWith500ms(envTight)).toBe('OPEN');
    vi.setSystemTime(1_000_000);
    expect(await tripThenProbeWith500ms(envLoose)).toBe('CLOSED');
  });
});
