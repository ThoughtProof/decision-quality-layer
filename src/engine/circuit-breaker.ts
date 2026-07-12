/**
 * Circuit Breaker with sliding-window failure-rate + p90-latency detection.
 *
 * v0.4.3.1 §E redesign — Token-based admission API with state-machine-owned
 * domain events. Replaces the older canProceed/recordSuccess/recordFailure
 * triple. See docs/design/v0431-c-e-design-briefing-v4.md and
 * docs/design/v0431-c-e-design-briefing-v4-delta.md for the binding contract.
 *
 * PURPOSE (unchanged from v0.4.3)
 * The DQL cascade calls the SERV inference API for every axis of every case.
 * When SERV is under load, individual requests either (a) fail transient, or
 * (b) succeed slowly (30-50s latency). The in-client retry loop handles (a)
 * cleanly. What it does NOT handle is (b): a "degraded but not failed" state
 * where every request succeeds eventually, but p90 latency creeps up. A pure
 * failure-rate trigger would miss this — so this breaker tracks both.
 *
 * STATE MACHINE
 *
 *   CLOSED — happy path. Track every call, roll oldest out of window.
 *           If failure_rate ≥ trip_failure_rate OR p90_latency ≥ trip_p90_ms
 *           over the current window → OPEN.
 *
 *   OPEN   — trip has occurred. admit() throws CircuitOpenError until
 *           cooldown_ms has elapsed since the trip.
 *
 *   HALF_OPEN — cooldown elapsed. The single admitted probe carries a
 *           probe-token; only ONE in-flight probe at any time (synchronous
 *           single-flight claim on admission).
 *
 * TOKENS (K2)
 *
 * Every admission returns an Object.freeze()d token tracked in a private
 * WeakSet<object> issued/consumed registry. Tokens are one-shot and
 * breaker-bound. Plain-object forgery and cross-breaker tokens are
 * detected as `invalid_token`.
 *
 * EPOCHS (D6b)
 *
 *   closedEpoch     bumps on every HALF_OPEN → CLOSED
 *   tripGeneration  bumps on every CLOSED → OPEN
 *   recoveryEpoch   bumps on every HALF_OPEN → OPEN (same trip generation);
 *                   resets to 0 on CLOSED → OPEN and on HALF_OPEN → CLOSED
 *   probeSequence   bumps on every OPEN → HALF_OPEN (globally monotonic)
 *   stateRevision   bumps on every state mutation (globally monotonic)
 *
 * DETERMINISM
 *
 * All time reads go through the constructor-injected `now()` clock. There is
 * no caller-supplied `now` parameter on admit() or recordOutcome() (K3).
 * There is no public reset() (K3).
 */

export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export interface CircuitBreakerConfig {
  /** Max samples in the sliding window. Older samples roll out. Default: 20. */
  windowSize?: number;
  /** Max age of a sample in ms. Older samples roll out. Default: 60_000. */
  windowAgeMs?: number;
  /**
   * Failure-rate threshold that trips the circuit. 0.5 = trip when ≥50% of
   * window samples are failures. Default: 0.5.
   * Only enforced once the window has at least `minSamples` samples.
   */
  tripFailureRate?: number;
  /**
   * p90 latency threshold that trips the circuit, in ms. Default: 15_000.
   * Only enforced once the window has at least `minSamples` samples.
   */
  tripP90LatencyMs?: number;
  /**
   * Min samples required before either threshold can trip. Prevents
   * cold-start false trips. Default: 5.
   */
  minSamples?: number;
  /**
   * Cooldown in ms after OPEN before entering HALF_OPEN. Default: 30_000.
   */
  cooldownMs?: number;
  /**
   * Max latency for the half-open probe request. If the probe succeeds but
   * exceeds this, we go back to OPEN. Default: equal to tripP90LatencyMs.
   */
  probeMaxLatencyMs?: number;
  /** Injected clock — test-only field. Defaults to Date.now. */
  now?: () => number;
}

interface Sample {
  timestamp: number;
  latencyMs: number;
  failed: boolean;
}

export class CircuitOpenError extends Error {
  constructor(
    public readonly circuitName: string,
    public readonly state: CircuitState,
    public readonly reason: string,
  ) {
    super(`[circuit-breaker] ${circuitName} is ${state}: ${reason}`);
    this.name = 'CircuitOpenError';
  }
}

const DEFAULTS: Required<Omit<CircuitBreakerConfig, 'now'>> = {
  windowSize: 20,
  windowAgeMs: 60_000,
  tripFailureRate: 0.5,
  tripP90LatencyMs: 15_000,
  minSamples: 5,
  cooldownMs: 30_000,
  probeMaxLatencyMs: 15_000,
};

// -----------------------------------------------------------------------------
// Token & event types (S3 discriminated)
// -----------------------------------------------------------------------------

export type NormalAdmissionToken = Readonly<{
  kind: 'normal';
  admissionSequence: number;
  closedEpoch: number;
  stateRevision: number;
}>;

export type ProbeAdmissionToken = Readonly<{
  kind: 'probe';
  admissionSequence: number;
  tripGeneration: number;
  recoveryEpoch: number;
  probeSequence: number;
  stateRevision: number;
}>;

export type CircuitAdmissionToken = NormalAdmissionToken | ProbeAdmissionToken;

export type CircuitTransitionEvent =
  | {
      kind: 'closed_to_open';
      reason: 'failure_rate' | 'latency';
      alias: string;
      from: 'CLOSED';
      to: 'OPEN';
      at: number;
      tripGeneration: number;
      stateRevision: number;
    }
  | {
      kind: 'open_to_half_open';
      alias: string;
      from: 'OPEN';
      to: 'HALF_OPEN';
      at: number;
      tripGeneration: number;
      recoveryEpoch: number;
      probeSequence: number;
      stateRevision: number;
    }
  | {
      kind: 'half_open_to_open';
      reason: 'probe_failed' | 'probe_slow';
      alias: string;
      from: 'HALF_OPEN';
      to: 'OPEN';
      at: number;
      tripGeneration: number;
      recoveryEpoch: number;
      probeSequence: number;
      stateRevision: number;
    }
  | {
      kind: 'half_open_to_closed';
      alias: string;
      from: 'HALF_OPEN';
      to: 'CLOSED';
      at: number;
      tripGeneration: number;
      recoveryEpoch: number;
      probeSequence: number;
      closedEpoch: number;
      stateRevision: number;
    };

export type CircuitStaleResultEvent = {
  kind: 'stale_result';
  reason:
    | 'invalid_token'
    | 'already_consumed'
    | 'wrong_state'
    | 'wrong_epoch'
    | 'wrong_generation';
  alias: string;
  at: number;
  stateRevision: number;
};

export type CircuitInvalidOutcomeEvent = {
  kind: 'invalid_outcome';
  reason: 'nan_latency' | 'infinite_latency' | 'negative_latency';
  alias: string;
  at: number;
  stateRevision: number;
};

export type CircuitDomainEvent =
  | CircuitTransitionEvent
  | CircuitStaleResultEvent
  | CircuitInvalidOutcomeEvent;

export type CircuitAdmission =
  | {
      kind: 'normal';
      token: NormalAdmissionToken;
      events: readonly CircuitTransitionEvent[];
    }
  | {
      kind: 'probe';
      token: ProbeAdmissionToken;
      events: readonly CircuitTransitionEvent[];
    };

export interface CircuitMutationResult {
  readonly accepted: boolean;
  readonly events: readonly CircuitDomainEvent[];
}

export interface CircuitSnapshot {
  state: CircuitState;
  sampleCount: number;
  failureRate: number;
  p90LatencyMs: number;
  openedAt: number | null;
  lastTripReason: string;
  closedEpoch: number;
  tripGeneration: number;
  recoveryEpoch: number;
  probeSequence: number;
  stateRevision: number;
}

// -----------------------------------------------------------------------------

export class CircuitBreaker {
  private state: CircuitState = 'CLOSED';
  private readonly samples: Sample[] = [];
  private openedAt: number | null = null;
  private readonly config: Required<Omit<CircuitBreakerConfig, 'now'>>;
  private readonly now: () => number;
  /** Cause of the most recent trip — for CircuitOpenError.reason and telemetry. */
  private lastTripReason: string = '';

  // Epochs / generations (D6b)
  private closedEpoch = 0;
  private tripGeneration = 0;
  private recoveryEpoch = 0;
  private probeSequence = 0;
  private stateRevision = 0;
  private admissionSequence = 0;

  // Probe single-flight flag (I3): set inside admit() when we hand out a probe
  // token; cleared inside recordOutcome() when the probe completes (accepted or
  // stale). Only one in-flight probe at a time.
  private probeInFlight = false;

  // Token identity registry (K2). WeakSet<object> — tokens are frozen objects.
  private readonly issued = new WeakSet<object>();
  private readonly consumed = new WeakSet<object>();

  constructor(public readonly name: string, config: CircuitBreakerConfig = {}) {
    this.config = {
      windowSize: config.windowSize ?? DEFAULTS.windowSize,
      windowAgeMs: config.windowAgeMs ?? DEFAULTS.windowAgeMs,
      tripFailureRate: config.tripFailureRate ?? DEFAULTS.tripFailureRate,
      tripP90LatencyMs: config.tripP90LatencyMs ?? DEFAULTS.tripP90LatencyMs,
      minSamples: config.minSamples ?? DEFAULTS.minSamples,
      cooldownMs: config.cooldownMs ?? DEFAULTS.cooldownMs,
      probeMaxLatencyMs:
        config.probeMaxLatencyMs ?? config.tripP90LatencyMs ?? DEFAULTS.probeMaxLatencyMs,
    };
    this.now = config.now ?? Date.now;
  }

  /**
   * Attempt to admit a call. Returns a discriminated admission carrying a
   * frozen one-shot token plus any transition events that occurred during
   * admission (currently only `open_to_half_open`). Throws CircuitOpenError
   * if the circuit refuses the call (OPEN in cooldown, or HALF_OPEN with a
   * probe in flight).
   */
  admit(): CircuitAdmission {
    const now = this.now();
    const events: CircuitTransitionEvent[] = [];

    if (this.state === 'OPEN') {
      const openedFor = now - (this.openedAt ?? 0);
      if (openedFor >= this.config.cooldownMs) {
        // OPEN → HALF_OPEN synchronously; the current admission is the probe.
        this.state = 'HALF_OPEN';
        this.probeSequence += 1;
        this.stateRevision += 1;
        events.push({
          kind: 'open_to_half_open',
          alias: this.name,
          from: 'OPEN',
          to: 'HALF_OPEN',
          at: now,
          tripGeneration: this.tripGeneration,
          recoveryEpoch: this.recoveryEpoch,
          probeSequence: this.probeSequence,
          stateRevision: this.stateRevision,
        });
        // fall through to HALF_OPEN branch below to issue the probe token
      } else {
        throw new CircuitOpenError(this.name, 'OPEN', this.lastTripReason);
      }
    }

    if (this.state === 'HALF_OPEN') {
      if (this.probeInFlight) {
        throw new CircuitOpenError(
          this.name,
          'HALF_OPEN',
          'probe request already in flight',
        );
      }
      // Claim the probe slot synchronously — no await between the state check
      // and this assignment, so a concurrent admit() in the same microtask
      // will see probeInFlight=true and throw. (I3)
      this.probeInFlight = true;
      this.admissionSequence += 1;
      const token: ProbeAdmissionToken = Object.freeze({
        kind: 'probe',
        admissionSequence: this.admissionSequence,
        tripGeneration: this.tripGeneration,
        recoveryEpoch: this.recoveryEpoch,
        probeSequence: this.probeSequence,
        stateRevision: this.stateRevision,
      });
      this.issued.add(token);
      return { kind: 'probe', token, events };
    }

    // CLOSED
    this.admissionSequence += 1;
    const token: NormalAdmissionToken = Object.freeze({
      kind: 'normal',
      admissionSequence: this.admissionSequence,
      closedEpoch: this.closedEpoch,
      stateRevision: this.stateRevision,
    });
    this.issued.add(token);
    return { kind: 'normal', token, events };
  }

  /**
   * Report the outcome of an admitted call. Consumes the token. Returns a
   * mutation result with `accepted` and any domain events emitted by this
   * mutation (transitions and/or stale_result and/or invalid_outcome).
   */
  recordOutcome(
    token: CircuitAdmissionToken,
    outcome: { ok: boolean; netLatencyMs: number },
  ): CircuitMutationResult {
    const now = this.now();

    // -- K2: Identity checks. Neither branch mutates state or samples. --
    if (!this.issued.has(token)) {
      return this.staleOnly('invalid_token', now);
    }
    if (this.consumed.has(token)) {
      return this.staleOnly('already_consumed', now);
    }
    // Token is legit and unused → mark it consumed. Even if we later reject
    // due to state/epoch mismatch or invalid latency, the token is one-shot.
    this.consumed.add(token);

    // -- D6a: Latency validation. NaN/Infinity/negative → coerce to Failure. --
    const invalidOutcomeEvents: CircuitInvalidOutcomeEvent[] = [];
    let ok = outcome.ok;
    let netLatencyMs = outcome.netLatencyMs;
    if (Number.isNaN(netLatencyMs)) {
      invalidOutcomeEvents.push(this.makeInvalidOutcome('nan_latency', now));
      ok = false;
      netLatencyMs = 0;
    } else if (!Number.isFinite(netLatencyMs)) {
      invalidOutcomeEvents.push(this.makeInvalidOutcome('infinite_latency', now));
      ok = false;
      netLatencyMs = 0;
    } else if (netLatencyMs < 0) {
      invalidOutcomeEvents.push(this.makeInvalidOutcome('negative_latency', now));
      ok = false;
      netLatencyMs = 0;
    }

    // -- S1: State/epoch checks. Explicit reason priority. --
    if (token.kind === 'normal') {
      if (this.state !== 'CLOSED') {
        return this.combine(invalidOutcomeEvents, this.staleOnly('wrong_state', now));
      }
      if (token.closedEpoch !== this.closedEpoch) {
        return this.combine(invalidOutcomeEvents, this.staleOnly('wrong_epoch', now));
      }
      // Accept sample into current CLOSED window.
      this.samples.push({ timestamp: now, latencyMs: netLatencyMs, failed: !ok });
      this.evictExpired(now);
      while (this.samples.length > this.config.windowSize) {
        this.samples.shift();
      }
      const tripEvent = this.evaluateTrip(now);
      const events: CircuitDomainEvent[] = [...invalidOutcomeEvents];
      if (tripEvent) events.push(tripEvent);
      return { accepted: true, events };
    }

    // token.kind === 'probe'
    if (this.state !== 'HALF_OPEN') {
      // Probe outcome arriving after state has moved on — release probe slot
      // defensively if we still think a probe is in flight.
      this.probeInFlight = false;
      return this.combine(invalidOutcomeEvents, this.staleOnly('wrong_state', now));
    }
    if (token.tripGeneration !== this.tripGeneration) {
      this.probeInFlight = false;
      return this.combine(invalidOutcomeEvents, this.staleOnly('wrong_generation', now));
    }
    if (
      token.recoveryEpoch !== this.recoveryEpoch ||
      token.probeSequence !== this.probeSequence
    ) {
      this.probeInFlight = false;
      return this.combine(invalidOutcomeEvents, this.staleOnly('wrong_epoch', now));
    }

    // Probe legitimately completes.
    this.probeInFlight = false;
    const events: CircuitDomainEvent[] = [...invalidOutcomeEvents];
    if (ok && netLatencyMs <= this.config.probeMaxLatencyMs) {
      // HALF_OPEN → CLOSED
      this.closedEpoch += 1;
      this.recoveryEpoch = 0;
      this.stateRevision += 1;
      this.state = 'CLOSED';
      this.openedAt = null;
      this.samples.length = 0;
      events.push({
        kind: 'half_open_to_closed',
        alias: this.name,
        from: 'HALF_OPEN',
        to: 'CLOSED',
        at: now,
        tripGeneration: this.tripGeneration,
        recoveryEpoch: 0,
        probeSequence: this.probeSequence,
        closedEpoch: this.closedEpoch,
        stateRevision: this.stateRevision,
      });
    } else {
      // HALF_OPEN → OPEN (same trip generation, recoveryEpoch bumps)
      const reason: 'probe_failed' | 'probe_slow' = ok ? 'probe_slow' : 'probe_failed';
      const reasonText = ok
        ? `probe succeeded but latency ${netLatencyMs}ms > ${this.config.probeMaxLatencyMs}ms`
        : `probe failed after ${netLatencyMs}ms`;
      this.recoveryEpoch += 1;
      this.stateRevision += 1;
      this.state = 'OPEN';
      this.openedAt = now;
      this.lastTripReason = reasonText;
      events.push({
        kind: 'half_open_to_open',
        reason,
        alias: this.name,
        from: 'HALF_OPEN',
        to: 'OPEN',
        at: now,
        tripGeneration: this.tripGeneration,
        recoveryEpoch: this.recoveryEpoch,
        probeSequence: this.probeSequence,
        stateRevision: this.stateRevision,
      });
    }
    return { accepted: true, events };
  }

  /** State snapshot for telemetry / test assertions. */
  snapshot(): CircuitSnapshot {
    this.evictExpired(this.now());
    const failed = this.samples.filter((s) => s.failed).length;
    const failureRate = this.samples.length === 0 ? 0 : failed / this.samples.length;
    return {
      state: this.state,
      sampleCount: this.samples.length,
      failureRate,
      p90LatencyMs: p90(this.samples.map((s) => s.latencyMs)),
      openedAt: this.openedAt,
      lastTripReason: this.lastTripReason,
      closedEpoch: this.closedEpoch,
      tripGeneration: this.tripGeneration,
      recoveryEpoch: this.recoveryEpoch,
      probeSequence: this.probeSequence,
      stateRevision: this.stateRevision,
    };
  }

  // ---- private helpers ------------------------------------------------------

  private staleOnly(
    reason: CircuitStaleResultEvent['reason'],
    at: number,
  ): CircuitMutationResult {
    return {
      accepted: false,
      events: [
        {
          kind: 'stale_result',
          reason,
          alias: this.name,
          at,
          stateRevision: this.stateRevision,
        },
      ],
    };
  }

  private makeInvalidOutcome(
    reason: CircuitInvalidOutcomeEvent['reason'],
    at: number,
  ): CircuitInvalidOutcomeEvent {
    return {
      kind: 'invalid_outcome',
      reason,
      alias: this.name,
      at,
      stateRevision: this.stateRevision,
    };
  }

  private combine(
    invalidOutcomes: readonly CircuitInvalidOutcomeEvent[],
    tail: CircuitMutationResult,
  ): CircuitMutationResult {
    if (invalidOutcomes.length === 0) return tail;
    return {
      accepted: tail.accepted,
      events: [...invalidOutcomes, ...tail.events],
    };
  }

  private evictExpired(now: number): void {
    while (this.samples.length > 0) {
      const oldest = this.samples[0];
      if (oldest && now - oldest.timestamp > this.config.windowAgeMs) {
        this.samples.shift();
      } else {
        break;
      }
    }
  }

  private evaluateTrip(now: number): CircuitTransitionEvent | null {
    if (this.samples.length < this.config.minSamples) return null;

    const failed = this.samples.filter((s) => s.failed).length;
    const failureRate = failed / this.samples.length;
    if (failureRate >= this.config.tripFailureRate) {
      return this.trip(
        'failure_rate',
        `failure rate ${(failureRate * 100).toFixed(0)}% ≥ ${(this.config.tripFailureRate * 100).toFixed(0)}% over ${this.samples.length} samples`,
        now,
      );
    }

    const p90Latency = p90(this.samples.map((s) => s.latencyMs));
    if (p90Latency >= this.config.tripP90LatencyMs) {
      return this.trip(
        'latency',
        `p90 latency ${p90Latency}ms ≥ ${this.config.tripP90LatencyMs}ms over ${this.samples.length} samples`,
        now,
      );
    }
    return null;
  }

  private trip(
    reason: 'failure_rate' | 'latency',
    reasonText: string,
    now: number,
  ): CircuitTransitionEvent {
    this.tripGeneration += 1;
    this.recoveryEpoch = 0;
    this.stateRevision += 1;
    this.state = 'OPEN';
    this.openedAt = now;
    this.lastTripReason = reasonText;
    return {
      kind: 'closed_to_open',
      reason,
      alias: this.name,
      from: 'CLOSED',
      to: 'OPEN',
      at: now,
      tripGeneration: this.tripGeneration,
      stateRevision: this.stateRevision,
    };
  }
}

/**
 * p90 of a sample array. Returns 0 for empty input. Uses nearest-rank.
 */
function p90(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.ceil(0.9 * sorted.length) - 1);
  const clamped = Math.max(0, idx);
  return sorted[clamped] ?? 0;
}
