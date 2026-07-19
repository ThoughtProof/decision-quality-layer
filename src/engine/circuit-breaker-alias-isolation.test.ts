import { describe, it, expect, vi } from 'vitest';
import {
  HttpLlmClient,
  CircuitAllOpenError,
  DeadlineExceededError,
  routeFingerprint,
  routeKeyOf,
  type ModelBinding,
} from './llm-client.js';

/**
 * Phase-1 discriminating tests for per-alias circuit-breaker isolation.
 *
 * These tests prove the invariant the track requires: one alias's breaker
 * opening (or recovering, or probing) can never reject, degrade, or otherwise
 * mutate another alias's breaker. Breaker identity follows the RESOLVED
 * physical route (provider:modelId:baseUrl), not the alias label, so an alias
 * that is remapped to a different model gets a fresh breaker instead of
 * inheriting the prior model's OPEN state. The bounded LRU lifecycle is also
 * exercised (idle-only eviction; live OPEN breakers are never swept).
 *
 * All time is driven by an injected clock so OPEN→HALF_OPEN→CLOSED transitions
 * are deterministic and setTimeout-free.
 */

function makeClock(startAt = 1_000_000): { now: () => number; advance: (ms: number) => void } {
  let t = startAt;
  return { now: () => t, advance: (ms: number) => { t += ms; } };
}

/**
 * Fresh, per-client binding map: two independent aliases with NO cross-alias
 * fallback wiring, so a call to one alias never routes to the other (isolating
 * the breaker-isolation invariant from fallback routing, covered elsewhere).
 * Returned by value each call so a test that mutates its client's modelMap (the
 * alias-resolver-remap case) can never contaminate another test — the client
 * stores the map by reference.
 */
function freshIso(): Record<string, ModelBinding> {
  return {
    'serv-nano': {
      provider: 'serv',
      modelId: 'serv-nano',
      apiKeyEnv: 'SERV_API_KEY',
      baseUrl: 'https://example.test/v1',
    },
    'serv-swift': {
      provider: 'serv',
      modelId: 'serv-swift',
      apiKeyEnv: 'SERV_API_KEY',
      baseUrl: 'https://example.test/v1',
    },
  };
}
const ENV = { SERV_API_KEY: 'sk-test' } as unknown as NodeJS.ProcessEnv;

function okResponse(content = '{"verdict":"PASS","confidence":0.9}'): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

type ModelBehavior = () => Response | Promise<Response>;

/**
 * A fetch mock that dispatches on the request body's `model` field so each
 * physical route (serv-nano vs serv-swift) can be made healthy or failing
 * independently.
 */
function routeDispatchFetch(behaviors: Record<string, ModelBehavior>): {
  fetchImpl: typeof fetch;
  calls: Record<string, number>;
} {
  const calls: Record<string, number> = {};
  const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse((init?.body as string) ?? '{}') as { model?: string };
    const model = body.model ?? '<none>';
    calls[model] = (calls[model] ?? 0) + 1;
    const behavior = behaviors[model];
    if (!behavior) throw new Error(`no fetch behavior for model '${model}'`);
    return behavior();
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

const FAIL: ModelBehavior = () => {
  throw new Error('fetch failed');
};
const OK: ModelBehavior = () => okResponse();

/** Trip config: 2 samples at 100% failure > 0.5 → OPEN; latency never trips. */
function tripConfig(clock: { now: () => number }) {
  return {
    now: clock.now,
    minSamples: 2,
    tripFailureRate: 0.5,
    windowSize: 10,
    tripP90LatencyMs: 999_999,
    cooldownMs: 30_000,
  };
}

async function drive(client: HttpLlmClient, alias: string): Promise<'ok' | Error> {
  try {
    await client.call(alias, { system: 's', user: 'u' });
    return 'ok';
  } catch (err) {
    return err as Error;
  }
}

describe('per-alias circuit-breaker isolation', () => {
  it('nano OPEN, swift healthy: swift calls still succeed and swift breaker stays CLOSED', async () => {
    const clock = makeClock();
    const { fetchImpl, calls } = routeDispatchFetch({ 'serv-nano': FAIL, 'serv-swift': OK });
    const client = new HttpLlmClient(freshIso(), ENV, {
      fetchImpl,
      sleep: vi.fn().mockResolvedValue(undefined),
      maxAttempts: 1,
      circuitBreakerConfig: tripConfig(clock),
    });

    // Two nano failures trip nano OPEN.
    await drive(client, 'serv-nano');
    await drive(client, 'serv-nano');
    expect(client.circuitSnapshot()['serv-nano']?.state).toBe('OPEN');

    // Swift is completely unaffected: it serves normally and its breaker is
    // CLOSED with only its OWN samples.
    for (let i = 0; i < 3; i++) {
      const out = await client.call('serv-swift', { system: 's', user: 'u' });
      expect(out.providerRoute).toBe('primary');
      expect(out.modelUsed).toBe('serv:serv-swift');
    }
    const swift = client.circuitSnapshot()['serv-swift'];
    expect(swift?.state).toBe('CLOSED');
    expect(swift?.sampleCount).toBe(3);
    expect(calls['serv-swift']).toBe(3);

    // A nano call while nano is OPEN fails closed WITHOUT starting a fetch,
    // and still does not touch swift.
    const err = await drive(client, 'serv-nano');
    expect(err).toBeInstanceOf(CircuitAllOpenError);
    expect((err as CircuitAllOpenError).attemptedRoutes).toEqual([]);
    expect(client.circuitSnapshot()['serv-swift']?.state).toBe('CLOSED');
  });

  it('swift OPEN, nano healthy: symmetric — nano serves and nano breaker stays CLOSED', async () => {
    const clock = makeClock();
    const { fetchImpl } = routeDispatchFetch({ 'serv-nano': OK, 'serv-swift': FAIL });
    const client = new HttpLlmClient(freshIso(), ENV, {
      fetchImpl,
      sleep: vi.fn().mockResolvedValue(undefined),
      maxAttempts: 1,
      circuitBreakerConfig: tripConfig(clock),
    });

    await drive(client, 'serv-swift');
    await drive(client, 'serv-swift');
    expect(client.circuitSnapshot()['serv-swift']?.state).toBe('OPEN');

    const out = await client.call('serv-nano', { system: 's', user: 'u' });
    expect(out.modelUsed).toBe('serv:serv-nano');
    expect(client.circuitSnapshot()['serv-nano']?.state).toBe('CLOSED');
  });

  it('concurrent trip race: nano storm trips nano OPEN while concurrent swift traffic is untouched', async () => {
    const clock = makeClock();
    const { fetchImpl } = routeDispatchFetch({ 'serv-nano': FAIL, 'serv-swift': OK });
    const client = new HttpLlmClient(freshIso(), ENV, {
      fetchImpl,
      sleep: vi.fn().mockResolvedValue(undefined),
      maxAttempts: 1,
      circuitBreakerConfig: tripConfig(clock),
    });

    // 8 nano failures + 8 swift successes, all in flight together.
    const nanoJobs = Array.from({ length: 8 }, () => drive(client, 'serv-nano'));
    const swiftJobs = Array.from({ length: 8 }, () => drive(client, 'serv-swift'));
    const [nanoRes, swiftRes] = await Promise.all([
      Promise.all(nanoJobs),
      Promise.all(swiftJobs),
    ]);

    // Every swift call succeeded — the nano storm never rejected a swift call.
    expect(swiftRes.every((r) => r === 'ok')).toBe(true);
    // At least one nano call failed closed once the breaker tripped.
    expect(nanoRes.some((r) => r instanceof CircuitAllOpenError)).toBe(true);

    expect(client.circuitSnapshot()['serv-nano']?.state).toBe('OPEN');
    const swift = client.circuitSnapshot()['serv-swift'];
    expect(swift?.state).toBe('CLOSED');
    expect(swift?.sampleCount).toBe(8);
  });

  it('half-open probe isolation: nano probe does not advance swift probeSequence', async () => {
    const clock = makeClock();
    // nano fails first (to trip), then recovers so the probe can succeed.
    let nanoHealthy = false;
    const { fetchImpl } = routeDispatchFetch({
      'serv-nano': () => (nanoHealthy ? okResponse() : FAIL()),
      'serv-swift': OK,
    });
    const client = new HttpLlmClient(freshIso(), ENV, {
      fetchImpl,
      sleep: vi.fn().mockResolvedValue(undefined),
      maxAttempts: 1,
      circuitBreakerConfig: tripConfig(clock),
    });

    await drive(client, 'serv-nano');
    await drive(client, 'serv-nano');
    expect(client.circuitSnapshot()['serv-nano']?.state).toBe('OPEN');
    // Keep swift warm so it has its own live samples.
    await client.call('serv-swift', { system: 's', user: 'u' });
    const swiftProbeBefore = client.circuitSnapshot()['serv-swift']?.probeSequence ?? 0;

    // Past cooldown → the next nano call is admitted as a HALF_OPEN probe.
    clock.advance(30_001);
    nanoHealthy = true;
    const out = await client.call('serv-nano', { system: 's', user: 'u' });
    expect(out.modelUsed).toBe('serv:serv-nano');

    const nano = client.circuitSnapshot()['serv-nano'];
    const swift = client.circuitSnapshot()['serv-swift'];
    // nano advanced its own probe machinery and closed on the successful probe.
    expect(nano?.probeSequence).toBeGreaterThanOrEqual(1);
    expect(nano?.state).toBe('CLOSED');
    // swift's probe machinery was never touched by nano's probe.
    expect(swift?.probeSequence).toBe(swiftProbeBefore);
    expect(swift?.state).toBe('CLOSED');
  });

  it('independent recovery: recovering nano leaves swift OPEN', async () => {
    const clock = makeClock();
    let nanoHealthy = false;
    const { fetchImpl } = routeDispatchFetch({
      'serv-nano': () => (nanoHealthy ? okResponse() : FAIL()),
      'serv-swift': FAIL,
    });
    const client = new HttpLlmClient(freshIso(), ENV, {
      fetchImpl,
      sleep: vi.fn().mockResolvedValue(undefined),
      maxAttempts: 1,
      circuitBreakerConfig: tripConfig(clock),
    });

    // Trip both.
    await drive(client, 'serv-nano');
    await drive(client, 'serv-nano');
    await drive(client, 'serv-swift');
    await drive(client, 'serv-swift');
    expect(client.circuitSnapshot()['serv-nano']?.state).toBe('OPEN');
    expect(client.circuitSnapshot()['serv-swift']?.state).toBe('OPEN');

    // Recover nano only.
    clock.advance(30_001);
    nanoHealthy = true;
    await client.call('serv-nano', { system: 's', user: 'u' });

    expect(client.circuitSnapshot()['serv-nano']?.state).toBe('CLOSED');
    // swift is still OPEN — nano's recovery did not reset it.
    expect(client.circuitSnapshot()['serv-swift']?.state).toBe('OPEN');
    const err = await drive(client, 'serv-swift');
    expect(err).toBeInstanceOf(CircuitAllOpenError);
  });

  it('alias resolver remap: an alias pointing at a new route gets a FRESH breaker (no inherited OPEN state)', async () => {
    const clock = makeClock();
    const { fetchImpl } = routeDispatchFetch({
      'serv-nano': FAIL,
      'serv-swift': OK,
      'serv-mega': OK,
    });
    const client = new HttpLlmClient(freshIso(), ENV, {
      fetchImpl,
      sleep: vi.fn().mockResolvedValue(undefined),
      maxAttempts: 1,
      circuitBreakerConfig: tripConfig(clock),
    });

    // Trip the breaker registered under alias 'serv-nano'.
    await drive(client, 'serv-nano');
    await drive(client, 'serv-nano');
    const before = client._testOnlyGetBreaker('serv-nano').snapshot();
    expect(before.state).toBe('OPEN');
    expect(before.sampleCount).toBe(2);

    // Simulate the alias resolver remapping 'serv-nano' to a DIFFERENT physical
    // model (different fingerprint). The stale OPEN breaker must be discarded.
    const remap = client as unknown as { modelMap: Record<string, ModelBinding> };
    remap.modelMap['serv-nano'] = {
      provider: 'serv',
      modelId: 'serv-mega',
      apiKeyEnv: 'SERV_API_KEY',
      baseUrl: 'https://example.test/v1',
    };

    const after = client._testOnlyGetBreaker('serv-nano').snapshot();
    expect(after.state).toBe('CLOSED');
    expect(after.sampleCount).toBe(0);

    // And the remapped alias serves against the new route.
    const out = await client.call('serv-nano', { system: 's', user: 'u' });
    expect(out.modelUsed).toBe('serv:serv-mega');
  });

  it('deadline vs breaker ordering: a deadline-exhausted nano call fails closed and never creates/contaminates swift', async () => {
    const clock = makeClock();
    const { fetchImpl, calls } = routeDispatchFetch({ 'serv-nano': OK, 'serv-swift': OK });
    // High minSamples so a single deadline-booked failure cannot trip nano and
    // mask the DeadlineExceededError — this test is about ordering + isolation,
    // not tripping.
    const client = new HttpLlmClient(freshIso(), ENV, {
      fetchImpl,
      sleep: vi.fn().mockResolvedValue(undefined),
      maxAttempts: 3,
      circuitBreakerConfig: { ...tripConfig(clock), minSamples: 5 },
    });

    // A request whose deadline is already in the past. The primary breaker is
    // admitted (created) FIRST, then the deadline check fails the call closed.
    const ctx = { requestId: 'r-deadline', deadlineAt: Date.now() - 5_000, providerCallBudgetMs: 1_000 };
    let deadlineErr: unknown;
    try {
      await client.call('serv-nano', { system: 's', user: 'u' }, ctx);
    } catch (e) {
      deadlineErr = e;
    }
    expect(deadlineErr).toBeInstanceOf(DeadlineExceededError);
    // No fetch was made for the deadline-exhausted attempt beyond the first
    // healthy call, and swift was never contacted at all.
    expect(calls['serv-swift']).toBeUndefined();
    expect(client.circuitSnapshot()['serv-swift']).toBeUndefined();
  });

  it('no global contamination: a fully OPEN nano never appears in swift diagnostics', async () => {
    const clock = makeClock();
    const { fetchImpl } = routeDispatchFetch({ 'serv-nano': FAIL, 'serv-swift': OK });
    const client = new HttpLlmClient(freshIso(), ENV, {
      fetchImpl,
      sleep: vi.fn().mockResolvedValue(undefined),
      maxAttempts: 1,
      circuitBreakerConfig: tripConfig(clock),
    });

    await drive(client, 'serv-nano');
    await drive(client, 'serv-nano');
    await client.call('serv-swift', { system: 's', user: 'u' });

    const diags = client.circuitDiagnostics();
    const nano = diags.find((d) => d.alias === 'serv-nano');
    const swift = diags.find((d) => d.alias === 'serv-swift');
    expect(nano?.route).toBe('serv:serv-nano');
    expect(nano?.state).toBe('OPEN');
    expect(swift?.route).toBe('serv:serv-swift');
    expect(swift?.state).toBe('CLOSED');
    // Diagnostics carry no secrets/prompts — only route + counters.
    const serialized = JSON.stringify(diags);
    expect(serialized).not.toContain('sk-test');
    expect(serialized).not.toContain('system');
  });

  it('bounded lifecycle: at cap, an IDLE breaker is evicted but a live OPEN breaker is never swept', async () => {
    const clock = makeClock();
    const MANY: Record<string, ModelBinding> = {};
    const behaviors: Record<string, ModelBehavior> = {};
    for (let i = 0; i < 6; i++) {
      const id = `m${i}`;
      MANY[id] = { provider: 'serv', modelId: id, apiKeyEnv: 'SERV_API_KEY', baseUrl: 'https://example.test/v1' };
      behaviors[id] = OK;
    }
    // m0 will be driven OPEN, so make it fail.
    behaviors['m0'] = FAIL;

    const { fetchImpl } = routeDispatchFetch(behaviors);
    const client = new HttpLlmClient(MANY, ENV, {
      fetchImpl,
      sleep: vi.fn().mockResolvedValue(undefined),
      maxAttempts: 1,
      maxBreakers: 3,
      circuitBreakerConfig: tripConfig(clock),
    });

    // Trip m0 OPEN (live, non-idle).
    await drive(client, 'm0');
    await drive(client, 'm0');
    expect(client.circuitSnapshot()['m0']?.state).toBe('OPEN');

    // Touch several other routes (each a successful call → idle afterwards since
    // windowSize keeps samples, but sampleCount>0 means NOT idle). To create a
    // genuinely idle breaker, advance the clock past windowAge so its samples
    // expire. Then adding new routes forces eviction of the idle one, never m0.
    await client.call('m1', { system: 's', user: 'u' });
    await client.call('m2', { system: 's', user: 'u' });
    // Age out m1/m2 samples so they become idle (CLOSED, empty window).
    clock.advance(60_001);
    // Now add m3, m4, m5 — each insertion runs the cap sweep.
    await client.call('m3', { system: 's', user: 'u' });
    await client.call('m4', { system: 's', user: 'u' });
    await client.call('m5', { system: 's', user: 'u' });

    // m0 (OPEN, live) must have survived every sweep.
    expect(client.circuitSnapshot()['m0']?.state).toBe('OPEN');
    // The map stays bounded near the cap (live m0 may keep it at cap+ transiently
    // if nothing idle remains, but it must never grow without bound).
    const size = Object.keys(client.circuitSnapshot()).length;
    expect(size).toBeLessThanOrEqual(4);
  });

  it('single-alias existing behavior is unchanged (one route, healthy path)', async () => {
    const clock = makeClock();
    const iso = freshIso();
    const SINGLE: Record<string, ModelBinding> = { 'serv-nano': iso['serv-nano']! };
    const { fetchImpl } = routeDispatchFetch({ 'serv-nano': OK });
    const client = new HttpLlmClient(SINGLE, ENV, {
      fetchImpl,
      sleep: vi.fn().mockResolvedValue(undefined),
      maxAttempts: 1,
      circuitBreakerConfig: tripConfig(clock),
    });
    const out = await client.call('serv-nano', { system: 's', user: 'u' });
    expect(out.providerRoute).toBe('primary');
    expect(out.modelUsed).toBe('serv:serv-nano');
    const diags = client.circuitDiagnostics();
    expect(diags).toHaveLength(1);
    const d0 = diags[0]!;
    expect(d0.alias).toBe('serv-nano');
    expect(d0.route).toBe('serv:serv-nano');
    expect(d0.state).toBe('CLOSED');
  });
});

describe('route fingerprint helpers', () => {
  it('routeFingerprint includes provider, model, and base URL; routeKeyOf omits the URL', () => {
    const b: ModelBinding = {
      provider: 'serv',
      modelId: 'serv-nano',
      apiKeyEnv: 'SERV_API_KEY',
      baseUrl: 'https://example.test/v1',
    };
    expect(routeFingerprint(b)).toBe('serv:serv-nano:https://example.test/v1');
    expect(routeKeyOf(b)).toBe('serv:serv-nano');
  });

  it('two aliases resolving to the same physical route share a fingerprint', () => {
    const a: ModelBinding = { provider: 'serv', modelId: 'serv-nano', apiKeyEnv: 'K', baseUrl: 'https://x/v1' };
    const b: ModelBinding = { provider: 'serv', modelId: 'serv-nano', apiKeyEnv: 'K2', baseUrl: 'https://x/v1' };
    // apiKeyEnv is NOT part of the fingerprint (never a secret dimension).
    expect(routeFingerprint(a)).toBe(routeFingerprint(b));
  });
});
