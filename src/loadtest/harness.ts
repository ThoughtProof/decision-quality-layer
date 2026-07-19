/**
 * Non-certifying burst / load-test harness (Phase 2).
 *
 * PURPOSE
 *   Drive a FIXED, finite selection of frozen scenarios through the DQL
 *   production Option-A path under bounded concurrency WITHOUT pacing between
 *   cases, and measure per-alias circuit behaviour, deadline sources, latency
 *   percentiles, REVIEW amplification, decision-quality movements, and
 *   throughput.
 *
 * HARD NON-CERTIFYING CONTRACT
 *   Every artefact this harness emits is stamped `certifying: false` and
 *   `load_test_only: true`. The report/manifest/record types deliberately do
 *   NOT carry any certification field, and `assertNonCertifying()` fails closed
 *   if a certification key ever appears. A load run can never be mistaken for,
 *   or promoted to, a certification run.
 *
 * OFFLINE-FIRST
 *   The harness is transport-agnostic: it takes an injected `runCase` executor
 *   and optional `probeCircuits` / `resolveFingerprints` callbacks. In this
 *   commit it is exercised entirely offline (deterministic fixture executor,
 *   no provider calls). The SAME harness will later drive the live cascade by
 *   swapping in a provider-backed executor — no structural change required.
 *
 * SAFETY GUARDS (all fail closed / abort, never silently continue)
 *   - alias identities are PINNED to resolved route fingerprints and verified
 *     BEFORE the first case; a drift/mismatch aborts before any call.
 *   - resume is identity-checked (manifest hash) and integrity-checked
 *     (duplicate / corrupt checkpoint lines abort).
 *   - a provider-error / circuit storm above a configured budget aborts.
 *   - a wall-clock cap stops scheduling and aborts with the checkpoint intact.
 *   - every persisted record is scanned for secret / raw-payload leakage.
 */

import crypto from 'node:crypto';
import type { DqlResponse, AggregateVerdict } from '../types.js';
import type { TimeoutSource } from '../engine/llm-client.js';
import type { CircuitDiagnostic } from '../engine/llm-client.js';

// ---------------------------------------------------------------------------
// Public data shapes
// ---------------------------------------------------------------------------

export type DeadlineSource = TimeoutSource | 'none';

/** One frozen, immutable case to drive. */
export interface LoadCase {
  id: string;
  /** Expected FAIL axis (from the scenario ground truth) — read-only. */
  expected_fail_axis?: string;
  /** The request payload, forwarded verbatim to the executor. */
  request: {
    mandate: string;
    proposed_action: string;
    reasoning: string;
    context?: string;
    axes?: string[];
  };
}

/** Per-alias tally for a single case (or rolled up across a run). */
export interface AliasOutcomeTally {
  calls: number;
  served: number;
  provider_error: number;
  circuit_rejected: number;
}

/**
 * Structured, PII/secret-free observation of one case's provider behaviour.
 * Built from a DqlResponse (+ optional circuit diagnostics) via
 * `buildObservation`. Carries NO prompts, raw responses, reasoning, or
 * objections — only verdicts, routes, outcomes, and timings.
 */
export interface CaseObservation {
  aggregate_verdict: AggregateVerdict;
  axis_hit: boolean | null;
  /** provider_outcome tally keyed by resolved alias. */
  per_alias: Record<string, AliasOutcomeTally>;
  deadline_source: DeadlineSource;
  /**
   * Optional live-only reliability signals (secret/raw-free numeric rollups).
   * Populated by the production-backed executor from the diagnostics collector;
   * omitted by offline fixtures. All optional so the resume/checkpoint format
   * stays backward compatible.
   */
  provider_calls?: number;
  attempts?: number;
  backoff_ms?: number;
  net_latency_ms?: number;
  transitions?: { open: number; half_open: number };
}

/** Persisted per-case result line (append-only JSONL). Secret/raw-free. */
export interface CaseResult {
  id: string;
  aggregate_verdict: AggregateVerdict;
  axis_hit: boolean | null;
  per_alias: Record<string, AliasOutcomeTally>;
  deadline_source: DeadlineSource;
  latency_ms: number;
  /** Decision-quality movement vs. expected ground truth. */
  movement: 'expected_catch' | 'false_allow' | 'recall_miss' | 'no_ground_truth';
  /** Optional live reliability rollups (see CaseObservation). */
  provider_calls?: number;
  attempts?: number;
  backoff_ms?: number;
  net_latency_ms?: number;
  transitions?: { open: number; half_open: number };
}

export interface LoadTestConfig {
  /** Stable run id — also the checkpoint basename. */
  runId: string;
  /** Bounded concurrency for this run. Must be ≥1 and ≤ hardConcurrencyCap. */
  concurrency: number;
  /** Absolute hard cap; concurrency above this aborts at construction. */
  hardConcurrencyCap: number;
  /** Fixed count of cases expected in the selection (identity-bound). */
  n: number;
  /**
   * Pinned alias → resolved route fingerprint map. Verified against
   * `resolveFingerprints()` BEFORE the first case. Any mismatch fails closed.
   */
  aliasPins: Record<string, string>;
  /** Deadline config forwarded to the executor (documented in the manifest). */
  deadline: {
    requestDeadlineMs: number;
    providerCallBudgetMs: number;
  };
  /** Hash of the scenario source file, to bind the selection to its bytes. */
  scenarioFileHash: string;
  /** Wall-clock cap for the whole run (ms). Exceeding it aborts. */
  wallClockCapMs: number;
  /**
   * Storm budget: abort if (provider_error + circuit_rejected) across all
   * aliases exceeds this many outcomes. Defends against hammering a degraded
   * provider once we go live.
   */
  maxProviderErrorStorm: number;
  /** Abort if observed OPEN transitions exceed this. */
  maxOpenTransitions: number;
  /**
   * Secret values to scan every persisted record for (defense-in-depth). The
   * caller passes the resolved secret STRINGS (never their env names) so a
   * leak is caught before it is written to disk.
   */
  secretScanValues: string[];
}

export interface LoadTestManifest {
  /** HARD non-certifying stamps. */
  certifying: false;
  load_test_only: true;
  runId: string;
  concurrency: number;
  hardConcurrencyCap: number;
  n: number;
  aliasPins: Record<string, string>;
  deadline: LoadTestConfig['deadline'];
  scenarioFileHash: string;
  wallClockCapMs: number;
  maxProviderErrorStorm: number;
  maxOpenTransitions: number;
  /** Ordered list of the case ids this run is bound to. */
  caseIds: string[];
  /** SHA-256 over the identity-bearing fields above. */
  identityHash: string;
}

export type AbortReason =
  | 'alias_pin_mismatch'
  | 'identity_mismatch'
  | 'duplicate_resume'
  | 'corrupt_resume'
  | 'provider_storm'
  | 'open_transition_storm'
  | 'secret_leak'
  | 'wall_clock_cap';

export interface LoadTestReport {
  certifying: false;
  load_test_only: true;
  runId: string;
  manifest: LoadTestManifest;
  completed: number;
  aborted: boolean;
  abort_reason: AbortReason | null;
  wall_clock_ms: number;
  throughput_cases_per_s: number;
  latency_ms: { p50: number; p90: number; p99: number; max: number };
  per_alias: Record<string, AliasOutcomeTally>;
  circuit_transitions: { open: number; half_open: number };
  deadline_sources: Record<DeadlineSource, number>;
  aggregate_verdicts: Record<AggregateVerdict, number>;
  review_amplification: number;
  movements: {
    expected_catch: number;
    false_allow: number;
    recall_miss: number;
    no_ground_truth: number;
  };
  /**
   * Live reliability rollups summed across cases that reported them (0 for a
   * pure offline run). `provider_calls` is the true count of provider fetches
   * (binding calls incl. retries + fallback draws) — the number the live
   * matrix's hard cap is sized against.
   */
  live_totals: {
    provider_calls: number;
    attempts: number;
    backoff_ms: number;
    net_latency_ms: number;
  };
}

// ---------------------------------------------------------------------------
// Injected collaborators (all offline-friendly)
// ---------------------------------------------------------------------------

export interface CaseExecutorInput {
  loadCase: LoadCase;
  deadline: LoadTestConfig['deadline'];
  /**
   * Shared run-level abort signal. Fires when the wall-clock cap is reached so
   * a provider-backed executor can cancel IN-FLIGHT work (thread it into the
   * request AbortController) rather than only stopping at scheduling
   * boundaries. Offline fixtures may ignore it.
   */
  signal: AbortSignal;
}

export interface CaseExecutorResult {
  response: DqlResponse;
  /**
   * Optional pre-built observation. When omitted, the harness builds one from
   * `response` using `aliasResolver`. Fixtures may supply it directly to model
   * provider outcomes / deadline sources that a DqlResponse cannot express.
   */
  observation?: CaseObservation;
}

export type CaseExecutor = (input: CaseExecutorInput) => Promise<CaseExecutorResult>;

/**
 * Minimal checkpoint I/O so the harness is unit-testable without touching the
 * filesystem. The file-backed default lives in `nodeCheckpointIO`.
 */
export interface CheckpointIO {
  readManifest(): LoadTestManifest | null;
  writeManifest(m: LoadTestManifest): void;
  /** Existing per-case JSONL lines (may be empty). Order preserved. */
  readResultLines(): string[];
  appendResult(line: string): void;
}

export interface HarnessDeps {
  executor: CaseExecutor;
  io: CheckpointIO;
  /**
   * Resolve alias → route fingerprint. Called ONCE before the first case to
   * verify the pins. In offline mode a fixture returns the pinned map; live it
   * will read HttpLlmClient bindings. Fail-closed if it throws.
   */
  resolveFingerprints: () => Record<string, string>;
  /** Optional circuit-diagnostics probe for transition deltas. */
  probeCircuits?: () => CircuitDiagnostic[];
  /**
   * Map a DqlResponse axis's provider_route ('primary' | 'fallback') to a
   * concrete alias so per-alias tallies can be attributed. Required when the
   * harness builds observations itself.
   */
  aliasResolver?: (route: 'primary' | 'fallback' | undefined) => string;
  now?: () => number;
}

// ---------------------------------------------------------------------------
// Pure helpers (exported for direct unit testing)
// ---------------------------------------------------------------------------

export function sha256Hex(input: string): string {
  return crypto.createHash('sha256').update(input, 'utf8').digest('hex');
}

/**
 * Deterministic identity hash over the fields that MUST be stable across a
 * resume. A change to any of them means "different run" → resume aborts.
 */
export function computeIdentityHash(
  config: LoadTestConfig,
  caseIds: readonly string[],
): string {
  // Every operational knob that could change what the run DOES is bound into
  // the identity. A resume that silently ran at a different concurrency, storm
  // budget, or wall-clock cap would be a different experiment wearing the same
  // checkpoint — so any drift in these fields aborts the resume.
  const canonical = JSON.stringify({
    runId: config.runId,
    n: config.n,
    concurrency: config.concurrency,
    hardConcurrencyCap: config.hardConcurrencyCap,
    aliasPins: sortedRecord(config.aliasPins),
    deadline: config.deadline,
    scenarioFileHash: config.scenarioFileHash,
    wallClockCapMs: config.wallClockCapMs,
    maxProviderErrorStorm: config.maxProviderErrorStorm,
    maxOpenTransitions: config.maxOpenTransitions,
    caseIds: [...caseIds],
  });
  return sha256Hex(canonical);
}

function sortedRecord(r: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of Object.keys(r).sort()) out[k] = r[k]!;
  return out;
}

const EMPTY_TALLY = (): AliasOutcomeTally => ({
  calls: 0,
  served: 0,
  provider_error: 0,
  circuit_rejected: 0,
});

function addTally(into: AliasOutcomeTally, from: AliasOutcomeTally): void {
  into.calls += from.calls;
  into.served += from.served;
  into.provider_error += from.provider_error;
  into.circuit_rejected += from.circuit_rejected;
}

/**
 * Build a secret/raw-free observation from a DqlResponse. Attributes each
 * axis's provider_outcome to a concrete alias via `aliasResolver`.
 */
export function buildObservation(
  response: DqlResponse,
  expectedFailAxis: string | undefined,
  aliasResolver: (route: 'primary' | 'fallback' | undefined) => string,
): CaseObservation {
  const per_alias: Record<string, AliasOutcomeTally> = {};
  for (const axis of response.axes) {
    const alias = aliasResolver(axis.provider_route);
    const tally = (per_alias[alias] ??= EMPTY_TALLY());
    tally.calls += 1;
    switch (axis.provider_outcome) {
      case 'served':
        tally.served += 1;
        break;
      case 'provider_error':
        tally.provider_error += 1;
        break;
      case 'circuit_rejected':
        tally.circuit_rejected += 1;
        break;
      default:
        // No provenance (e.g. Stub) — counted as a call only.
        break;
    }
  }
  const hitAxis = expectedFailAxis
    ? response.axes.find((a) => a.axis === expectedFailAxis)
    : undefined;
  const axis_hit = expectedFailAxis ? (hitAxis?.verdict === 'FAIL') : null;
  return {
    aggregate_verdict: response.aggregate.verdict,
    axis_hit,
    per_alias,
    deadline_source: 'none',
  };
}

export function classifyMovement(obs: CaseObservation): CaseResult['movement'] {
  if (obs.axis_hit === null) return 'no_ground_truth';
  // Ground truth says this case has a genuine problem on `expected_fail_axis`.
  // Letting it through (ALLOW) is a false-allow — the worst decision-quality
  // failure. Otherwise, if the expected axis did not FAIL it is a recall miss.
  if (obs.aggregate_verdict === 'ALLOW') return 'false_allow';
  if (!obs.axis_hit) return 'recall_miss';
  return 'expected_catch';
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx]!;
}

/**
 * Any key that would let a load artefact masquerade as a certification /
 * calibration / decision-quality result. Matched case-insensitively against
 * EVERY key at EVERY depth (see `assertNonCertifying`). This set matches or
 * exceeds the DQL movement runner's forbidden-field guard: certification
 * vocabulary (certified/certification/certificate/certifies/attestation),
 * pass/fail-rate calibration vocabulary (far/fbr/false_allow_rate/
 * false_block_rate/recall/precision as run-level RATES), and the
 * accreditation words (accredit*, ratified, official, production_ready).
 *
 * NOTE: per-case `movement` values ('false_allow'|'recall_miss'|…) are NOT
 * rates and are legitimately present; the guard only rejects rate-shaped
 * KEYS, never these enum string values.
 */
/**
 * Substring stems: a KEY that CONTAINS any of these (case-insensitively) is
 * rejected. Stems catch every inflection/compound (certified, certification,
 * certificate, certifies; calibration, recalibrate; accreditation; attestation;
 * production_ready). The legitimate stamp key `certifying` also contains
 * 'certif' — it is handled BEFORE this check (value-enforced, not rejected).
 */
const FORBIDDEN_CERT_STEMS = [
  'certif',
  'attestation',
  'accredit',
  'calibrat',
  'production_ready',
];

/**
 * Exact rate/accreditation KEYS. Kept exact (not substring) because the tokens
 * are short/common enough that substring matching would over-reject benign
 * fields (e.g. 'far' inside 'fare'). These are the run-level RATE names a
 * calibration/certification artefact would carry.
 */
const FORBIDDEN_CERT_EXACT = new Set([
  'far',
  'fbr',
  'false_allow_rate',
  'false_block_rate',
  'recall_rate',
  'precision_rate',
  'official',
  'ratified',
  'certification_id',
]);

function isForbiddenCertKey(key: string): boolean {
  const lower = key.toLowerCase();
  if (FORBIDDEN_CERT_EXACT.has(lower)) return true;
  return FORBIDDEN_CERT_STEMS.some((stem) => lower.includes(stem));
}

/**
 * Assert an artefact is non-certifying. Throws (fail-closed) on violation.
 *
 * Recursive: walks the whole object graph so a certification-like field can
 * never hide inside a nested manifest, report, or per-case record. Also
 * enforces that wherever the non-certifying stamps appear they carry the
 * correct values (`certifying===false`, `load_test_only===true`).
 */
export function assertNonCertifying(obj: unknown, path = '$'): void {
  if (obj === null || typeof obj !== 'object') return;
  if (Array.isArray(obj)) {
    obj.forEach((v, i) => assertNonCertifying(v, `${path}[${i}]`));
    return;
  }
  const rec = obj as Record<string, unknown>;
  for (const [key, value] of Object.entries(rec)) {
    // Legitimate non-certifying stamp keys are value-enforced, NOT rejected —
    // even though 'certifying' contains the 'certif' stem. Handle them first.
    if (key === 'certifying') {
      if (value !== false) throw new Error(`[loadtest] certifying must be false (at ${path})`);
      assertNonCertifying(value, `${path}.${key}`);
      continue;
    }
    if (key === 'load_test_only') {
      if (value !== true) throw new Error(`[loadtest] load_test_only must be true (at ${path})`);
      assertNonCertifying(value, `${path}.${key}`);
      continue;
    }
    if (isForbiddenCertKey(key)) {
      throw new Error(
        `[loadtest] forbidden certification field '${key}' at ${path} in a non-certifying artefact`,
      );
    }
    assertNonCertifying(value, `${path}.${key}`);
  }
}

// ---------------------------------------------------------------------------
// The harness
// ---------------------------------------------------------------------------

export class LoadTestAbort extends Error {
  constructor(public readonly reason: AbortReason, message: string) {
    super(message);
    this.name = 'LoadTestAbort';
  }
}

/** Internal sentinel: an in-flight case was cut short by the wall-clock abort. */
class WallClockInterrupt extends Error {
  constructor() {
    super('[loadtest] wall-clock cap interrupted an in-flight case');
    this.name = 'WallClockInterrupt';
  }
}

/**
 * Resolve with `p`, or reject with WallClockInterrupt the moment `signal`
 * aborts — whichever happens first. Lets the harness stop waiting on a hung
 * in-flight case at the wall-clock cap instead of only at scheduling
 * boundaries. The underlying executor also receives the same signal so it can
 * cancel its own provider call.
 */
function raceAbort<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new WallClockInterrupt());
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(new WallClockInterrupt());
    signal.addEventListener('abort', onAbort, { once: true });
    p.then(
      (v) => {
        signal.removeEventListener('abort', onAbort);
        resolve(v);
      },
      (e) => {
        signal.removeEventListener('abort', onAbort);
        reject(e);
      },
    );
  });
}

export class LoadTestHarness {
  private readonly now: () => number;

  constructor(
    private readonly config: LoadTestConfig,
    private readonly cases: LoadCase[],
    private readonly deps: HarnessDeps,
  ) {
    if (config.concurrency < 1) {
      throw new Error('[loadtest] concurrency must be ≥ 1');
    }
    if (config.concurrency > config.hardConcurrencyCap) {
      throw new Error(
        `[loadtest] concurrency ${config.concurrency} exceeds hard cap ${config.hardConcurrencyCap}`,
      );
    }
    if (cases.length !== config.n) {
      throw new Error(
        `[loadtest] case selection size ${cases.length} != pinned n ${config.n}`,
      );
    }
    this.now = deps.now ?? Date.now;
  }

  private buildManifest(): LoadTestManifest {
    const caseIds = this.cases.map((c) => c.id);
    const identityHash = computeIdentityHash(this.config, caseIds);
    const manifest: LoadTestManifest = {
      certifying: false,
      load_test_only: true,
      runId: this.config.runId,
      concurrency: this.config.concurrency,
      hardConcurrencyCap: this.config.hardConcurrencyCap,
      n: this.config.n,
      aliasPins: sortedRecord(this.config.aliasPins),
      deadline: this.config.deadline,
      scenarioFileHash: this.config.scenarioFileHash,
      wallClockCapMs: this.config.wallClockCapMs,
      maxProviderErrorStorm: this.config.maxProviderErrorStorm,
      maxOpenTransitions: this.config.maxOpenTransitions,
      caseIds,
      identityHash,
    };
    assertNonCertifying(manifest);
    return manifest;
  }

  /**
   * Verify pinned aliases resolve to the pinned fingerprints. Fail closed
   * BEFORE any case runs — no provider drift, no silent alias switching.
   */
  private assertAliasPins(): void {
    let resolved: Record<string, string>;
    try {
      resolved = this.deps.resolveFingerprints();
    } catch (err) {
      throw new LoadTestAbort(
        'alias_pin_mismatch',
        `[loadtest] alias fingerprint resolution failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    for (const [alias, pin] of Object.entries(this.config.aliasPins)) {
      if (resolved[alias] !== pin) {
        throw new LoadTestAbort(
          'alias_pin_mismatch',
          `[loadtest] alias '${alias}' resolved to '${resolved[alias] ?? '<missing>'}' but pin is '${pin}'`,
        );
      }
    }
  }

  /**
   * Load prior progress. Verifies the manifest identity matches and the
   * checkpoint lines are unique + parseable. Returns the set of completed ids.
   */
  private loadResume(manifest: LoadTestManifest): {
    doneIds: Set<string>;
    priorResults: CaseResult[];
  } {
    const existingManifest = this.deps.io.readManifest();
    if (existingManifest && existingManifest.identityHash !== manifest.identityHash) {
      throw new LoadTestAbort(
        'identity_mismatch',
        `[loadtest] resume identity mismatch: checkpoint ${existingManifest.identityHash} != current ${manifest.identityHash}`,
      );
    }
    const doneIds = new Set<string>();
    const priorResults: CaseResult[] = [];
    const validIds = new Set(manifest.caseIds);
    for (const line of this.deps.io.readResultLines()) {
      if (!line.trim()) continue;
      let parsed: CaseResult;
      try {
        parsed = JSON.parse(line) as CaseResult;
      } catch {
        throw new LoadTestAbort('corrupt_resume', '[loadtest] corrupt checkpoint line');
      }
      if (typeof parsed.id !== 'string' || !validIds.has(parsed.id)) {
        throw new LoadTestAbort(
          'corrupt_resume',
          `[loadtest] checkpoint line has unknown case id '${parsed.id}'`,
        );
      }
      if (doneIds.has(parsed.id)) {
        throw new LoadTestAbort(
          'duplicate_resume',
          `[loadtest] duplicate checkpoint entry for case '${parsed.id}'`,
        );
      }
      doneIds.add(parsed.id);
      priorResults.push(parsed);
    }
    return { doneIds, priorResults };
  }

  private scanForSecrets(result: CaseResult): void {
    const serialized = JSON.stringify(result);
    for (const secret of this.config.secretScanValues) {
      if (secret && serialized.includes(secret)) {
        throw new LoadTestAbort('secret_leak', '[loadtest] secret value found in a case record');
      }
    }
    if (/Bearer\s+\S/i.test(serialized) || /\bsk-[A-Za-z0-9]{6,}/.test(serialized)) {
      throw new LoadTestAbort('secret_leak', '[loadtest] credential-shaped token found in a case record');
    }
  }

  async run(): Promise<LoadTestReport> {
    const manifest = this.buildManifest();
    // Fail closed on identity/drift BEFORE touching any provider.
    this.assertAliasPins();
    const { doneIds, priorResults } = this.loadResume(manifest);
    this.deps.io.writeManifest(manifest);

    const results: CaseResult[] = [...priorResults];
    const pending = this.cases.filter((c) => !doneIds.has(c.id));

    const startedAt = this.now();
    let aborted = false;
    let abortReason: AbortReason | null = null;

    // Running storm counters (include prior results so resume is honest).
    let providerErrorTotal = 0;
    for (const r of priorResults) {
      for (const t of Object.values(r.per_alias)) {
        providerErrorTotal += t.provider_error + t.circuit_rejected;
      }
    }

    // Circuit transition tracking via diagnostics deltas.
    const baselineDiag = this.snapshotDiag();
    let openTransitions = 0;
    let halfOpenTransitions = 0;
    const prevGen = new Map<string, { trip: number; probe: number }>();
    for (const d of baselineDiag) prevGen.set(d.alias, { trip: d.tripGeneration, probe: d.probeSequence });

    const stop = (reason: AbortReason): void => {
      if (!aborted) {
        aborted = true;
        abortReason = reason;
      }
    };

    // Shared abort so a wall-clock breach cancels IN-FLIGHT work, not just the
    // next scheduling decision. A real timer fires at the cap; injected-clock
    // tests still trip the scheduling-boundary check below. Both call stop().
    const runAbort = new AbortController();
    const remainingToCap = this.config.wallClockCapMs - (this.now() - startedAt);
    const wallTimer: ReturnType<typeof setTimeout> | undefined =
      remainingToCap > 0
        ? setTimeout(() => {
            stop('wall_clock_cap');
            runAbort.abort();
          }, remainingToCap)
        : undefined;
    if (wallTimer && typeof wallTimer.unref === 'function') wallTimer.unref();

    let cursor = 0;
    const worker = async (): Promise<void> => {
      while (true) {
        if (aborted) return;
        if (this.now() - startedAt > this.config.wallClockCapMs) {
          stop('wall_clock_cap');
          runAbort.abort();
          return;
        }
        const i = cursor++;
        if (i >= pending.length) return;
        const loadCase = pending[i]!;

        const caseStart = this.now();
        let response: DqlResponse;
        let observation: CaseObservation | undefined;
        try {
          const out = await raceAbort(
            this.deps.executor({
              loadCase,
              deadline: this.config.deadline,
              signal: runAbort.signal,
            }),
            runAbort.signal,
          );
          response = out.response;
          observation = out.observation;
        } catch (err) {
          // A wall-clock abort interrupts the in-flight case: preserve all
          // prior partials (already checkpointed) and fail closed. Any other
          // executor throw is unexpected — surface it.
          if (runAbort.signal.aborted) {
            stop('wall_clock_cap');
            return;
          }
          throw err;
        }
        const obs =
          observation ??
          buildObservation(
            response,
            loadCase.expected_fail_axis,
            this.deps.aliasResolver ?? defaultAliasResolver,
          );
        const latency_ms = this.now() - caseStart;

        const result: CaseResult = {
          id: loadCase.id,
          aggregate_verdict: obs.aggregate_verdict,
          axis_hit: obs.axis_hit,
          per_alias: obs.per_alias,
          deadline_source: obs.deadline_source,
          latency_ms,
          movement: classifyMovement(obs),
          ...(obs.provider_calls !== undefined ? { provider_calls: obs.provider_calls } : {}),
          ...(obs.attempts !== undefined ? { attempts: obs.attempts } : {}),
          ...(obs.backoff_ms !== undefined ? { backoff_ms: obs.backoff_ms } : {}),
          ...(obs.net_latency_ms !== undefined ? { net_latency_ms: obs.net_latency_ms } : {}),
          ...(obs.transitions !== undefined ? { transitions: obs.transitions } : {}),
        };
        this.scanForSecrets(result);
        this.deps.io.appendResult(JSON.stringify(result));
        results.push(result);

        // Storm accounting.
        for (const t of Object.values(obs.per_alias)) {
          providerErrorTotal += t.provider_error + t.circuit_rejected;
        }
        if (providerErrorTotal > this.config.maxProviderErrorStorm) {
          stop('provider_storm');
          return;
        }

        // Circuit transition deltas.
        for (const d of this.snapshotDiag()) {
          const prev = prevGen.get(d.alias) ?? { trip: 0, probe: 0 };
          if (d.tripGeneration > prev.trip) openTransitions += d.tripGeneration - prev.trip;
          if (d.probeSequence > prev.probe) halfOpenTransitions += d.probeSequence - prev.probe;
          prevGen.set(d.alias, { trip: d.tripGeneration, probe: d.probeSequence });
        }
        if (openTransitions > this.config.maxOpenTransitions) {
          stop('open_transition_storm');
          return;
        }
      }
    };

    // Bounded worker pool — NO pacing/sleep between cases.
    try {
      await Promise.all(
        Array.from({ length: Math.min(this.config.concurrency, pending.length || 1) }, () => worker()),
      );
    } finally {
      if (wallTimer !== undefined) clearTimeout(wallTimer);
    }

    const wall_clock_ms = this.now() - startedAt;
    const report = this.buildReport(
      manifest,
      results,
      wall_clock_ms,
      aborted,
      abortReason,
      openTransitions,
      halfOpenTransitions,
    );
    assertNonCertifying(report);
    return report;
  }

  private snapshotDiag(): CircuitDiagnostic[] {
    try {
      return this.deps.probeCircuits ? this.deps.probeCircuits() : [];
    } catch {
      return [];
    }
  }

  private buildReport(
    manifest: LoadTestManifest,
    results: CaseResult[],
    wall_clock_ms: number,
    aborted: boolean,
    abort_reason: AbortReason | null,
    open: number,
    half_open: number,
  ): LoadTestReport {
    const per_alias: Record<string, AliasOutcomeTally> = {};
    const deadline_sources: Record<DeadlineSource, number> = {
      attempt_timeout: 0,
      call_budget: 0,
      request_deadline: 0,
      none: 0,
    };
    const aggregate_verdicts: Record<AggregateVerdict, number> = {
      ALLOW: 0,
      BLOCK: 0,
      REVIEW: 0,
    };
    const movements = {
      expected_catch: 0,
      false_allow: 0,
      recall_miss: 0,
      no_ground_truth: 0,
    };
    const latencies: number[] = [];
    const live_totals = { provider_calls: 0, attempts: 0, backoff_ms: 0, net_latency_ms: 0 };

    for (const r of results) {
      for (const [alias, tally] of Object.entries(r.per_alias)) {
        addTally((per_alias[alias] ??= EMPTY_TALLY()), tally);
      }
      deadline_sources[r.deadline_source] += 1;
      aggregate_verdicts[r.aggregate_verdict] += 1;
      movements[r.movement] += 1;
      latencies.push(r.latency_ms);
      live_totals.provider_calls += r.provider_calls ?? 0;
      live_totals.attempts += r.attempts ?? 0;
      live_totals.backoff_ms += r.backoff_ms ?? 0;
      live_totals.net_latency_ms += r.net_latency_ms ?? 0;
    }
    latencies.sort((a, b) => a - b);

    const completed = results.length;
    const throughput =
      wall_clock_ms > 0 ? completed / (wall_clock_ms / 1000) : 0;
    const review_amplification = completed > 0 ? aggregate_verdicts.REVIEW / completed : 0;

    return {
      certifying: false,
      load_test_only: true,
      runId: this.config.runId,
      manifest,
      completed,
      aborted,
      abort_reason,
      wall_clock_ms,
      throughput_cases_per_s: throughput,
      latency_ms: {
        p50: percentile(latencies, 50),
        p90: percentile(latencies, 90),
        p99: percentile(latencies, 99),
        max: latencies.length ? latencies[latencies.length - 1]! : 0,
      },
      per_alias,
      circuit_transitions: { open, half_open },
      deadline_sources,
      aggregate_verdicts,
      review_amplification,
      movements,
      live_totals,
    };
  }
}

/** Default alias attribution: primary → serv-nano, fallback → serv-swift. */
export function defaultAliasResolver(route: 'primary' | 'fallback' | undefined): string {
  if (route === 'fallback') return 'serv-swift';
  return 'serv-nano';
}
