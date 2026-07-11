/**
 * Circuit Breaker with sliding-window failure-rate + p90-latency detection.
 *
 * PURPOSE
 * The DQL cascade calls the SERV inference API for every axis of every case.
 * When SERV is under load, individual requests either (a) fail transient, or
 * (b) succeed slowly (30-50s latency). The in-client retry loop handles (a)
 * cleanly (0/2500 fetch-failed in v0.4.1c baseline). What it does NOT handle
 * is (b): a "degraded but not failed" state where every request succeeds
 * eventually, but p90 latency creeps up and drags Sentinel Trade-Verify to
 * p90=22s. That's the actual production bottleneck.
 *
 * A pure failure-rate trigger (3b) would miss this — no failures, just slow
 * successes. So this breaker tracks both dimensions: failure rate AND p90
 * latency over a sliding window. Either threshold trips the circuit.
 *
 * STATE MACHINE
 *
 *   CLOSED — happy path. Track every call, roll oldest out of window.
 *           If failure_rate ≥ trip_failure_rate OR p90_latency ≥ trip_p90_ms
 *           over the current window → OPEN.
 *
 *   OPEN   — trip has occurred. All calls are refused with CircuitOpenError
 *           until cooldown_ms has elapsed since the trip. Caller (HttpLlmClient)
 *           is responsible for routing to a fallback binding — this class
 *           does not know or care what the fallback is.
 *
 *   HALF_OPEN — cooldown elapsed. The NEXT call is allowed through as a
 *           probe. If it succeeds within probe_max_latency_ms → CLOSED,
 *           window is reset. If it fails or is too slow → OPEN again with
 *           a fresh cooldown timer.
 *
 * WHY SLIDING-WINDOW, NOT CONSECUTIVE-N
 *
 * Consecutive-N (e.g. "5 failures in a row → trip") reacts too slowly to
 * gradual degradation. A window that says "≥50% failure over the last 20
 * requests within the last 60s" catches the same signal that Sentinel's own
 * RCA (2026-07-08) needed to catch: intermittent slowness that only shows
 * up when you look at the aggregate.
 *
 * WINDOW SIZE
 *
 * The window is bounded in BOTH count (max N samples) and time (max age_ms).
 * A sample rolls out when EITHER limit is exceeded, whichever fires first.
 * This prevents a burst of quick requests from evicting older-but-relevant
 * samples, and prevents ancient samples from lingering when traffic is slow.
 *
 * DETERMINISM
 *
 * All time reads go through the injected `now()` clock. Tests can drive the
 * breaker deterministically without setTimeout / Date.now dependencies.
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
   * p90 latency threshold that trips the circuit, in ms. Default: 15_000
   * (15s — well below Sentinel's degraded p90=22s but above healthy SERV
   * response times ~2-6s under normal load).
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
   * exceeds this, we go back to OPEN (SERV is still degraded). Default:
   * equal to tripP90LatencyMs.
   */
  probeMaxLatencyMs?: number;
  /** Injected clock — defaults to Date.now. */
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
    public readonly reason: string
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

export class CircuitBreaker {
  private state: CircuitState = 'CLOSED';
  private readonly samples: Sample[] = [];
  private openedAt: number | null = null;
  private readonly config: Required<Omit<CircuitBreakerConfig, 'now'>>;
  private readonly now: () => number;
  /** Cause of the most recent trip — for CircuitOpenError.reason and telemetry. */
  private lastTripReason: string = '';

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
   * Check whether a call may proceed. Throws CircuitOpenError when the
   * circuit is OPEN and cooldown has not elapsed. Transitions OPEN→HALF_OPEN
   * transparently when cooldown ends.
   *
   * When HALF_OPEN, the FIRST call to canProceed() returns without throwing
   * (probe allowed); subsequent HALF_OPEN calls throw until the probe result
   * is reported via recordSuccess / recordFailure.
   */
  canProceed(): void {
    if (this.state === 'CLOSED') return;

    if (this.state === 'OPEN') {
      const openedFor = this.now() - (this.openedAt ?? 0);
      if (openedFor >= this.config.cooldownMs) {
        // Cooldown elapsed → transition to HALF_OPEN; the current call is
        // the probe.
        this.state = 'HALF_OPEN';
        return;
      }
      throw new CircuitOpenError(this.name, 'OPEN', this.lastTripReason);
    }

    // HALF_OPEN: only one in-flight probe allowed. We track this implicitly:
    // once a call is allowed through in HALF_OPEN state, we flip to
    // 'PROBING' semantics by not permitting further calls until a result is
    // reported. We express this by requiring the caller to record the
    // probe outcome before another canProceed() succeeds.
    //
    // Simple implementation: if state is HALF_OPEN, we've ALREADY allowed
    // one probe through (via the OPEN→HALF_OPEN transition above). Any
    // subsequent canProceed() call before recordSuccess/recordFailure means
    // a concurrent request — reject to keep probes single-flight.
    throw new CircuitOpenError(
      this.name,
      'HALF_OPEN',
      'probe request already in flight'
    );
  }

  /**
   * Record a successful call with its latency. Advances state as needed:
   *   - HALF_OPEN + latency ≤ probeMaxLatencyMs → CLOSED (window reset)
   *   - HALF_OPEN + latency > probeMaxLatencyMs → OPEN (still degraded)
   *   - CLOSED → append sample, check trip conditions
   */
  recordSuccess(latencyMs: number): void {
    if (this.state === 'HALF_OPEN') {
      if (latencyMs <= this.config.probeMaxLatencyMs) {
        this.close();
      } else {
        this.trip(`probe succeeded but latency ${latencyMs}ms > ${this.config.probeMaxLatencyMs}ms`);
      }
      return;
    }

    if (this.state === 'OPEN') {
      // Shouldn't happen — canProceed should have thrown. Ignore.
      return;
    }

    this.appendSample({ timestamp: this.now(), latencyMs, failed: false });
    this.evaluateTrip();
  }

  /**
   * Record a failed call. Advances state as needed:
   *   - HALF_OPEN → OPEN (still broken)
   *   - CLOSED → append sample, check trip conditions
   */
  recordFailure(latencyMs: number): void {
    if (this.state === 'HALF_OPEN') {
      this.trip(`probe failed after ${latencyMs}ms`);
      return;
    }

    if (this.state === 'OPEN') {
      return;
    }

    this.appendSample({ timestamp: this.now(), latencyMs, failed: true });
    this.evaluateTrip();
  }

  /** State snapshot for telemetry / test assertions. */
  snapshot(): {
    state: CircuitState;
    sampleCount: number;
    failureRate: number;
    p90LatencyMs: number;
    openedAt: number | null;
    lastTripReason: string;
  } {
    this.evictExpired();
    const failed = this.samples.filter((s) => s.failed).length;
    const failureRate = this.samples.length === 0 ? 0 : failed / this.samples.length;
    return {
      state: this.state,
      sampleCount: this.samples.length,
      failureRate,
      p90LatencyMs: p90(this.samples.map((s) => s.latencyMs)),
      openedAt: this.openedAt,
      lastTripReason: this.lastTripReason,
    };
  }

  private appendSample(sample: Sample): void {
    this.samples.push(sample);
    this.evictExpired();
    while (this.samples.length > this.config.windowSize) {
      this.samples.shift();
    }
  }

  private evictExpired(): void {
    const now = this.now();
    while (this.samples.length > 0) {
      const oldest = this.samples[0];
      if (oldest && now - oldest.timestamp > this.config.windowAgeMs) {
        this.samples.shift();
      } else {
        break;
      }
    }
  }

  private evaluateTrip(): void {
    if (this.samples.length < this.config.minSamples) return;

    const failed = this.samples.filter((s) => s.failed).length;
    const failureRate = failed / this.samples.length;
    if (failureRate >= this.config.tripFailureRate) {
      this.trip(
        `failure rate ${(failureRate * 100).toFixed(0)}% ≥ ${(this.config.tripFailureRate * 100).toFixed(0)}% over ${this.samples.length} samples`
      );
      return;
    }

    const p90Latency = p90(this.samples.map((s) => s.latencyMs));
    if (p90Latency >= this.config.tripP90LatencyMs) {
      this.trip(
        `p90 latency ${p90Latency}ms ≥ ${this.config.tripP90LatencyMs}ms over ${this.samples.length} samples`
      );
      return;
    }
  }

  private trip(reason: string): void {
    this.state = 'OPEN';
    this.openedAt = this.now();
    this.lastTripReason = reason;
  }

  private close(): void {
    this.state = 'CLOSED';
    this.openedAt = null;
    this.samples.length = 0;
    // Keep lastTripReason for telemetry — helpful to see what caused the
    // most recent trip even after the circuit closes.
  }
}

/**
 * p90 of a sample array. Returns 0 for empty input. Uses nearest-rank
 * (not linear interpolation) — matches Sentinel's p90 calculation and is
 * simpler to reason about at low N.
 */
function p90(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.ceil(0.9 * sorted.length) - 1);
  const clamped = Math.max(0, idx);
  return sorted[clamped] ?? 0;
}
