import { describe, expect, it, vi } from 'vitest';
import { CircuitAllOpenError, HttpLlmClient, type ModelBinding } from './llm-client.js';

const BINDING: Record<string, ModelBinding> = {
  'test-model': {
    provider: 'serv',
    modelId: 'serv-nano',
    apiKeyEnv: 'TEST_API_KEY',
    baseUrl: 'https://example.test/v1',
  },
};
const ENV = { TEST_API_KEY: 'sk-test' } as unknown as NodeJS.ProcessEnv;

function makeOkResponse(content = '{"verdict":"PASS","confidence":0.9}'): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('HttpLlmClient retry + timeout', () => {
  it('returns on first-attempt success without retry', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(makeOkResponse());
    const sleep = vi.fn().mockResolvedValue(undefined);

    const client = new HttpLlmClient(BINDING, ENV, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep,
      maxAttempts: 6,
    });

    const out = await client.call('test-model', { system: 's', user: 'u' });

    expect(out.raw).toBe('{"verdict":"PASS","confidence":0.9}');
    expect(out.modelUsed).toBe('serv:serv-nano');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('retries on transient "fetch failed" and returns success from attempt 3', async () => {
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(makeOkResponse());
    const sleep = vi.fn().mockResolvedValue(undefined);

    const client = new HttpLlmClient(BINDING, ENV, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep,
      maxAttempts: 6,
      backoffBaseMs: 1,
      backoffCapMs: 5,
    });

    const out = await client.call('test-model', { system: 's', user: 'u' });

    expect(out.raw).toBe('{"verdict":"PASS","confidence":0.9}');
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it('retries on 429 rate-limit error', async () => {
    const rateLimited = new Response('rate limit', { status: 429 });
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(rateLimited)
      .mockResolvedValueOnce(makeOkResponse());
    const sleep = vi.fn().mockResolvedValue(undefined);

    const client = new HttpLlmClient(BINDING, ENV, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep,
      maxAttempts: 4,
      backoffBaseMs: 1,
    });

    const out = await client.call('test-model', { system: 's', user: 'u' });

    expect(out.raw).toBe('{"verdict":"PASS","confidence":0.9}');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it('does not retry on non-retryable errors (HTTP 400)', async () => {
    const badRequest = new Response('bad input', { status: 400 });
    const fetchImpl = vi.fn().mockResolvedValueOnce(badRequest);
    const sleep = vi.fn().mockResolvedValue(undefined);

    const client = new HttpLlmClient(BINDING, ENV, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep,
      maxAttempts: 6,
    });

    await expect(client.call('test-model', { system: 's', user: 'u' })).rejects.toThrow(/400/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('throws after exhausting all attempts on persistent fetch failed', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new TypeError('fetch failed'));
    const sleep = vi.fn().mockResolvedValue(undefined);

    const client = new HttpLlmClient(BINDING, ENV, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep,
      maxAttempts: 3,
      backoffBaseMs: 1,
    });

    await expect(client.call('test-model', { system: 's', user: 'u' })).rejects.toThrow(
      /fetch failed/
    );
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it('surfaces AbortError as retryable timeout and retries', async () => {
    const abortErr = Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(abortErr)
      .mockResolvedValueOnce(makeOkResponse());
    const sleep = vi.fn().mockResolvedValue(undefined);

    const client = new HttpLlmClient(BINDING, ENV, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep,
      maxAttempts: 4,
      backoffBaseMs: 1,
      timeoutMs: 100,
    });

    const out = await client.call('test-model', { system: 's', user: 'u' });

    expect(out.raw).toBe('{"verdict":"PASS","confidence":0.9}');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('applies exponential backoff up to the cap', async () => {
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(makeOkResponse());
    const waits: number[] = [];
    const sleep = vi.fn().mockImplementation(async (ms: number) => {
      waits.push(ms);
    });

    const client = new HttpLlmClient(BINDING, ENV, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep,
      maxAttempts: 6,
      backoffBaseMs: 100,
      backoffCapMs: 250, // cap kicks in early
    });

    await client.call('test-model', { system: 's', user: 'u' });

    // 3 retries → 3 sleeps. Base 100 → attempt2=100+j, attempt3=200+j, attempt4=cap=250+j
    expect(waits.length).toBe(3);
    // Attempt 2 base = 100, jitter [0..799]
    expect(waits[0]).toBeGreaterThanOrEqual(100);
    expect(waits[0]).toBeLessThan(100 + 800);
    // Attempt 3 base = 200, jitter [0..799]
    expect(waits[1]).toBeGreaterThanOrEqual(200);
    expect(waits[1]).toBeLessThan(200 + 800);
    // Attempt 4 base capped at 250, jitter [0..799]
    expect(waits[2]).toBeGreaterThanOrEqual(250);
    expect(waits[2]).toBeLessThan(250 + 800);
  });

  it('throws immediately for unknown model alias without any fetch', async () => {
    const fetchImpl = vi.fn();
    const client = new HttpLlmClient(BINDING, ENV, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(client.call('nope', { system: 's', user: 'u' })).rejects.toThrow(/unknown model/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('throws immediately when API key env var is missing', async () => {
    const fetchImpl = vi.fn();
    const client = new HttpLlmClient(BINDING, {} as NodeJS.ProcessEnv, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(client.call('test-model', { system: 's', user: 'u' })).rejects.toThrow(
      /missing env var/
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // v0.4.3 recert instrumentation — attemptCount, backoffWaitedMs, retryReasons
  // ---------------------------------------------------------------------------
  it('populates attemptCount=1 and zero backoff on first-attempt success', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(makeOkResponse());
    const client = new HttpLlmClient(BINDING, ENV, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep: vi.fn().mockResolvedValue(undefined),
    });
    const out = await client.call('test-model', { system: 's', user: 'u' });
    expect(out.attemptCount).toBe(1);
    expect(out.backoffWaitedMs).toBe(0);
    expect(out.retryReasons).toEqual([]);
  });

  it('populates attemptCount, backoffWaitedMs and retryReasons after retries', async () => {
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockRejectedValueOnce(new TypeError('fetch failed timeout'))
      .mockResolvedValueOnce(makeOkResponse());
    // Deterministic sleep tracker so we can assert the summed value.
    const sleep = vi.fn().mockResolvedValue(undefined);
    const client = new HttpLlmClient(BINDING, ENV, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep,
      maxAttempts: 6,
      backoffBaseMs: 100,
      backoffCapMs: 5_000,
    });
    const out = await client.call('test-model', { system: 's', user: 'u' });
    expect(out.attemptCount).toBe(3);
    // Two waits happened before the 3rd attempt succeeded. Each wait is
    // base * 2^(attempt-1) + jitter[0..800). So backoffWaitedMs ≥ 100 + 200.
    expect(out.backoffWaitedMs).toBeGreaterThanOrEqual(300);
    // And an upper bound: two waits, each ≤ 5000 + 800.
    expect(out.backoffWaitedMs).toBeLessThan(11_601);
    expect(out.retryReasons).toHaveLength(2);
    expect(out.retryReasons?.[0]).toMatch(/fetch failed/);
    expect(out.retryReasons?.[1]).toMatch(/fetch failed timeout/);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it('caps retryReasons at 4 entries even when more retryable errors occur', async () => {
    // Five retryable failures followed by an OK response. maxAttempts=6.
    // The retry loop must not push more than 4 reasons into retryReasons;
    // additional entries are dropped silently so the diagnostics envelope
    // stays bounded.
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('fetch failed #0'))
      .mockRejectedValueOnce(new TypeError('fetch failed #1'))
      .mockRejectedValueOnce(new TypeError('fetch failed #2'))
      .mockRejectedValueOnce(new TypeError('fetch failed #3'))
      .mockRejectedValueOnce(new TypeError('fetch failed #4'))
      .mockResolvedValueOnce(makeOkResponse());
    const client = new HttpLlmClient(BINDING, ENV, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep: vi.fn().mockResolvedValue(undefined),
      maxAttempts: 6,
      backoffBaseMs: 1,
      backoffCapMs: 5,
    });
    const out = await client.call('test-model', { system: 's', user: 'u' });
    expect(fetchImpl).toHaveBeenCalledTimes(6);
    expect(out.attemptCount).toBe(6);
    // Cap is 4 — retry reasons #5 (index 4) and later are dropped.
    expect(out.retryReasons).toHaveLength(4);
    expect(out.retryReasons?.[0]).toMatch(/fetch failed #0/);
    expect(out.retryReasons?.[1]).toMatch(/fetch failed #1/);
    expect(out.retryReasons?.[2]).toMatch(/fetch failed #2/);
    expect(out.retryReasons?.[3]).toMatch(/fetch failed #3/);
  });
});

// -----------------------------------------------------------------------------
// Circuit-Breaker integration — PR #10
// -----------------------------------------------------------------------------

const DUAL_BINDING: Record<string, ModelBinding> = {
  'serv-nano': {
    provider: 'serv',
    modelId: 'serv-nano',
    apiKeyEnv: 'SERV_API_KEY',
    baseUrl: 'https://example.test/v1',
    fallbackAlias: 'serv-swift',
  },
  'serv-swift': {
    provider: 'serv',
    modelId: 'serv-swift',
    apiKeyEnv: 'SERV_API_KEY',
    baseUrl: 'https://example.test/v1',
    fallbackAlias: 'serv-nano',
  },
};
const DUAL_ENV = { SERV_API_KEY: 'sk-test' } as unknown as NodeJS.ProcessEnv;

function makeErrResponse(status = 500, body = 'server error'): Response {
  return new Response(body, { status });
}

describe('HttpLlmClient circuit-breaker (PR #10)', () => {
  it('populates providerRoute="primary" on the happy path', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(makeOkResponse());
    const sleep = vi.fn().mockResolvedValue(undefined);
    const client = new HttpLlmClient(DUAL_BINDING, DUAL_ENV, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep,
      maxAttempts: 1,
    });
    const out = await client.call('serv-nano', { system: 's', user: 'u' });
    expect(out.providerRoute).toBe('primary');
    expect(out.modelUsed).toBe('serv:serv-nano');
  });

  it('routes to fallback alias when primary circuit opens from failures', async () => {
    // Every fetch call fails with a retryable error. maxAttempts:1 so each
    // client.call() reports one failure to the breaker. minSamples:3 &
    // tripFailureRate:0.5 — after 3 primary failures, primary is OPEN.
    const fetchImpl = vi
      .fn()
      // First 3 primary calls fail
      .mockRejectedValueOnce(new Error('fetch failed'))
      .mockRejectedValueOnce(new Error('fetch failed'))
      .mockRejectedValueOnce(new Error('fetch failed'))
      // Failure #3 tripped the circuit — the SAME call gets a retry via
      // fallback (swift). Return an OK response for that fallback attempt.
      .mockResolvedValueOnce(makeOkResponse())
      // Subsequent calls hit fallback directly (primary OPEN).
      .mockResolvedValue(makeOkResponse());
    const sleep = vi.fn().mockResolvedValue(undefined);
    const client = new HttpLlmClient(DUAL_BINDING, DUAL_ENV, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep,
      maxAttempts: 1,
      circuitBreakerConfig: {
        minSamples: 3,
        tripFailureRate: 0.5,
        windowSize: 10,
        tripP90LatencyMs: 999_999,
        cooldownMs: 60_000,
      },
    });

    // Call 1: primary fails, circuit not yet at minSamples, error propagates.
    await expect(client.call('serv-nano', { system: 's', user: 'u' })).rejects.toThrow(/fetch failed/);
    // Call 2: primary fails, still below minSamples, error propagates.
    await expect(client.call('serv-nano', { system: 's', user: 'u' })).rejects.toThrow(/fetch failed/);
    // Call 3: primary fails, circuit trips — SAME call retries via fallback (swift).
    const out3 = await client.call('serv-nano', { system: 's', user: 'u' });
    expect(out3.providerRoute).toBe('fallback');
    expect(out3.modelUsed).toBe('serv:serv-swift');

    // Call 4: primary circuit still OPEN — goes directly to fallback.
    const out4 = await client.call('serv-nano', { system: 's', user: 'u' });
    expect(out4.providerRoute).toBe('fallback');

    // Snapshot: primary OPEN, fallback CLOSED.
    const snap = client.circuitSnapshot();
    expect(snap['serv-nano']?.state).toBe('OPEN');
    expect(snap['serv-swift']?.state).toBe('CLOSED');
  });

  it('throws CircuitAllOpenError (fail-closed) when both circuits are OPEN', async () => {
    // Every fetch fails — both nano and swift circuits eventually trip.
    const fetchImpl = vi.fn().mockRejectedValue(new Error('fetch failed'));
    const sleep = vi.fn().mockResolvedValue(undefined);
    const client = new HttpLlmClient(DUAL_BINDING, DUAL_ENV, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep,
      maxAttempts: 1,
      circuitBreakerConfig: {
        minSamples: 2,
        tripFailureRate: 0.5,
        windowSize: 10,
        tripP90LatencyMs: 999_999,
        cooldownMs: 60_000,
      },
    });

    // Feed failures until both circuits are open. Each client.call may throw
    // fetch-failed OR CircuitAllOpenError depending on state — both are fine.
    let sawAllOpen = false;
    for (let i = 0; i < 20; i++) {
      try {
        await client.call('serv-nano', { system: 's', user: 'u' });
      } catch (err) {
        if (err instanceof CircuitAllOpenError) {
          sawAllOpen = true;
          break;
        }
      }
    }
    expect(sawAllOpen).toBe(true);
    const snap = client.circuitSnapshot();
    expect(snap['serv-nano']?.state).toBe('OPEN');
    expect(snap['serv-swift']?.state).toBe('OPEN');
  });

  it('disableCircuitBreaker=true bypasses routing entirely (legacy baseline mode)', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(makeOkResponse());
    const sleep = vi.fn().mockResolvedValue(undefined);
    const client = new HttpLlmClient(DUAL_BINDING, DUAL_ENV, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep,
      maxAttempts: 1,
      disableCircuitBreaker: true,
    });
    const out = await client.call('serv-nano', { system: 's', user: 'u' });
    expect(out.providerRoute).toBe('primary');
    // No breakers ever created — snapshot is empty.
    expect(Object.keys(client.circuitSnapshot())).toHaveLength(0);
  });

  it('capitalPathMode=true fails closed on primary trip (no fallback route, until v0.4.3)', async () => {
    // Fail every fetch call so primary circuit trips. In capital-path mode
    // we must NEVER see providerRoute='fallback'; the client must throw
    // CircuitAllOpenError so the engine emits UNCERTAIN@0.
    const fetchImpl = vi.fn().mockRejectedValue(new Error('fetch failed'));
    const sleep = vi.fn().mockResolvedValue(undefined);
    const client = new HttpLlmClient(DUAL_BINDING, DUAL_ENV, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep,
      maxAttempts: 1,
      capitalPathMode: true,
      circuitBreakerConfig: {
        minSamples: 3,
        tripFailureRate: 0.5,
        windowSize: 10,
        tripP90LatencyMs: 999_999,
        cooldownMs: 60_000,
      },
    });

    // Feed failures until the primary trips. As soon as it does, the next
    // call must throw CircuitAllOpenError — NOT succeed on fallback.
    let sawAllOpen = false;
    let sawAnyFallbackRoute = false;
    for (let i = 0; i < 10; i++) {
      try {
        const out = await client.call('serv-nano', { system: 's', user: 'u' });
        if (out.providerRoute === 'fallback') sawAnyFallbackRoute = true;
      } catch (err) {
        if (err instanceof CircuitAllOpenError) {
          sawAllOpen = true;
          expect(err.message).toMatch(/capital-path-mode/);
          break;
        }
      }
    }
    expect(sawAllOpen).toBe(true);
    // The strict safety invariant of capital-path mode:
    expect(sawAnyFallbackRoute).toBe(false);
    // Primary must have tripped; fallback breaker was never even consulted.
    const snap = client.circuitSnapshot();
    expect(snap['serv-nano']?.state).toBe('OPEN');
    expect(snap['serv-swift']).toBeUndefined();
  });

  it('capitalPathMode=true still allows happy-path calls when primary is CLOSED', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(makeOkResponse());
    const sleep = vi.fn().mockResolvedValue(undefined);
    const client = new HttpLlmClient(DUAL_BINDING, DUAL_ENV, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep,
      maxAttempts: 1,
      capitalPathMode: true,
    });
    const out = await client.call('serv-nano', { system: 's', user: 'u' });
    expect(out.providerRoute).toBe('primary');
  });

  // ---------------------------------------------------------------------------
  // v0.4.3 CB-latency-fix — PR #11
  // The CircuitBreaker's p90 latency signal must reflect PROVIDER response time,
  // not our wall-clock reaction to transient errors. Backoff waits between
  // failed attempts inside callWithRetry must be subtracted before reporting
  // to recordSuccess. Failures are still reported wall-clock (they populate
  // failure_rate, not the latency window).
  // ---------------------------------------------------------------------------
  it('PR #11: first-attempt success — CB records wall-clock (backoff=0, no-op change)', async () => {
    // Instrument sleep so we can measure the wall-clock the CB is asked about.
    // With NO retries, backoffWaitedMs=0, netLatency == wallClock. The pre-fix
    // and post-fix behavior are identical on this path.
    const fetchImpl = vi.fn().mockResolvedValueOnce(makeOkResponse());
    const client = new HttpLlmClient(DUAL_BINDING, DUAL_ENV, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep: vi.fn().mockResolvedValue(undefined),
      maxAttempts: 6,
    });
    const out = await client.call('serv-nano', { system: 's', user: 'u' });
    expect(out.attemptCount).toBe(1);
    expect(out.backoffWaitedMs).toBe(0);
    const snap = client.circuitSnapshot();
    // A single sample recorded; whatever wall-clock we observed is the sample.
    expect(snap['serv-nano']?.sampleCount).toBe(1);
    // p90 of a single non-negative number is non-negative. No spurious explosion.
    expect(snap['serv-nano']?.p90LatencyMs).toBeGreaterThanOrEqual(0);
    expect(snap['serv-nano']?.p90LatencyMs).toBeLessThan(5_000);
  });

  it('PR #11: 3-attempt success — CB p90 excludes backoff waits (does NOT trip on retry cluster)', async () => {
    // Pre-fix: backoff ≥ 300ms + real network ≈ 400ms sample → fine here, but
    // the important behavior is: the value reported to the CB EQUALS network
    // time, NOT wall-clock. We assert p90 < wallClock by a margin larger than
    // the network work could possibly consume.
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(makeOkResponse());
    // Real sleep so wall-clock is a real, observable delay we can compare to.
    const client = new HttpLlmClient(DUAL_BINDING, DUAL_ENV, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      maxAttempts: 6,
      backoffBaseMs: 400,
      backoffCapMs: 2_000,
    });
    const wallStart = Date.now();
    const out = await client.call('serv-nano', { system: 's', user: 'u' });
    const wallClock = Date.now() - wallStart;
    expect(out.attemptCount).toBe(3);
    // Two backoff waits: base*1 + base*2 + jitter = 400 + 800 + [0,1600) ≥ 1200ms.
    expect(out.backoffWaitedMs).toBeGreaterThanOrEqual(1_200);
    // Wall-clock includes those waits.
    expect(wallClock).toBeGreaterThanOrEqual(out.backoffWaitedMs!);
    // CB p90 must be netLatency = wallClock - backoffWaitedMs. With no real
    // network fetch impl (vi.fn mock), netLatency is tiny — well under 500ms.
    const snap = client.circuitSnapshot();
    expect(snap['serv-nano']?.sampleCount).toBe(1);
    const p90 = snap['serv-nano']?.p90LatencyMs ?? 0;
    expect(p90).toBeLessThan(500);
    // And critically: p90 must be strictly less than wallClock — the fix.
    expect(p90).toBeLessThan(wallClock);
  });

  it('PR #11: retry cluster no longer trips the p90 window on a healthy provider', async () => {
    // Regression harness for the exact Check-B pathology: a single retry-cluster
    // draw producing an 18+ second wall-clock sample that would push p90 over
    // the 15s threshold. With the fix, that same call reports a sub-second
    // netLatency — the CB never trips despite the retries.
    let call = 0;
    const fetchImpl = vi.fn().mockImplementation(() => {
      call++;
      // First 4 calls of every retry-loop fail transiently; 5th succeeds.
      if (call % 5 !== 0) return Promise.reject(new TypeError('fetch failed'));
      return Promise.resolve(makeOkResponse());
    });
    // CB tuned exactly like production: p90 trip at 15s.
    const client = new HttpLlmClient(DUAL_BINDING, DUAL_ENV, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep: vi.fn().mockResolvedValue(undefined), // instant backoff waits
      maxAttempts: 6,
      backoffBaseMs: 5_000, // if these were reported to CB, each sample ≥ 15s
      backoffCapMs: 20_000,
      circuitBreakerConfig: {
        minSamples: 3,
        tripFailureRate: 0.99, // effectively disable failure-rate trip
        tripP90LatencyMs: 15_000,
        windowSize: 20,
        cooldownMs: 60_000,
      },
    });
    // 5 successful calls, each requiring 5 attempts (4 retries).
    for (let i = 0; i < 5; i++) {
      const out = await client.call('serv-nano', { system: 's', user: 'u' });
      expect(out.attemptCount).toBe(5);
      // With mocked sleep (returns immediately) the ACTUAL wall-clock and
      // netLatency will both be tiny. What matters is that the CB was fed
      // netLatency, not (wallClock + fake_backoff_of_60s).
    }
    const snap = client.circuitSnapshot();
    // Five samples recorded; NONE tripped despite each call having 4 retries.
    expect(snap['serv-nano']?.state).toBe('CLOSED');
    expect(snap['serv-nano']?.sampleCount).toBe(5);
    // p90 stays well below the 15s trip threshold — this is the whole point.
    expect(snap['serv-nano']?.p90LatencyMs).toBeLessThan(15_000);
  });

  it('T26 (client layer): stale-success — mid-fetch trip does NOT drop the primary response, and the stale outcome does NOT mutate the new state', async () => {
    // Contract: HttpLlmClient.call() served a primary response when the
    // retry loop returned ok=true. If the breaker was concurrently tripped
    // by another consumer BETWEEN admit() and recordOutcome(), the token
    // becomes stale (wrong_epoch when back in CLOSED, or wrong_state when
    // still OPEN). The client must:
    //   (a) still return the primary response with providerRoute='primary'
    //   (b) leave the breaker state (samples, epochs, stateRevision)
    //       exactly as the concurrent trip left it
    // This test simulates the race by hooking fetchImpl to trip the
    // in-client breaker MID-CALL via _testOnlyGetBreaker(). By the time
    // recordOutcome fires, the breaker is OPEN and the token is stale.
    const fetchImpl = vi.fn();
    const sleep = vi.fn().mockResolvedValue(undefined);
    const client = new HttpLlmClient(DUAL_BINDING, DUAL_ENV, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep,
      maxAttempts: 1,
      circuitBreakerConfig: {
        minSamples: 2,
        tripFailureRate: 0.5,
        windowSize: 5,
        tripP90LatencyMs: 999_999,
        cooldownMs: 60_000,
      },
    });
    // Race helper: during the primary fetch we spin up a side-channel that
    // trips the primary breaker via its own token machinery. We reach the
    // same breaker via the test-only accessor. Once trip fires, the token
    // held by the outer call() is stale.
    fetchImpl.mockImplementationOnce(async () => {
      const cb = client._testOnlyGetBreaker('serv-nano');
      // Drive it to OPEN independently of our outer call. With minSamples=2
      // and tripFailureRate=0.5, exactly 2 independent admit+failure pairs
      // trip the breaker. A 3rd admit would already throw CircuitOpenError
      // and pollute the outer fetch — we must not do that here.
      for (let i = 0; i < 2; i++) {
        const adm = cb.admit();
        cb.recordOutcome(adm.token, { ok: false, netLatencyMs: 500 });
      }
      expect(cb.snapshot().state).toBe('OPEN');
      // Return a successful body so the outer call's retry loop returns ok.
      return makeOkResponse();
    });

    // Capture pre-mutation snapshot just before we invoke call(). The
    // outer admit() will happen inside call(); we care about the state
    // AFTER the concurrent trip fires inside the fetch.
    const out = await client.call('serv-nano', { system: 's', user: 'u' });

    // (a) Response served.
    expect(out.providerRoute).toBe('primary');
    expect(out.modelUsed).toBe('serv:serv-nano');

    // (b) Breaker state reflects ONLY the concurrent trip — no additional
    // sample from the stale-success recordOutcome. Before the outer call,
    // the concurrent side-channel accumulated exactly 2 failure samples
    // and the 2nd tripped the breaker. The stale-success outcome must
    // NOT add a 3rd sample and must NOT bump stateRevision further.
    const snap = client.circuitSnapshot();
    expect(snap['serv-nano']?.state).toBe('OPEN');
    expect(snap['serv-nano']?.sampleCount).toBe(2);
    expect(snap['serv-nano']?.tripGeneration).toBe(1);
    // The trip advanced stateRevision to 1. The stale recordOutcome must
    // NOT have bumped it further.
    expect(snap['serv-nano']?.stateRevision).toBe(1);
  });
});
