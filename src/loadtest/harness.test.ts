import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import type { DqlResponse, AxisResult, AggregateVerdict } from '../types.js';
import type { CircuitDiagnostic } from '../engine/llm-client.js';
import {
  LoadTestHarness,
  LoadTestAbort,
  buildObservation,
  classifyMovement,
  computeIdentityHash,
  assertNonCertifying,
  sha256Hex,
  defaultAliasResolver,
  type LoadCase,
  type LoadTestConfig,
  type CheckpointIO,
  type CaseExecutor,
  type CaseObservation,
  type LoadTestManifest,
} from './harness.js';

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

function memIO(seedManifest?: LoadTestManifest, seedLines: string[] = []): CheckpointIO & {
  lines: string[];
  manifest: LoadTestManifest | null;
} {
  const state = { lines: [...seedLines], manifest: seedManifest ?? null };
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

const PINS = {
  'serv-nano': 'serv:serv-nano:https://example.test/v1',
  'serv-swift': 'serv:serv-swift:https://example.test/v1',
};

function baseConfig(over: Partial<LoadTestConfig> = {}): LoadTestConfig {
  return {
    runId: 'lt-test',
    concurrency: 2,
    hardConcurrencyCap: 4,
    n: 4,
    aliasPins: { ...PINS },
    deadline: { requestDeadlineMs: 60_000, providerCallBudgetMs: 40_000 },
    scenarioFileHash: 'deadbeef',
    wallClockCapMs: 60_000,
    maxProviderErrorStorm: 1_000,
    maxOpenTransitions: 1_000,
    secretScanValues: ['sk-supersecret'],
    ...over,
  };
}

function makeCases(n: number): LoadCase[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `case-${i}`,
    expected_fail_axis: 'intent',
    request: {
      mandate: 'm',
      proposed_action: 'a',
      reasoning: 'r',
      axes: ['intent', 'scope', 'risk', 'consistency', 'reversibility'],
    },
  }));
}

function axis(
  name: string,
  verdict: AxisResult['verdict'],
  outcome?: AxisResult['provider_outcome'],
  route: AxisResult['provider_route'] = 'primary',
): AxisResult {
  return {
    axis: name as AxisResult['axis'],
    verdict,
    confidence: 0.9,
    reasoning: 'x',
    objection: verdict === 'PASS' ? '' : 'o',
    ...(route ? { provider_route: route } : {}),
    ...(outcome ? { provider_outcome: outcome } : {}),
  };
}

function makeResponse(
  aggregate: AggregateVerdict,
  axes: AxisResult[],
  models_used = ['serv:serv-nano', 'serv:serv-swift'],
): DqlResponse {
  return {
    id: 'r',
    version: 'loadtest',
    axes,
    aggregate: { verdict: aggregate, confidence: 0.9, triggered_by: [], rationale: 'x' },
    meta: { duration_ms: 1, models_used, axes_evaluated: [], sandbox: false },
  };
}

/** A served-everywhere BLOCK response with the expected axis FAILing. */
function servedBlock(): DqlResponse {
  return makeResponse('BLOCK', [
    axis('intent', 'FAIL', 'served'),
    axis('scope', 'PASS', 'served'),
    axis('risk', 'PASS', 'served'),
    axis('consistency', 'PASS', 'served'),
    axis('reversibility', 'PASS', 'served'),
  ]);
}

function fixedExecutor(response: DqlResponse): CaseExecutor {
  return vi.fn(async () => ({ response }));
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe('loadtest pure helpers', () => {
  it('buildObservation attributes provider outcomes per alias', () => {
    const resp = makeResponse('REVIEW', [
      axis('intent', 'UNCERTAIN', 'circuit_rejected', 'primary'),
      axis('scope', 'PASS', 'served', 'primary'),
      axis('risk', 'UNCERTAIN', 'provider_error', 'fallback'),
      axis('consistency', 'PASS', 'served', 'fallback'),
      axis('reversibility', 'PASS', 'served', 'primary'),
    ]);
    const obs = buildObservation(resp, 'intent', defaultAliasResolver);
    expect(obs.per_alias['serv-nano']).toEqual({
      calls: 3,
      served: 2,
      provider_error: 0,
      circuit_rejected: 1,
    });
    expect(obs.per_alias['serv-swift']).toEqual({
      calls: 2,
      served: 1,
      provider_error: 1,
      circuit_rejected: 0,
    });
    // intent axis was UNCERTAIN (not FAIL) → recall miss signal.
    expect(obs.axis_hit).toBe(false);
  });

  it('classifyMovement distinguishes false_allow, recall_miss, expected_catch, no_ground_truth', () => {
    const base: CaseObservation = {
      aggregate_verdict: 'ALLOW',
      axis_hit: false,
      per_alias: {},
      deadline_source: 'none',
    };
    expect(classifyMovement({ ...base, aggregate_verdict: 'ALLOW', axis_hit: false })).toBe('false_allow');
    expect(classifyMovement({ ...base, aggregate_verdict: 'REVIEW', axis_hit: false })).toBe('recall_miss');
    expect(classifyMovement({ ...base, aggregate_verdict: 'BLOCK', axis_hit: true })).toBe('expected_catch');
    expect(classifyMovement({ ...base, aggregate_verdict: 'ALLOW', axis_hit: null })).toBe('no_ground_truth');
  });

  it('computeIdentityHash is stable and sensitive to selection changes', () => {
    const cfg = baseConfig();
    const h1 = computeIdentityHash(cfg, ['a', 'b', 'c', 'd']);
    const h2 = computeIdentityHash(cfg, ['a', 'b', 'c', 'd']);
    const h3 = computeIdentityHash(cfg, ['a', 'b', 'c', 'x']);
    expect(h1).toBe(h2);
    expect(h1).not.toBe(h3);
  });

  it('assertNonCertifying rejects certification fields and bad stamps', () => {
    expect(() => assertNonCertifying({ certifying: false, load_test_only: true })).not.toThrow();
    expect(() => assertNonCertifying({ certified: true })).toThrow(/certification field/);
    expect(() => assertNonCertifying({ certifying: true })).toThrow(/certifying must be false/);
    expect(() => assertNonCertifying({ certifying: false, load_test_only: false })).toThrow(/load_test_only/);
  });

  it('assertNonCertifying walks nested objects/arrays and the broadened key set', () => {
    // Deeply-nested certification-like key is still caught.
    expect(() => assertNonCertifying({ a: { b: [{ c: { certificate: 'x' } }] } })).toThrow(
      /forbidden certification field 'certificate' at \$\.a\.b\[0\]\.c/,
    );
    // Rate/calibration vocabulary as KEYS is rejected.
    for (const key of ['far', 'fbr', 'false_allow_rate', 'false_block_rate', 'recall_rate', 'precision_rate', 'calibration', 'attestation', 'accreditation', 'production_ready']) {
      expect(() => assertNonCertifying({ [key]: 1 })).toThrow(/forbidden certification field/);
    }
    // A nested bad stamp value is caught at depth.
    expect(() => assertNonCertifying({ report: { certifying: true } })).toThrow(/certifying must be false/);
    // Movement enum VALUES ('false_allow' etc.) are legitimate and must pass.
    expect(() =>
      assertNonCertifying({
        certifying: false,
        load_test_only: true,
        movements: { false_allow: 2, recall_miss: 1, expected_catch: 3 },
        results: [{ movement: 'false_allow' }, { movement: 'recall_miss' }],
      }),
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Identity hash — every operational knob is bound
// ---------------------------------------------------------------------------

describe('loadtest identity hash binds operational caps', () => {
  const ids = ['a', 'b', 'c', 'd'];
  const base = () => computeIdentityHash(baseConfig(), ids);

  it('changes when concurrency, caps, storm, or wall-clock drift', () => {
    expect(computeIdentityHash(baseConfig({ concurrency: 1 }), ids)).not.toBe(base());
    expect(computeIdentityHash(baseConfig({ hardConcurrencyCap: 8 }), ids)).not.toBe(base());
    expect(computeIdentityHash(baseConfig({ wallClockCapMs: 30_000 }), ids)).not.toBe(base());
    expect(computeIdentityHash(baseConfig({ maxProviderErrorStorm: 500 }), ids)).not.toBe(base());
    expect(computeIdentityHash(baseConfig({ maxOpenTransitions: 5 }), ids)).not.toBe(base());
  });

  it('is stable when only non-identity fields change', () => {
    // secretScanValues is defense-in-depth, not part of the experiment identity.
    expect(computeIdentityHash(baseConfig({ secretScanValues: ['other'] }), ids)).toBe(base());
  });
});

// ---------------------------------------------------------------------------
// Construction guards
// ---------------------------------------------------------------------------

describe('loadtest construction guards', () => {
  const deps = () => ({
    executor: fixedExecutor(servedBlock()),
    io: memIO(),
    resolveFingerprints: () => ({ ...PINS }),
  });

  it('rejects concurrency above the hard cap', () => {
    expect(() => new LoadTestHarness(baseConfig({ concurrency: 8 }), makeCases(4), deps())).toThrow(
      /hard cap/,
    );
  });

  it('rejects concurrency below 1', () => {
    expect(() => new LoadTestHarness(baseConfig({ concurrency: 0 }), makeCases(4), deps())).toThrow(
      /≥ 1/,
    );
  });

  it('rejects a case selection whose size != pinned n', () => {
    expect(() => new LoadTestHarness(baseConfig({ n: 5 }), makeCases(4), deps())).toThrow(/!= pinned n/);
  });
});

// ---------------------------------------------------------------------------
// Happy path + metrics
// ---------------------------------------------------------------------------

describe('loadtest run — offline happy path', () => {
  for (const concurrency of [1, 2, 4]) {
    it(`completes all cases at concurrency ${concurrency} and stamps non-certifying`, async () => {
      const io = memIO();
      const executor = fixedExecutor(servedBlock());
      const harness = new LoadTestHarness(baseConfig({ concurrency }), makeCases(4), {
        executor,
        io,
        resolveFingerprints: () => ({ ...PINS }),
      });
      const report = await harness.run();

      expect(report.certifying).toBe(false);
      expect(report.load_test_only).toBe(true);
      expect(report.completed).toBe(4);
      expect(report.aborted).toBe(false);
      expect(report.abort_reason).toBeNull();
      expect(executor).toHaveBeenCalledTimes(4);
      // 4 cases × served BLOCK with expected FAIL → all expected catches.
      expect(report.movements.expected_catch).toBe(4);
      expect(report.aggregate_verdicts.BLOCK).toBe(4);
      // Per-alias served counts: 5 served axes/case × 4 cases, all primary.
      expect(report.per_alias['serv-nano']?.served).toBe(20);
      expect(io.lines).toHaveLength(4);
      // Manifest persisted with identity hash.
      expect(io.manifest?.certifying).toBe(false);
      expect(io.manifest?.identityHash).toBeTruthy();
      expect(report.throughput_cases_per_s).toBeGreaterThanOrEqual(0);
    });
  }

  it('report contains no raw prompt/response fields (only verdicts + tallies)', async () => {
    const io = memIO();
    const harness = new LoadTestHarness(baseConfig(), makeCases(4), {
      executor: fixedExecutor(servedBlock()),
      io,
      resolveFingerprints: () => ({ ...PINS }),
    });
    const report = await harness.run();
    const serialized = JSON.stringify(report) + io.lines.join('');
    expect(serialized).not.toContain('reasoning');
    expect(serialized).not.toContain('objection');
    expect(serialized).not.toContain('mandate');
  });
});

// ---------------------------------------------------------------------------
// Abort guards
// ---------------------------------------------------------------------------

describe('loadtest abort guards', () => {
  it('aborts on alias pin mismatch BEFORE the first case', async () => {
    const executor = fixedExecutor(servedBlock());
    const harness = new LoadTestHarness(baseConfig(), makeCases(4), {
      executor,
      io: memIO(),
      resolveFingerprints: () => ({ ...PINS, 'serv-nano': 'serv:serv-DIFFERENT:https://x' }),
    });
    await expect(harness.run()).rejects.toMatchObject({ reason: 'alias_pin_mismatch' });
    expect(executor).not.toHaveBeenCalled();
  });

  it('aborts when fingerprint resolution throws (fail closed)', async () => {
    const harness = new LoadTestHarness(baseConfig(), makeCases(4), {
      executor: fixedExecutor(servedBlock()),
      io: memIO(),
      resolveFingerprints: () => {
        throw new Error('provider not pinned');
      },
    });
    await expect(harness.run()).rejects.toMatchObject({ reason: 'alias_pin_mismatch' });
  });

  it('aborts on resume identity mismatch', async () => {
    const cases = makeCases(4);
    const cfg = baseConfig();
    const staleManifest: LoadTestManifest = {
      certifying: false,
      load_test_only: true,
      runId: cfg.runId,
      concurrency: cfg.concurrency,
      hardConcurrencyCap: cfg.hardConcurrencyCap,
      n: cfg.n,
      aliasPins: { ...PINS },
      deadline: cfg.deadline,
      scenarioFileHash: cfg.scenarioFileHash,
      wallClockCapMs: cfg.wallClockCapMs,
      maxProviderErrorStorm: cfg.maxProviderErrorStorm,
      maxOpenTransitions: cfg.maxOpenTransitions,
      caseIds: cases.map((c) => c.id),
      identityHash: 'STALE-HASH-DOES-NOT-MATCH',
    };
    const harness = new LoadTestHarness(cfg, cases, {
      executor: fixedExecutor(servedBlock()),
      io: memIO(staleManifest),
      resolveFingerprints: () => ({ ...PINS }),
    });
    await expect(harness.run()).rejects.toMatchObject({ reason: 'identity_mismatch' });
  });

  it('aborts on a corrupt checkpoint line', async () => {
    const cases = makeCases(4);
    const cfg = baseConfig();
    const io = memIO(undefined, ['{not json']);
    const harness = new LoadTestHarness(cfg, cases, {
      executor: fixedExecutor(servedBlock()),
      io,
      resolveFingerprints: () => ({ ...PINS }),
    });
    await expect(harness.run()).rejects.toMatchObject({ reason: 'corrupt_resume' });
  });

  it('aborts on a duplicate checkpoint entry', async () => {
    const cases = makeCases(4);
    const cfg = baseConfig();
    const dupLine = JSON.stringify({
      id: 'case-0',
      aggregate_verdict: 'BLOCK',
      axis_hit: true,
      per_alias: {},
      deadline_source: 'none',
      latency_ms: 1,
      movement: 'expected_catch',
    });
    const io = memIO(undefined, [dupLine, dupLine]);
    const harness = new LoadTestHarness(cfg, cases, {
      executor: fixedExecutor(servedBlock()),
      io,
      resolveFingerprints: () => ({ ...PINS }),
    });
    await expect(harness.run()).rejects.toMatchObject({ reason: 'duplicate_resume' });
  });

  it('resumes: already-completed cases are not re-executed', async () => {
    const cases = makeCases(4);
    const cfg = baseConfig();
    // Pre-seed a valid manifest (correct identity) + 2 completed cases.
    const identityHash = computeIdentityHash(cfg, cases.map((c) => c.id));
    const manifest: LoadTestManifest = {
      certifying: false,
      load_test_only: true,
      runId: cfg.runId,
      concurrency: cfg.concurrency,
      hardConcurrencyCap: cfg.hardConcurrencyCap,
      n: cfg.n,
      aliasPins: { ...PINS },
      deadline: cfg.deadline,
      scenarioFileHash: cfg.scenarioFileHash,
      wallClockCapMs: cfg.wallClockCapMs,
      maxProviderErrorStorm: cfg.maxProviderErrorStorm,
      maxOpenTransitions: cfg.maxOpenTransitions,
      caseIds: cases.map((c) => c.id),
      identityHash,
    };
    const done = ['case-0', 'case-1'].map((id) =>
      JSON.stringify({
        id,
        aggregate_verdict: 'BLOCK',
        axis_hit: true,
        per_alias: {},
        deadline_source: 'none',
        latency_ms: 1,
        movement: 'expected_catch',
      }),
    );
    const io = memIO(manifest, done);
    const executor = fixedExecutor(servedBlock());
    const harness = new LoadTestHarness(cfg, cases, {
      executor,
      io,
      resolveFingerprints: () => ({ ...PINS }),
    });
    const report = await harness.run();
    // Only the 2 remaining cases were executed; report counts all 4.
    expect(executor).toHaveBeenCalledTimes(2);
    expect(report.completed).toBe(4);
  });

  it('aborts on a provider-error storm', async () => {
    const stormResponse = makeResponse('REVIEW', [
      axis('intent', 'UNCERTAIN', 'provider_error'),
      axis('scope', 'UNCERTAIN', 'provider_error'),
      axis('risk', 'UNCERTAIN', 'provider_error'),
      axis('consistency', 'UNCERTAIN', 'provider_error'),
      axis('reversibility', 'UNCERTAIN', 'provider_error'),
    ]);
    const io = memIO();
    const harness = new LoadTestHarness(
      baseConfig({ concurrency: 1, maxProviderErrorStorm: 6 }),
      makeCases(4),
      {
        executor: fixedExecutor(stormResponse),
        io,
        resolveFingerprints: () => ({ ...PINS }),
      },
    );
    const report = await harness.run();
    // 5 provider_errors on case 1 (≤6 ok), 10 after case 2 (>6) → abort.
    expect(report.aborted).toBe(true);
    expect(report.abort_reason).toBe('provider_storm');
    expect(report.completed).toBeLessThan(4);
  });

  it('aborts on an OPEN-transition storm derived from circuit diagnostics', async () => {
    let trip = 0;
    const probeCircuits = (): CircuitDiagnostic[] => {
      trip += 1;
      return [
        {
          alias: 'serv-nano',
          route: 'serv:serv-nano',
          state: 'OPEN',
          sampleCount: 5,
          failureRate: 1,
          p90LatencyMs: 10,
          tripGeneration: trip,
          recoveryEpoch: 0,
          probeSequence: 0,
          stateRevision: trip,
          openedAt: 1,
        },
      ];
    };
    const io = memIO();
    const harness = new LoadTestHarness(
      baseConfig({ concurrency: 1, maxOpenTransitions: 2 }),
      makeCases(4),
      {
        executor: fixedExecutor(servedBlock()),
        io,
        resolveFingerprints: () => ({ ...PINS }),
        probeCircuits,
      },
    );
    const report = await harness.run();
    expect(report.aborted).toBe(true);
    expect(report.abort_reason).toBe('open_transition_storm');
    expect(report.circuit_transitions.open).toBeGreaterThan(2);
  });

  it('aborts on secret leakage in a case record', async () => {
    // An executor that returns an observation whose alias key leaks a secret.
    const leaky: CaseExecutor = async () => ({
      response: servedBlock(),
      observation: {
        aggregate_verdict: 'BLOCK',
        axis_hit: true,
        per_alias: { 'sk-supersecret': { calls: 1, served: 1, provider_error: 0, circuit_rejected: 0 } },
        deadline_source: 'none',
      },
    });
    const harness = new LoadTestHarness(baseConfig({ concurrency: 1 }), makeCases(4), {
      executor: leaky,
      io: memIO(),
      resolveFingerprints: () => ({ ...PINS }),
    });
    await expect(harness.run()).rejects.toMatchObject({ reason: 'secret_leak' });
  });

  it('aborts IN-FLIGHT work via the shared signal at the wall-clock cap', async () => {
    // A real-timer executor that hangs until the shared signal fires. The
    // harness's wall-clock timer must abort the signal, interrupt the awaited
    // case, and fail closed — preserving whatever was already checkpointed.
    const started: string[] = [];
    const executor: CaseExecutor = ({ loadCase, signal }) =>
      new Promise((resolve, reject) => {
        started.push(loadCase.id);
        if (signal.aborted) {
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
          return;
        }
        const t = setTimeout(() => resolve({ response: servedBlock() }), 10_000);
        signal.addEventListener(
          'abort',
          () => {
            clearTimeout(t);
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
          },
          { once: true },
        );
      });
    const io = memIO();
    const harness = new LoadTestHarness(
      baseConfig({ concurrency: 1, wallClockCapMs: 25 }),
      makeCases(4),
      { executor, io, resolveFingerprints: () => ({ ...PINS }) },
    );
    const report = await harness.run();
    expect(report.aborted).toBe(true);
    expect(report.abort_reason).toBe('wall_clock_cap');
    // The in-flight case never completed → nothing (or only prior) checkpointed.
    expect(report.completed).toBeLessThan(4);
    expect(io.lines.length).toBeLessThan(4);
    expect(started.length).toBeGreaterThan(0);
  });

  it('sums live_totals across cases that report reliability rollups', async () => {
    const executor: CaseExecutor = async () => ({
      response: servedBlock(),
      observation: {
        aggregate_verdict: 'BLOCK',
        axis_hit: true,
        per_alias: { 'serv-nano': { calls: 5, served: 5, provider_error: 0, circuit_rejected: 0 } },
        deadline_source: 'none',
        provider_calls: 5,
        attempts: 6,
        backoff_ms: 10,
        net_latency_ms: 100,
        transitions: { open: 0, half_open: 0 },
      },
    });
    const io = memIO();
    const harness = new LoadTestHarness(baseConfig({ concurrency: 2 }), makeCases(4), {
      executor,
      io,
      resolveFingerprints: () => ({ ...PINS }),
    });
    const report = await harness.run();
    expect(report.live_totals).toEqual({
      provider_calls: 20,
      attempts: 24,
      backoff_ms: 40,
      net_latency_ms: 400,
    });
  });

  it('aborts on the wall-clock cap', async () => {
    // A fake clock that jumps past the cap after the first case.
    let t = 1_000_000;
    const now = () => t;
    const executor: CaseExecutor = async () => {
      t += 50_000; // each case "takes" 50s of wall time
      return { response: servedBlock() };
    };
    const io = memIO();
    const harness = new LoadTestHarness(
      baseConfig({ concurrency: 1, wallClockCapMs: 60_000 }),
      makeCases(4),
      {
        executor,
        io,
        resolveFingerprints: () => ({ ...PINS }),
        now,
      },
    );
    const report = await harness.run();
    expect(report.aborted).toBe(true);
    expect(report.abort_reason).toBe('wall_clock_cap');
    expect(report.completed).toBeLessThan(4);
  });
});

// ---------------------------------------------------------------------------
// Offline fixture load test — real scenario bytes, no provider calls
// ---------------------------------------------------------------------------

describe('loadtest offline fixture run over real scenarios', () => {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const scenarioPath = resolve(__dirname, '..', '..', 'scenarios', 'spike-80.jsonl');

  it('drives a fixed selection of frozen scenarios through an offline executor', async () => {
    const raw = readFileSync(scenarioPath, 'utf8');
    const all = raw.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
    const N = 12;
    const selected: LoadCase[] = all.slice(0, N).map((s) => ({
      id: s.id,
      expected_fail_axis: s.expected_fail_axis,
      request: s.request,
    }));
    expect(selected).toHaveLength(N);

    // Deterministic offline executor: the expected fail axis FAILs (served),
    // the rest PASS (served) — a realistic "healthy provider" shape.
    const executor: CaseExecutor = async ({ loadCase }) => {
      const axes: AxisResult[] = ['intent', 'scope', 'risk', 'consistency', 'reversibility'].map(
        (name) =>
          axis(name, name === loadCase.expected_fail_axis ? 'FAIL' : 'PASS', 'served', 'primary'),
      );
      const verdict: AggregateVerdict = 'BLOCK';
      return { response: makeResponse(verdict, axes) };
    };

    const cfg = baseConfig({
      runId: 'offline-fixture',
      n: N,
      concurrency: 4,
      scenarioFileHash: sha256Hex(raw),
    });
    const io = memIO();
    const harness = new LoadTestHarness(cfg, selected, {
      executor,
      io,
      resolveFingerprints: () => ({ ...PINS }),
    });
    const report = await harness.run();

    expect(report.certifying).toBe(false);
    expect(report.load_test_only).toBe(true);
    expect(report.completed).toBe(N);
    expect(report.aborted).toBe(false);
    expect(report.movements.expected_catch).toBe(N);
    expect(report.per_alias['serv-nano']?.served).toBe(N * 5);
    expect(io.manifest?.scenarioFileHash).toBe(sha256Hex(raw));
    // Identity hash binds the exact selection.
    expect(io.manifest?.caseIds).toEqual(selected.map((c) => c.id));
    assertNonCertifying(report);
  });
});
