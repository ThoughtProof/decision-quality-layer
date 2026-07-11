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
});
