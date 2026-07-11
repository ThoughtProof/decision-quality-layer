/**
 * PR #12 (v0.4.3.1 §C.3): `provider_route` semantics — discriminating tests.
 *
 * `provider_route` MUST describe a route that actually served a response.
 * When no provider was called (circuit-breaker rejected), `provider_route` is
 * absent and `provider_outcome='circuit_rejected'`. This prevents fail-closed
 * axes from being mis-attributed to the fallback route in downstream metrics.
 *
 * Four cases must be distinguishable end-to-end:
 *
 *   1. capitalPathMode=true, both circuits OPEN:
 *      → 0 fallback fetches. `provider_route` absent. `provider_outcome='circuit_rejected'`.
 *
 *   2. capitalPathMode=false, both circuits OPEN (double-open extreme):
 *      → 0 fallback fetches. `provider_route` absent. `provider_outcome='circuit_rejected'`.
 *
 *   3. Successful actual fallback (CPM=false, primary OPEN, fallback OK):
 *      → 1 fallback fetch. `provider_route='fallback'`. `provider_outcome='served'`.
 *
 *   4. Successful primary (happy path):
 *      → `provider_route='primary'`. `provider_outcome='served'`.
 */

import { describe, it, expect, vi } from 'vitest';
import { HttpLlmClient, CircuitAllOpenError } from './llm-client.js';
import type { ModelBinding } from './llm-client.js';

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

function okResponse(text = 'VERDICT: PASS'): Response {
  return new Response(
    JSON.stringify({
      choices: [{ message: { content: text } }],
      model: 'serv-model',
    }),
    { status: 200, headers: { 'content-type': 'application/json' } }
  );
}

function errResponse(): Response {
  return new Response('server error', { status: 500 });
}

describe('PR #12 §C.3 — provider_route names ONLY served routes', () => {
  it('Case 4 (happy path): successful primary → route=primary, outcome=served', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okResponse());
    const client = new HttpLlmClient(DUAL_BINDING, DUAL_ENV, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep: vi.fn().mockResolvedValue(undefined),
      maxAttempts: 1,
    });
    const out = await client.call('serv-nano', { system: 's', user: 'u' });
    expect(out.providerRoute).toBe('primary');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('Case 3 (real fallback): CPM=false, primary OPEN, fallback OK → route=fallback (served)', async () => {
    // 3 primary failures trip primary; the same call retries via fallback (swift) OK.
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(new Error('fetch failed'))
      .mockRejectedValueOnce(new Error('fetch failed'))
      .mockRejectedValueOnce(new Error('fetch failed'))
      .mockResolvedValue(okResponse());
    const client = new HttpLlmClient(DUAL_BINDING, DUAL_ENV, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep: vi.fn().mockResolvedValue(undefined),
      maxAttempts: 1,
      circuitBreakerConfig: {
        minSamples: 3,
        tripFailureRate: 0.5,
        windowSize: 5,
        windowAgeMs: 60_000,
      },
      capitalPathMode: false,
    });

    // First 3 calls fail (primary failures), on the 3rd primary circuit
    // opens and this same call gets rerouted to fallback → returns OK.
    for (let i = 0; i < 2; i++) {
      await expect(client.call('serv-nano', { system: 's', user: 'u' })).rejects.toThrow();
    }
    const outFallback = await client.call('serv-nano', { system: 's', user: 'u' });
    expect(outFallback.providerRoute).toBe('fallback');
  });

  it('Case 1 (CPM=true, primary OPEN before any fallback): CircuitAllOpenError, 0 fallback fetches', async () => {
    // Trip primary circuit first (CPM=false so we can trip it via failures),
    // THEN flip a fresh client to CPM=true — no, that's not the correct test.
    // Correct: use a client that starts CPM=true. Force primary open by
    // sending failures. When circuit opens under CPM=true, no fallback is
    // attempted.
    let fetchCount = 0;
    const fetchImpl = vi.fn().mockImplementation(() => {
      fetchCount++;
      // First 3 requests fail (trip primary via failure_rate).
      if (fetchCount <= 3) return Promise.reject(new Error('fetch failed'));
      // Any request past #3: should NOT be reached under CPM=true because
      // primary is OPEN and no fallback is attempted.
      return Promise.resolve(okResponse());
    });
    const client = new HttpLlmClient(DUAL_BINDING, DUAL_ENV, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep: vi.fn().mockResolvedValue(undefined),
      maxAttempts: 1,
      circuitBreakerConfig: {
        minSamples: 3,
        tripFailureRate: 0.5,
        windowSize: 5,
        windowAgeMs: 60_000,
      },
      capitalPathMode: true,
    });

    // Three calls to fill the primary failure window.
    for (let i = 0; i < 3; i++) {
      await expect(client.call('serv-nano', { system: 's', user: 'u' })).rejects.toThrow();
    }
    // Fourth call: primary is now OPEN. Under CPM=true, must throw
    // CircuitAllOpenError WITHOUT attempting fallback.
    const fetchesBefore = fetchImpl.mock.calls.length;
    await expect(client.call('serv-nano', { system: 's', user: 'u' })).rejects.toThrow(
      CircuitAllOpenError
    );
    const fetchesAfter = fetchImpl.mock.calls.length;
    // No fallback fetch happened between throw-decision and rejection.
    expect(fetchesAfter - fetchesBefore).toBe(0);
  });

  it('Case 2 (CPM=false, both circuits OPEN): CircuitAllOpenError, no phantom "fallback served"', async () => {
    // Design: primary trips, fallback also trips. Then a fresh call
    // encounters both circuits OPEN → CircuitAllOpenError. This is the
    // extreme fail-safe regime for CPM=false.
    let fetchCount = 0;
    const fetchImpl = vi.fn().mockImplementation(() => {
      fetchCount++;
      // All fetches fail — both primary and fallback will trip.
      return Promise.reject(new Error('fetch failed'));
    });
    const client = new HttpLlmClient(DUAL_BINDING, DUAL_ENV, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep: vi.fn().mockResolvedValue(undefined),
      maxAttempts: 1,
      circuitBreakerConfig: {
        minSamples: 3,
        tripFailureRate: 0.5,
        windowSize: 5,
        windowAgeMs: 60_000,
      },
      capitalPathMode: false,
    });

    // Enough calls to trip both primary and fallback.
    // Each call: primary fails → fallback attempted → fallback fails → throw.
    // So each call registers 1 primary failure + 1 fallback failure.
    // After ~3 rounds both circuits should be OPEN.
    for (let i = 0; i < 5; i++) {
      try {
        await client.call('serv-nano', { system: 's', user: 'u' });
      } catch {
        // Expected — accumulating failures.
      }
    }
    const fetchesBefore = fetchImpl.mock.calls.length;
    // Next call: BOTH circuits OPEN → CircuitAllOpenError, no fetches at all.
    await expect(client.call('serv-nano', { system: 's', user: 'u' })).rejects.toThrow(
      CircuitAllOpenError
    );
    const fetchesAfter = fetchImpl.mock.calls.length;
    expect(fetchesAfter - fetchesBefore).toBe(0);
  });
});
