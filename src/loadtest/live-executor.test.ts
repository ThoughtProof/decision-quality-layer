/**
 * Offline tests for the LIVE (production Option-A) load-test backend.
 *
 * These exercise the FULL real wiring — createProductionRuntime →
 * HttpLlmClient (breakers ON) → PotCliCascade(nano→swift, confirm_fail) →
 * runVerification → RuntimeDiagnosticsCollector — with a deterministic
 * injected `fetchImpl` so NO network / provider call is made. They prove the
 * observations are sourced from the real diagnostics collector (not the
 * hard-coded offline 'none'), that alias identities are pinned before the
 * first case, and that no secret / raw text leaks into a record.
 */

import { describe, it, expect, vi } from 'vitest';
import type { DiagnosticsSnapshot, BindingSummary } from '../engine/runtime-diagnostics.js';
import type { TimeoutSource } from '../engine/llm-client.js';
import { buildLiveObservation, createLiveBackend } from './live-executor.js';
import {
  LoadTestHarness,
  type LoadCase,
  type LoadTestConfig,
  type CheckpointIO,
  type LoadTestManifest,
} from './harness.js';
import type { DqlResponse } from '../types.js';

function makeMemIO(): CheckpointIO & { lines: string[]; manifest: LoadTestManifest | null } {
  const state = { lines: [] as string[], manifest: null as LoadTestManifest | null };
  return {
    ...state,
    readManifest() {
      return this.manifest;
    },
    writeManifest(m) {
      this.manifest = m;
    },
    readResultLines() {
      return [...this.lines];
    },
    appendResult(line) {
      this.lines.push(line);
    },
  };
}

// ---------------------------------------------------------------------------
// Env + fetch doubles
// ---------------------------------------------------------------------------

/** pot-cli env pinned to a deterministic base URL; NO real key needed. */
function liveEnv(over: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    SERV_API_KEY: 'sk-loadtest-offline',
    DQL_CAPITAL_PATH_MODE: '0',
    SERV_BASE_URL: 'https://example.test/v1',
    ...over,
  } as unknown as NodeJS.ProcessEnv;
}

/** A fetch that returns a valid PASS body for every call (healthy provider). */
function passFetch(): typeof fetch {
  return (async () =>
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
          },
        ],
        usage: { completion_tokens: 7 },
      }),
      { status: 200 },
    )) as unknown as typeof fetch;
}

const PIN_FP = 'serv:serv-nano:https://example.test/v1';
const PIN_FP_SWIFT = 'serv:serv-swift:https://example.test/v1';

function makeCases(n: number): LoadCase[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `live-case-${i}`,
    expected_fail_axis: 'intent',
    request: { mandate: 'm', proposed_action: 'a', reasoning: 'r', axes: ['intent', 'scope'] },
  }));
}

function liveConfig(backendPins: Record<string, string>, over: Partial<LoadTestConfig> = {}): LoadTestConfig {
  return {
    runId: 'live-offline',
    concurrency: 1,
    hardConcurrencyCap: 4,
    n: 4,
    aliasPins: backendPins,
    deadline: { requestDeadlineMs: 45_000, providerCallBudgetMs: 18_000 },
    scenarioFileHash: 'deadbeef',
    wallClockCapMs: 60_000,
    maxProviderErrorStorm: 10_000,
    maxOpenTransitions: 10_000,
    secretScanValues: ['sk-loadtest-offline'],
    ...over,
  };
}

// ---------------------------------------------------------------------------
// buildLiveObservation — deterministic unit tests (no runtime)
// ---------------------------------------------------------------------------

describe('buildLiveObservation', () => {
  function emptySnapshot(): DiagnosticsSnapshot {
    return {
      requestId: 'r',
      transitions: { items: [], dropped: 0 },
      stale_results: { items: [], dropped: 0 },
      invalid_outcomes: { items: [], dropped: 0 },
      attempts: { items: [], dropped: 0 },
      binding_summaries: { items: [], dropped: 0 },
    };
  }

  function bs(over: Partial<BindingSummary>): BindingSummary {
    return {
      requestId: 'r',
      requestedAlias: 'serv-nano',
      attemptAlias: 'serv-nano',
      route: 'primary',
      ok: true,
      netLatencyMs: 10,
      backoffWaitedMs: 0,
      wallClockMs: 10,
      attemptCount: 1,
      ...over,
    };
  }

  function resp(over: Partial<DqlResponse> = {}): DqlResponse {
    return {
      id: 'r',
      version: 'loadtest',
      axes: [],
      aggregate: { verdict: 'ALLOW', confidence: 0.9, triggered_by: [], rationale: 'x' },
      meta: { duration_ms: 1, models_used: [], axes_evaluated: [], sandbox: false },
      ...over,
    };
  }

  it('attributes per-alias tallies from binding summaries (fallback credited to the serving alias)', () => {
    const snapshot = emptySnapshot();
    (snapshot.binding_summaries as unknown as { items: BindingSummary[] }).items = [
      bs({ attemptAlias: 'serv-nano', ok: true, attemptCount: 2, backoffWaitedMs: 5, netLatencyMs: 12 }),
      bs({ attemptAlias: 'serv-nano', ok: false, attemptCount: 1, netLatencyMs: 3 }),
      bs({ attemptAlias: 'serv-swift', route: 'fallback', ok: true, attemptCount: 1, netLatencyMs: 8 }),
    ];
    const obs = buildLiveObservation(resp(), snapshot, [], 'intent', 'serv-nano');
    expect(obs.per_alias['serv-nano']).toEqual({ calls: 2, served: 1, provider_error: 1, circuit_rejected: 0 });
    expect(obs.per_alias['serv-swift']).toEqual({ calls: 1, served: 1, provider_error: 0, circuit_rejected: 0 });
    expect(obs.provider_calls).toBe(3);
    expect(obs.attempts).toBe(4);
    expect(obs.backoff_ms).toBe(5);
    expect(obs.net_latency_ms).toBe(23);
  });

  it('attributes circuit_rejected axes (no fetch) to the primary alias', () => {
    const snapshot = emptySnapshot();
    const r = resp({
      aggregate: { verdict: 'REVIEW', confidence: 0.5, triggered_by: [], rationale: 'x' },
      axes: [
        { axis: 'intent', verdict: 'UNCERTAIN', confidence: 0.5, reasoning: 'x', objection: 'o', provider_outcome: 'circuit_rejected' },
        { axis: 'scope', verdict: 'UNCERTAIN', confidence: 0.5, reasoning: 'x', objection: 'o', provider_outcome: 'circuit_rejected' },
      ],
    });
    const obs = buildLiveObservation(r, snapshot, [], 'intent', 'serv-nano');
    expect(obs.per_alias['serv-nano']).toEqual({ calls: 2, served: 0, provider_error: 0, circuit_rejected: 2 });
    expect(obs.provider_calls).toBe(0);
  });

  it('picks the most-global deadline source by precedence', () => {
    const mix: TimeoutSource[] = ['attempt_timeout', 'call_budget', 'request_deadline'];
    expect(buildLiveObservation(resp(), emptySnapshot(), mix, undefined, 'serv-nano').deadline_source).toBe(
      'request_deadline',
    );
    expect(
      buildLiveObservation(resp(), emptySnapshot(), ['attempt_timeout', 'call_budget'], undefined, 'serv-nano')
        .deadline_source,
    ).toBe('call_budget');
    expect(buildLiveObservation(resp(), emptySnapshot(), [], undefined, 'serv-nano').deadline_source).toBe('none');
  });

  it('counts OPEN and HALF_OPEN transitions from the snapshot', () => {
    const snapshot = emptySnapshot();
    (snapshot.transitions as unknown as { items: unknown[] }).items = [
      { kind: 'closed_to_open' },
      { kind: 'half_open_to_open' },
      { kind: 'open_to_half_open' },
      { kind: 'half_open_to_closed' },
    ];
    const obs = buildLiveObservation(resp(), snapshot, [], undefined, 'serv-nano');
    expect(obs.transitions).toEqual({ open: 2, half_open: 1 });
  });
});

// ---------------------------------------------------------------------------
// createLiveBackend — full offline wiring through the real production path
// ---------------------------------------------------------------------------

describe('createLiveBackend (offline, deterministic fetchImpl)', () => {
  it('resolves alias pins that match the production route fingerprints', () => {
    const backend = createLiveBackend({
      env: liveEnv(),
      version: 'loadtest',
      deadline: { requestDeadlineMs: 45_000, providerCallBudgetMs: 18_000 },
      clientOptionsOverride: { fetchImpl: passFetch(), sleep: async () => {} },
    });
    expect(backend.aliasPins['serv-nano']).toBe(PIN_FP);
    expect(backend.aliasPins['serv-swift']).toBe(PIN_FP_SWIFT);
    expect(backend.resolveFingerprints()).toEqual(backend.aliasPins);
    // Secret is exposed for the scanner but sourced from env, never the name.
    expect(backend.secretScanValues).toEqual(['sk-loadtest-offline']);
  });

  it('drives the harness end-to-end with real diagnostics-sourced observations', async () => {
    const fetchImpl = vi.fn(passFetch());
    const backend = createLiveBackend({
      env: liveEnv(),
      version: 'loadtest',
      deadline: { requestDeadlineMs: 45_000, providerCallBudgetMs: 18_000 },
      clientOptionsOverride: { fetchImpl: fetchImpl as unknown as typeof fetch, sleep: async () => {} },
    });
    const io = makeMemIO();
    const harness = new LoadTestHarness(liveConfig(backend.aliasPins), makeCases(4), {
      executor: backend.executor,
      io,
      resolveFingerprints: backend.resolveFingerprints,
      probeCircuits: backend.probeCircuits,
    });
    const report = await harness.run();

    expect(report.certifying).toBe(false);
    expect(report.load_test_only).toBe(true);
    expect(report.completed).toBe(4);
    expect(report.aborted).toBe(false);
    // Healthy provider → all axes served on the primary alias.
    expect(report.per_alias['serv-nano']?.served).toBeGreaterThan(0);
    expect(report.per_alias['serv-nano']?.provider_error ?? 0).toBe(0);
    // Live rollups came from the REAL collector, not offline zeros.
    expect(report.live_totals.provider_calls).toBeGreaterThan(0);
    expect(report.live_totals.attempts).toBeGreaterThanOrEqual(report.live_totals.provider_calls);
    // Healthy path → deadline never bit.
    expect(report.deadline_sources.none).toBe(4);
    expect(report.deadline_sources.request_deadline).toBe(0);
    // A real fetch was actually issued per axis (2 axes × 4 cases).
    expect(fetchImpl).toHaveBeenCalled();
  });

  it('captures a real deadline source (not offline none) when the provider budget is exhausted', async () => {
    // A 1ms provider-call budget is already spent by the time the client's
    // first attempt starts, so HttpLlmClient throws DeadlineExceededError
    // ('call_budget') straight out of client.call() — the exact path the
    // DeadlineCapturingClient decorator records. The whole-request deadline
    // stays generous so W is never the trigger.
    const deadline = { requestDeadlineMs: 45_000, providerCallBudgetMs: 1 };
    const backend = createLiveBackend({
      env: liveEnv(),
      version: 'loadtest',
      deadline,
      clientOptionsOverride: { fetchImpl: passFetch(), sleep: async () => {} },
    });
    const io = makeMemIO();
    const harness = new LoadTestHarness(
      liveConfig(backend.aliasPins, { runId: 'live-deadline', deadline }),
      makeCases(4),
      {
        executor: backend.executor,
        io,
        resolveFingerprints: backend.resolveFingerprints,
        probeCircuits: backend.probeCircuits,
      },
    );
    const report = await harness.run();
    const nonNone =
      report.deadline_sources.call_budget +
      report.deadline_sources.request_deadline +
      report.deadline_sources.attempt_timeout;
    // The observation reported a REAL deadline source, replacing offline 'none'.
    expect(nonNone).toBeGreaterThan(0);
    expect(report.deadline_sources.none).toBeLessThan(4);
    // Deadline-exhausted axes are structured provider_error → never served.
    expect(report.per_alias['serv-nano']?.served ?? 0).toBe(0);
  });

  it('aborts BEFORE any provider call when the alias pin does not match', async () => {
    const fetchImpl = vi.fn(passFetch());
    const backend = createLiveBackend({
      env: liveEnv(),
      version: 'loadtest',
      deadline: { requestDeadlineMs: 45_000, providerCallBudgetMs: 18_000 },
      clientOptionsOverride: { fetchImpl: fetchImpl as unknown as typeof fetch, sleep: async () => {} },
    });
    const harness = new LoadTestHarness(
      // Pin the config to a DIFFERENT fingerprint than the backend resolves.
      liveConfig({ ...backend.aliasPins, 'serv-nano': 'serv:serv-nano:https://drifted.example/v1' }),
      makeCases(4),
      {
        executor: backend.executor,
        io: makeMemIO(),
        resolveFingerprints: backend.resolveFingerprints,
        probeCircuits: backend.probeCircuits,
      },
    );
    await expect(harness.run()).rejects.toMatchObject({ reason: 'alias_pin_mismatch' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('never leaks the raw body or secret into a persisted record', async () => {
    const backend = createLiveBackend({
      env: liveEnv(),
      version: 'loadtest',
      deadline: { requestDeadlineMs: 45_000, providerCallBudgetMs: 18_000 },
      clientOptionsOverride: { fetchImpl: passFetch(), sleep: async () => {} },
    });
    const io = makeMemIO();
    const harness = new LoadTestHarness(liveConfig(backend.aliasPins), makeCases(4), {
      executor: backend.executor,
      io,
      resolveFingerprints: backend.resolveFingerprints,
      probeCircuits: backend.probeCircuits,
    });
    await harness.run();
    const blob = io.lines.join('');
    expect(blob).not.toContain('sk-loadtest-offline');
    expect(blob).not.toContain('reasoning');
    expect(blob).not.toContain('objection');
    expect(blob).not.toContain('Bearer');
  });
});
