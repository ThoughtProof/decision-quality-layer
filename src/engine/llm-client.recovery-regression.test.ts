/**
 * Client-Level End-to-End Recovery Regression Test
 *
 * Purpose: Verify Hermes' claim from v0.4.3.1 Gate-Architecture-Decision
 * (2026-07-11) that HttpLlmClient.call() DOES re-invoke primaryBreaker.canProceed()
 * on every axis request, meaning existing cooldown → HALF_OPEN → CLOSED recovery
 * IS reachable on current code without any router change.
 *
 * If this test is GREEN on current code, Perplexity's "router-cadence-bug" claim
 * was wrong — v5 becomes: calibration + telemetry + tests + live-drill.
 *
 * If this test is unexpectedly RED, a minimal router fix must be designed.
 *
 * The test uses fake clock (CB.now injection) and fake sleep/fetch. NO PRODUCT
 * CODE CHANGE.
 */

import { describe, expect, it, vi } from 'vitest';
import { CircuitAllOpenError, HttpLlmClient, type ModelBinding } from './llm-client.js';

const BINDING: Record<string, ModelBinding> = {
  'primary-alias': {
    provider: 'serv',
    modelId: 'serv-swift',
    apiKeyEnv: 'TEST_API_KEY',
    baseUrl: 'https://example.test/v1',
    fallbackAlias: 'fallback-alias',
  },
  'fallback-alias': {
    provider: 'serv',
    modelId: 'serv-nano',
    apiKeyEnv: 'TEST_API_KEY',
    baseUrl: 'https://example.test/v1',
    fallbackAlias: null,
  },
};

const ENV = { TEST_API_KEY: 'sk-test' } as unknown as NodeJS.ProcessEnv;

function makeOkResponse(content = '{"verdict":"PASS","confidence":0.9}'): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function makeSlowSuccessResponse(content = '{"verdict":"PASS","confidence":0.9}'): Response {
  // Same body — we control "slow" via the fetch mock delaying manually.
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('HttpLlmClient — HALF_OPEN recovery on current code (no router change)', () => {
  it('after cooldown elapses, next primary call transitions OPEN→HALF_OPEN and closes CB on healthy probe', async () => {
    // ---------- fake clock (shared by CB.now and our advance() helper) ----------
    let currentTime = 1_000_000;
    const now = () => currentTime;
    const advance = (ms: number) => {
      currentTime += ms;
    };

    // ---------- fake sleep (does NOT advance CB clock — we do that explicitly) ----------
    const sleep = vi.fn().mockResolvedValue(undefined);

    // ---------- fetch orchestration ----------
    // Sequence:
    //  Phase 1: 5 slow primary calls (20s each) → CB samples that trip p90>15s
    //  Phase 2: 1 primary call BEFORE cooldown → CircuitOpenError → fallback runs
    //  Phase 3: advance clock past cooldown → 1 primary call → HALF_OPEN probe (fast) → CLOSED
    //  Phase 4: 1 more primary call → normal CLOSED path
    const fetchCallLog: Array<{ alias: string; latencyReported: number }> = [];
    let phase = 1;

    const fetchImpl = vi.fn().mockImplementation(async (url: string) => {
      // Determine which model was called by peeking at request body isn't
      // possible without more setup; we track via the phase state machine.
      // For our purposes, every fetch returns OK — CB latency comes from
      // clock advancement between "call started" and "call returned", which
      // we control via advance() before returning.
      return makeOkResponse();
    });

    const client = new HttpLlmClient(BINDING, ENV, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep,
      maxAttempts: 1, // no retries — cleaner CB accounting
      circuitBreakerConfig: {
        windowSize: 20,
        windowAgeMs: 600_000,   // long window so all 5 samples count
        tripP90LatencyMs: 15_000,
        minSamples: 5,
        cooldownMs: 30_000,
        probeMaxLatencyMs: 15_000,
        now,   // ← fake clock injected into CB
      },
    });

    // ---------- helper: run a primary call with controlled elapsed time ----------
    // Since HttpLlmClient uses Date.now() internally to compute wallClock latency
    // for CB.recordSuccess, we need to advance the clock DURING the call. We do
    // that by hooking into the fetch mock to advance before returning.
    let nextElapsedMs = 0;
    fetchImpl.mockImplementation(async () => {
      advance(nextElapsedMs);
      return makeOkResponse();
    });

    // But HttpLlmClient uses Date.now(), not CB.now(). We need Date.now to also
    // return currentTime. Monkey-patch Date.now for this test.
    const origDateNow = Date.now;
    Date.now = () => currentTime;

    try {
      // ============ Phase 1: 5 slow primary calls (20s each) — trip CB ============
      for (let i = 0; i < 5; i++) {
        nextElapsedMs = 20_000; // 20s > tripP90LatencyMs=15s
        const out = await client.call('primary-alias', { system: 's', user: `u${i}` });
        expect(out.providerRoute).toBe('primary');
      }

      // CB should now be OPEN after evaluating trip on the 5th sample
      const snapAfterPhase1 = client.circuitSnapshot();
      expect(snapAfterPhase1['primary-alias'].state).toBe('OPEN');

      // ============ Phase 2: primary call BEFORE cooldown → fallback ============
      // Advance a little but stay within cooldown
      advance(10_000); // 10s elapsed since trip, cooldown=30s → still OPEN
      nextElapsedMs = 100; // fallback is fast
      const outPhase2 = await client.call('primary-alias', { system: 's', user: 'phase2' });
      expect(outPhase2.providerRoute).toBe('fallback');

      // ============ Phase 3: advance past cooldown → next primary call = HALF_OPEN probe ============
      advance(25_000); // total 35s since trip > 30s cooldown
      nextElapsedMs = 5_000; // fast healthy probe (5s ≤ probeMaxLatencyMs=15s)
      const outPhase3 = await client.call('primary-alias', { system: 's', user: 'phase3' });

      // Critical assertion: the call went to PRIMARY (probe was granted),
      // not fallback. This proves canProceed() transitioned OPEN → HALF_OPEN
      // on the current code, WITHOUT any router-cadence change.
      expect(outPhase3.providerRoute).toBe('primary');

      // CB should now be CLOSED after successful probe
      const snapAfterPhase3 = client.circuitSnapshot();
      expect(snapAfterPhase3['primary-alias'].state).toBe('CLOSED');

      // ============ Phase 4: subsequent primary call is normal CLOSED path ============
      nextElapsedMs = 1_000;
      const outPhase4 = await client.call('primary-alias', { system: 's', user: 'phase4' });
      expect(outPhase4.providerRoute).toBe('primary');
      expect(client.circuitSnapshot()['primary-alias'].state).toBe('CLOSED');
    } finally {
      Date.now = origDateNow;
    }
  });

  it('slow HALF_OPEN probe (over probeMaxLatencyMs) re-trips CB with fresh cooldown', async () => {
    let currentTime = 2_000_000;
    const now = () => currentTime;
    const advance = (ms: number) => {
      currentTime += ms;
    };
    const sleep = vi.fn().mockResolvedValue(undefined);
    const origDateNow = Date.now;
    Date.now = () => currentTime;

    let nextElapsedMs = 0;
    const fetchImpl = vi.fn().mockImplementation(async () => {
      advance(nextElapsedMs);
      return makeOkResponse();
    });

    const client = new HttpLlmClient(BINDING, ENV, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep,
      maxAttempts: 1,
      circuitBreakerConfig: {
        windowSize: 20,
        windowAgeMs: 600_000,
        tripP90LatencyMs: 15_000,
        minSamples: 5,
        cooldownMs: 30_000,
        probeMaxLatencyMs: 15_000,
        now,
      },
    });

    try {
      // Trip CB
      for (let i = 0; i < 5; i++) {
        nextElapsedMs = 20_000;
        await client.call('primary-alias', { system: 's', user: `u${i}` });
      }
      expect(client.circuitSnapshot()['primary-alias'].state).toBe('OPEN');

      // Advance past cooldown
      advance(31_000);

      // Slow probe: 25s > probeMaxLatencyMs=15s → CB should re-trip
      nextElapsedMs = 25_000;
      const out = await client.call('primary-alias', { system: 's', user: 'slow-probe' });

      // The probe still returned "primary" for THIS call (it was granted, and
      // the call succeeded — CB re-trips on the recorded latency post-return).
      expect(out.providerRoute).toBe('primary');
      expect(client.circuitSnapshot()['primary-alias'].state).toBe('OPEN');

      // Immediate next call: OPEN with fresh cooldown → fallback
      nextElapsedMs = 100;
      const outNext = await client.call('primary-alias', { system: 's', user: 'after-retrip' });
      expect(outNext.providerRoute).toBe('fallback');
    } finally {
      Date.now = origDateNow;
    }
  });

  it('capitalPathMode=true: before cooldown → fail-closed; after cooldown → HALF_OPEN probe on primary (never fallback)', async () => {
    let currentTime = 3_000_000;
    const now = () => currentTime;
    const advance = (ms: number) => {
      currentTime += ms;
    };
    const sleep = vi.fn().mockResolvedValue(undefined);
    const origDateNow = Date.now;
    Date.now = () => currentTime;

    let nextElapsedMs = 0;
    const fetchImpl = vi.fn().mockImplementation(async () => {
      advance(nextElapsedMs);
      return makeOkResponse();
    });

    const client = new HttpLlmClient(BINDING, ENV, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep,
      maxAttempts: 1,
      capitalPathMode: true,
      circuitBreakerConfig: {
        windowSize: 20,
        windowAgeMs: 600_000,
        tripP90LatencyMs: 15_000,
        minSamples: 5,
        cooldownMs: 30_000,
        probeMaxLatencyMs: 15_000,
        now,
      },
    });

    try {
      // Trip CB
      for (let i = 0; i < 5; i++) {
        nextElapsedMs = 20_000;
        await client.call('primary-alias', { system: 's', user: `u${i}` });
      }
      expect(client.circuitSnapshot()['primary-alias'].state).toBe('OPEN');

      // Before cooldown: fail-closed, NO fallback
      advance(10_000);
      nextElapsedMs = 100;
      await expect(
        client.call('primary-alias', { system: 's', user: 'capital-before-cooldown' })
      ).rejects.toBeInstanceOf(CircuitAllOpenError);

      // After cooldown: primary probe allowed even in capitalPathMode
      advance(25_000); // total 35s > 30s cooldown
      nextElapsedMs = 5_000;
      const out = await client.call('primary-alias', { system: 's', user: 'capital-after-cooldown' });
      expect(out.providerRoute).toBe('primary'); // probe went to primary
      expect(client.circuitSnapshot()['primary-alias'].state).toBe('CLOSED');
    } finally {
      Date.now = origDateNow;
    }
  });
});
