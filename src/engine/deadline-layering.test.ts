import { describe, it, expect, vi } from 'vitest';
import { HttpLlmClient, DeadlineExceededError, ProviderCallError } from './llm-client.js';
import { runVerification } from './index.js';
import { PotCliCascade } from './cascade-pot.js';
import { StubCascade } from './cascade.js';
import type { CallContext } from './call-context.js';

const BINDING = {
  'serv-nano': {
    provider: 'serv' as const,
    modelId: 'serv-nano',
    apiKeyEnv: 'SERV_API_KEY',
    baseUrl: 'https://example.test/v1',
    fallbackAlias: null,
  },
  'serv-swift': {
    provider: 'serv' as const,
    modelId: 'serv-swift',
    apiKeyEnv: 'SERV_API_KEY',
    baseUrl: 'https://example.test/v1',
    fallbackAlias: null,
  },
};

const ENV = { SERV_API_KEY: 'sk-test' } as NodeJS.ProcessEnv;

function hangUntilAbort(): typeof fetch {
  return ((_: RequestInfo | URL, init?: RequestInit) =>
    new Promise((_, reject) => {
      const signal = init?.signal;
      if (!signal) return;
      if (signal.aborted) {
        const err = Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
        reject(err);
        return;
      }
      signal.addEventListener(
        'abort',
        () => {
          const err = Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
          reject(err);
        },
        { once: true },
      );
    })) as unknown as typeof fetch;
}

describe('deadline layering', () => {
  it('attempt timeout remains retryable ProviderCallError', async () => {
    const abortErr = Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(abortErr)
      .mockResolvedValueOnce(
        new Response(
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
                finish_reason: 'stop',
              },
            ],
            usage: { completion_tokens: 12 },
          }),
          { status: 200 },
        ),
      );
    const client = new HttpLlmClient(BINDING, ENV, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep: async () => undefined,
      maxAttempts: 3,
      timeoutMs: 50,
      disableCircuitBreaker: true,
    });
    const out = await client.call('serv-nano', { system: 's', user: 'u' });
    expect(out.raw).toContain('PASS');
    expect(out.finishReason).toBe('stop');
    expect(out.completionTokens).toBe(12);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('request_deadline abort is non-retryable DeadlineExceededError', async () => {
    const ac = new AbortController();
    ac.abort();
    const fetchImpl = vi.fn().mockImplementation(() => {
      const err = Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
      return Promise.reject(err);
    });
    const client = new HttpLlmClient(BINDING, ENV, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep: async () => undefined,
      maxAttempts: 4,
      timeoutMs: 5_000,
      disableCircuitBreaker: true,
    });
    const ctx: CallContext = {
      requestId: 'req-deadline',
      requestSignal: ac.signal,
      deadlineAt: Date.now() - 1,
      providerCallBudgetMs: 40_000,
    };
    await expect(client.call('serv-nano', { system: 's', user: 'u' }, ctx)).rejects.toBeInstanceOf(
      DeadlineExceededError,
    );
    expect(fetchImpl).toHaveBeenCalledTimes(0); // rejected before attempt when W already exhausted
  });

  it('skips secondary when remaining W < PC + reserve and still returns REVIEW path', async () => {
    let calls = 0;
    const fetchImpl = vi.fn().mockImplementation(async () => {
      calls += 1;
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  verdict: 'PASS',
                  confidence: 0.8,
                  reasoning: 'primary ok',
                  objection: '',
                }),
              },
            },
          ],
        }),
        { status: 200 },
      );
    });
    const client = new HttpLlmClient(BINDING, ENV, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep: async () => undefined,
      maxAttempts: 1,
      timeoutMs: 5_000,
      disableCircuitBreaker: true,
    });
    const cascade = new PotCliCascade(client, {
      primaryModel: 'serv-nano',
      secondaryModel: 'serv-swift',
      confirmFail: false,
    });
    // Only enough budget for primary, not secondary (PC=40s + 3s reserve).
    const response = await runVerification({
      request: {
        mandate: 'm',
        proposed_action: 'a',
        reasoning: 'r',
        axes: ['intent'],
        sandbox: false,
      },
      cascade,
      sandboxCascade: new StubCascade(),
      requestId: 'req-w-skip',
      version: 'test',
      requestDeadlineMs: 1_000, // tiny W → secondary skipped after primary
      providerCallBudgetMs: 40_000,
    });
    expect(response.aggregate.verdict).not.toBe('ALLOW');
    // Primary may still complete; secondary skip forces degraded path → no ALLOW.
    expect(calls).toBeLessThanOrEqual(1);
    expect(response.axes[0]?.provider_outcome === 'provider_error' || response.aggregate.verdict === 'REVIEW').toBe(
      true,
    );
  });

  it('hanging fetch is aborted by attempt timeout as ProviderCallError', async () => {
    const client = new HttpLlmClient(BINDING, ENV, {
      fetchImpl: hangUntilAbort(),
      sleep: async () => undefined,
      maxAttempts: 1,
      timeoutMs: 30,
      disableCircuitBreaker: true,
    });
    await expect(client.call('serv-nano', { system: 's', user: 'u' })).rejects.toBeInstanceOf(
      ProviderCallError,
    );
  });
});
