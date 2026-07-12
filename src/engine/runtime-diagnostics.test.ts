/**
 * v0.4.3.1 §C+integration — RuntimeDiagnosticsCollector integration tests.
 *
 * Five scenarios exercise the full path Handler → Engine → Cascade → Client
 * → Breaker → back into the collector:
 *
 *   C-INT-1  Race      — parallel axes push events without cross-request
 *                        contamination; each request's collector sees only
 *                        its own events.
 *   C-INT-2  Stale     — stale-success (mutation.accepted=false) still
 *                        yields an attempt-attribution row AND records the
 *                        stale_result event in the collector.
 *   C-INT-3  Attribution — attemptAlias on the response is the alias that
 *                          ACTUALLY served the fetch (primary or fallback),
 *                          and every fetch produces exactly one attempt row.
 *   C-INT-4  Fetch-Budget — bounded caps drop the OLDEST record and bump
 *                           dropped_* counters; flood in one stream does
 *                           not starve another.
 *   C-INT-5  Cyclic   — a diagnostics push that throws internally MUST NOT
 *                       poison the client. The client's outer defensive
 *                       catch swallows collector failures.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  RuntimeDiagnosticsCollector,
  DEFAULT_DIAGNOSTICS_CAPS,
  type AttemptAttribution,
} from './runtime-diagnostics.js';
import { HttpLlmClient, CircuitAllOpenError } from './llm-client.js';
import type { CallContext } from './call-context.js';

// -----------------------------------------------------------------------------
// Fixture: a minimal client wired to the DEFAULT_MODEL_MAP with serv-nano
// primary + serv-swift fallback. All I/O is mocked via `fetchImpl`.
// -----------------------------------------------------------------------------

function makeClient(opts: {
  fetchImpl: typeof fetch;
  capitalPathMode?: boolean;
  cbOverrides?: Record<string, Record<string, number>>;
}) {
  const env = {
    SERV_API_KEY: 'test-key',
    SERV_BASE_URL: 'https://inference-api.openserv.ai/v1',
  } as unknown as NodeJS.ProcessEnv;
  const modelMap = {
    'serv-nano': {
      provider: 'serv' as const,
      modelId: 'serv-nano',
      apiKeyEnv: 'SERV_API_KEY',
      baseUrl: 'https://inference-api.openserv.ai/v1',
      fallbackAlias: 'serv-swift',
    },
    'serv-swift': {
      provider: 'serv' as const,
      modelId: 'serv-swift',
      apiKeyEnv: 'SERV_API_KEY',
      baseUrl: 'https://inference-api.openserv.ai/v1',
      fallbackAlias: null,
    },
  };
  return new HttpLlmClient(modelMap, env, {
    fetchImpl: opts.fetchImpl,
    maxAttempts: 1,
    sleep: async () => {},
    capitalPathMode: opts.capitalPathMode ?? false,
    circuitBreakerConfigByAlias: opts.cbOverrides ?? {
      'serv-nano': {
        minSamples: 2,
        windowSize: 4,
        windowAgeMs: 60_000,
        tripFailureRate: 0.5,
        tripP90LatencyMs: 999_999,
        cooldownMs: 30_000,
        probeMaxLatencyMs: 999_999,
      },
      'serv-swift': {
        minSamples: 2,
        windowSize: 4,
        windowAgeMs: 60_000,
        tripFailureRate: 0.5,
        tripP90LatencyMs: 999_999,
        cooldownMs: 30_000,
        probeMaxLatencyMs: 999_999,
      },
    },
  });
}

function jsonOk(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

const CHAT_OK = {
  choices: [{ message: { content: '{"verdict":"PASS","confidence":0.9}' } }],
};

// -----------------------------------------------------------------------------
// C-INT-1 Race — parallel calls, each with its own collector
// -----------------------------------------------------------------------------

describe('C-INT-1 Race — per-request collector isolation', () => {
  it('parallel calls with independent collectors see only their own events', async () => {
    const fetchImpl = vi.fn(async () => jsonOk(CHAT_OK));
    const client = makeClient({ fetchImpl });

    const collectorA = new RuntimeDiagnosticsCollector('req-A');
    const collectorB = new RuntimeDiagnosticsCollector('req-B');
    const ctxA: CallContext = { requestId: 'req-A', collector: collectorA };
    const ctxB: CallContext = { requestId: 'req-B', collector: collectorB };

    await Promise.all([
      client.call('serv-nano', { system: 's', user: 'u' }, ctxA),
      client.call('serv-nano', { system: 's', user: 'u' }, ctxB),
    ]);

    const snapA = collectorA.flush();
    const snapB = collectorB.flush();

    // Each collector sees exactly one attempt row (its own).
    expect(snapA.attempts.items.length).toBe(1);
    expect(snapB.attempts.items.length).toBe(1);
    expect(snapA.attempts.items[0]?.requestId).toBe('req-A');
    expect(snapB.attempts.items[0]?.requestId).toBe('req-B');
    // No cross-contamination.
    expect(snapA.attempts.items[0]?.requestId).not.toBe('req-B');
    expect(snapB.attempts.items[0]?.requestId).not.toBe('req-A');
  });
});

// -----------------------------------------------------------------------------
// C-INT-2 Stale — stale_result event is captured
// -----------------------------------------------------------------------------

describe('C-INT-2 Stale — stale_result event flows into collector', () => {
  it('recordOutcome with an already-consumed token yields a stale_result in the snapshot', async () => {
    const fetchImpl = vi.fn(async () => jsonOk(CHAT_OK));
    const client = makeClient({ fetchImpl });
    const collector = new RuntimeDiagnosticsCollector('req-stale');
    const ctx: CallContext = { requestId: 'req-stale', collector };

    // Grab the breaker directly and simulate a stale re-report by consuming
    // the same token twice. First recordOutcome accepts; second yields a
    // stale_result event.
    const breaker = client._testOnlyGetBreaker('serv-nano');
    const admission = breaker.admit();
    breaker.recordOutcome(admission.token, { ok: true, netLatencyMs: 10 });
    const stale = breaker.recordOutcome(admission.token, { ok: true, netLatencyMs: 10 });
    // Sanity: the second call is not accepted and yields a stale_result event.
    expect(stale.accepted).toBe(false);
    expect(stale.events.some((e) => e.kind === 'stale_result')).toBe(true);

    // Now use the client to make a real call so we exercise event forwarding
    // through the client path. The stale event above is orthogonal; here we
    // simply verify the collector routes events into the correct bucket.
    // Push the stale event directly through the collector to confirm bucketing.
    collector.recordEvents(stale.events);
    await client.call('serv-nano', { system: 's', user: 'u' }, ctx);

    const snap = collector.flush();
    expect(snap.stale_results.items.length).toBeGreaterThanOrEqual(1);
    expect(snap.stale_results.items[0]?.reason).toMatch(/already_consumed|invalid_token/);
    // Attempt row from the real call is still there.
    expect(snap.attempts.items.length).toBe(1);
  });
});

// -----------------------------------------------------------------------------
// C-INT-3 Attribution — attemptAlias reflects the alias that actually served
// -----------------------------------------------------------------------------

describe('C-INT-3 Attribution — attemptAlias matches the served alias', () => {
  it('primary success: attemptAlias === requested alias', async () => {
    const fetchImpl = vi.fn(async () => jsonOk(CHAT_OK));
    const client = makeClient({ fetchImpl });
    const collector = new RuntimeDiagnosticsCollector('req-attr-1');
    const ctx: CallContext = { requestId: 'req-attr-1', collector };

    const out = await client.call('serv-nano', { system: 's', user: 'u' }, ctx);
    expect(out.providerRoute).toBe('primary');
    expect(out.attemptAlias).toBe('serv-nano');

    const snap = collector.flush();
    expect(snap.attempts.items.length).toBe(1);
    const row = snap.attempts.items[0] as AttemptAttribution;
    expect(row.requestedAlias).toBe('serv-nano');
    expect(row.attemptAlias).toBe('serv-nano');
    expect(row.route).toBe('primary');
    expect(row.ok).toBe(true);
  });

  it('primary open → fallback success: attemptAlias === fallbackAlias', async () => {
    // Force primary breaker to be OPEN before the call so the client hands
    // off to the fallback without a primary fetch.
    const fetchImpl = vi.fn(async () => jsonOk(CHAT_OK));
    const client = makeClient({ fetchImpl });
    // Warm primary to OPEN via 2 direct failures.
    const primary = client._testOnlyGetBreaker('serv-nano');
    primary.recordOutcome(primary.admit().token, { ok: false, netLatencyMs: 10 });
    primary.recordOutcome(primary.admit().token, { ok: false, netLatencyMs: 10 });
    expect(primary.snapshot().state).toBe('OPEN');

    const collector = new RuntimeDiagnosticsCollector('req-attr-2');
    const ctx: CallContext = { requestId: 'req-attr-2', collector };
    const out = await client.call('serv-nano', { system: 's', user: 'u' }, ctx);

    expect(out.providerRoute).toBe('fallback');
    expect(out.attemptAlias).toBe('serv-swift');

    const snap = collector.flush();
    // Exactly one attempt row — the fallback fetch. No primary fetch was
    // started because the primary breaker was already OPEN at admit().
    expect(snap.attempts.items.length).toBe(1);
    const row = snap.attempts.items[0] as AttemptAttribution;
    expect(row.requestedAlias).toBe('serv-nano');
    expect(row.attemptAlias).toBe('serv-swift');
    expect(row.route).toBe('fallback');
    expect(row.ok).toBe(true);
  });
});

// -----------------------------------------------------------------------------
// C-INT-4 Fetch-Budget — bounded caps + per-stream drop counters
// -----------------------------------------------------------------------------

describe('C-INT-4 Fetch-Budget — bounded caps + drop counters', () => {
  it('overflow drops OLDEST and increments dropped_* counter without starving other streams', () => {
    const collector = new RuntimeDiagnosticsCollector('req-budget', {
      maxTransitions: 2,
      maxStaleResults: 2,
      maxInvalidOutcomes: 2,
      maxAttempts: 100,
    });
    // Push 5 transitions into a cap-of-2 stream.
    for (let i = 0; i < 5; i++) {
      collector.recordEvents([
        {
          kind: 'closed_to_open',
          reason: 'failure_rate',
          alias: `alias-${i}`,
          from: 'CLOSED',
          to: 'OPEN',
          at: i,
          tripGeneration: i,
          stateRevision: i,
        },
      ]);
    }
    // Also push one stale — must survive despite the transition flood.
    collector.recordEvents([
      {
        kind: 'stale_result',
        reason: 'already_consumed',
        alias: 'alias-x',
        at: 42,
        stateRevision: 1,
      },
    ]);

    const snap = collector.flush();
    // Transitions cap=2 with 5 pushes: 2 kept, 3 dropped.
    expect(snap.transitions.items.length).toBe(2);
    expect(snap.transitions.dropped).toBe(3);
    // Oldest dropped → the two survivors are the LAST two pushes.
    expect(snap.transitions.items.map((e) => e.alias)).toEqual(['alias-3', 'alias-4']);
    // Stale stream unaffected by transition flood.
    expect(snap.stale_results.items.length).toBe(1);
    expect(snap.stale_results.dropped).toBe(0);
  });

  it('DEFAULT_DIAGNOSTICS_CAPS are frozen and sensible', () => {
    expect(Object.isFrozen(DEFAULT_DIAGNOSTICS_CAPS)).toBe(true);
    expect(DEFAULT_DIAGNOSTICS_CAPS.maxTransitions).toBeGreaterThanOrEqual(100);
    expect(DEFAULT_DIAGNOSTICS_CAPS.maxStaleResults).toBeGreaterThanOrEqual(10);
    expect(DEFAULT_DIAGNOSTICS_CAPS.maxInvalidOutcomes).toBeGreaterThanOrEqual(10);
    expect(DEFAULT_DIAGNOSTICS_CAPS.maxAttempts).toBeGreaterThanOrEqual(20);
  });
});

// -----------------------------------------------------------------------------
// C-INT-5 Cyclic — diagnostics failure must not poison the client
// -----------------------------------------------------------------------------

describe('C-INT-5 Cyclic — collector failure never poisons the client', () => {
  it('a throwing collector.recordEvents does not turn a 200 into a 500', async () => {
    const fetchImpl = vi.fn(async () => jsonOk(CHAT_OK));
    const client = makeClient({ fetchImpl });
    const collector = new RuntimeDiagnosticsCollector('req-cyclic');
    // Sabotage the collector: recordEvents always throws. The client MUST
    // swallow this inside recordEventsToCtx.
    vi.spyOn(collector, 'recordEvents').mockImplementation(() => {
      throw new Error('cyclic-diagnostics-explosion');
    });
    // Also sabotage attempt recording — same swallow contract applies.
    vi.spyOn(collector, 'recordAttempt').mockImplementation(() => {
      throw new Error('cyclic-diagnostics-attempt-explosion');
    });
    const ctx: CallContext = { requestId: 'req-cyclic', collector };

    // The call must succeed end-to-end.
    const out = await client.call('serv-nano', { system: 's', user: 'u' }, ctx);
    expect(out.providerRoute).toBe('primary');
    expect(out.attemptAlias).toBe('serv-nano');
  });

  it('a throwing collector on the fallback path also does not poison the response', async () => {
    const fetchImpl = vi.fn(async () => jsonOk(CHAT_OK));
    const client = makeClient({ fetchImpl });
    // Prime primary breaker to OPEN.
    const primary = client._testOnlyGetBreaker('serv-nano');
    primary.recordOutcome(primary.admit().token, { ok: false, netLatencyMs: 10 });
    primary.recordOutcome(primary.admit().token, { ok: false, netLatencyMs: 10 });
    expect(primary.snapshot().state).toBe('OPEN');

    const collector = new RuntimeDiagnosticsCollector('req-cyclic-fb');
    vi.spyOn(collector, 'recordEvents').mockImplementation(() => {
      throw new Error('fallback-diagnostics-boom');
    });
    vi.spyOn(collector, 'recordAttempt').mockImplementation(() => {
      throw new Error('fallback-attempt-boom');
    });
    const ctx: CallContext = { requestId: 'req-cyclic-fb', collector };

    const out = await client.call('serv-nano', { system: 's', user: 'u' }, ctx);
    expect(out.providerRoute).toBe('fallback');
    expect(out.attemptAlias).toBe('serv-swift');
  });

  it('a throwing collector during a HALF_OPEN probe does not poison the response', async () => {
    // This is the DISCRIMINATING variant: it forces an actual event stream
    // into the collector (open_to_half_open on admit, half_open_to_closed
    // on recordOutcome), so removing the try/catch guard in the client's
    // recordEventsToCtx would surface as a rethrow — which this test
    // catches by asserting the call resolves rather than rejects.
    let now = 0;
    const fetchImpl = vi.fn(async () => jsonOk(CHAT_OK));
    const env = {
      SERV_API_KEY: 'test-key',
      SERV_BASE_URL: 'https://inference-api.openserv.ai/v1',
    } as unknown as NodeJS.ProcessEnv;
    const modelMap = {
      'serv-nano': {
        provider: 'serv' as const,
        modelId: 'serv-nano',
        apiKeyEnv: 'SERV_API_KEY',
        baseUrl: 'https://inference-api.openserv.ai/v1',
        fallbackAlias: null,
      },
    };
    const client = new HttpLlmClient(modelMap, env, {
      fetchImpl,
      maxAttempts: 1,
      sleep: async () => {},
      circuitBreakerConfigByAlias: {
        'serv-nano': {
          minSamples: 2,
          windowSize: 4,
          windowAgeMs: 60_000,
          tripFailureRate: 0.5,
          tripP90LatencyMs: 999_999,
          cooldownMs: 30_000,
          probeMaxLatencyMs: 999_999,
          now: () => now,
        },
      },
    });
    // Trip the primary to OPEN, then advance past cooldown so admit() emits
    // open_to_half_open.
    const cb = client._testOnlyGetBreaker('serv-nano');
    cb.recordOutcome(cb.admit().token, { ok: false, netLatencyMs: 10 });
    cb.recordOutcome(cb.admit().token, { ok: false, netLatencyMs: 10 });
    expect(cb.snapshot().state).toBe('OPEN');
    now += 31_000;

    const collector = new RuntimeDiagnosticsCollector('req-cyclic-probe');
    vi.spyOn(collector, 'recordEvents').mockImplementation(() => {
      throw new Error('probe-diagnostics-explosion');
    });
    const ctx: CallContext = { requestId: 'req-cyclic-probe', collector };

    // The call succeeds despite the sabotaged collector receiving TWO event
    // batches (admit + recordOutcome). If the client's recordEventsToCtx
    // guard is removed, this would rethrow instead.
    const out = await client.call('serv-nano', { system: 's', user: 'u' }, ctx);
    expect(out.providerRoute).toBe('primary');
  });

  it('CircuitAllOpenError still throws normally even when the collector is sabotaged', async () => {
    const fetchImpl = vi.fn(async () => jsonOk(CHAT_OK));
    const client = makeClient({ fetchImpl, capitalPathMode: true });
    const primary = client._testOnlyGetBreaker('serv-nano');
    primary.recordOutcome(primary.admit().token, { ok: false, netLatencyMs: 10 });
    primary.recordOutcome(primary.admit().token, { ok: false, netLatencyMs: 10 });
    expect(primary.snapshot().state).toBe('OPEN');

    const collector = new RuntimeDiagnosticsCollector('req-cyclic-cpm');
    vi.spyOn(collector, 'recordEvents').mockImplementation(() => {
      throw new Error('cpm-diagnostics-boom');
    });
    const ctx: CallContext = { requestId: 'req-cyclic-cpm', collector };

    await expect(
      client.call('serv-nano', { system: 's', user: 'u' }, ctx),
    ).rejects.toBeInstanceOf(CircuitAllOpenError);
  });
});
