import { describe, expect, it, vi } from 'vitest';
import { HttpLlmClient, type ModelBinding } from './llm-client.js';

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
