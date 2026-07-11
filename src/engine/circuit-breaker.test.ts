import { describe, it, expect } from 'vitest';
import { CircuitBreaker, CircuitOpenError } from './circuit-breaker';

/**
 * All tests use an injected clock so state transitions can be verified
 * without setTimeout / Date.now dependencies. Each test builds its own
 * FakeClock; we do NOT share a clock across tests to keep failure output
 * localised.
 */
function makeClock(startAt = 1_000_000): { now: () => number; advance: (ms: number) => void } {
  let t = startAt;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

describe('CircuitBreaker — state machine', () => {
  it('starts CLOSED and stays CLOSED under healthy load', () => {
    const clock = makeClock();
    const cb = new CircuitBreaker('serv-nano', { now: clock.now, minSamples: 3 });
    for (let i = 0; i < 10; i++) {
      cb.canProceed();
      cb.recordSuccess(500);
      clock.advance(100);
    }
    expect(cb.snapshot().state).toBe('CLOSED');
    expect(cb.snapshot().failureRate).toBe(0);
  });

  it('does not trip before minSamples is reached, even at 100% failure', () => {
    const clock = makeClock();
    const cb = new CircuitBreaker('serv-nano', {
      now: clock.now,
      minSamples: 5,
      tripFailureRate: 0.5,
    });
    for (let i = 0; i < 4; i++) {
      cb.canProceed();
      cb.recordFailure(500);
      clock.advance(100);
    }
    expect(cb.snapshot().state).toBe('CLOSED');
    expect(cb.snapshot().sampleCount).toBe(4);
  });

  it('trips OPEN when failure rate crosses threshold', () => {
    const clock = makeClock();
    const cb = new CircuitBreaker('serv-nano', {
      now: clock.now,
      minSamples: 5,
      tripFailureRate: 0.5,
      windowSize: 10,
    });
    // 2 success + 2 failures = 4 samples (below minSamples — no trip yet)
    for (let i = 0; i < 2; i++) {
      cb.canProceed();
      cb.recordSuccess(500);
      clock.advance(100);
    }
    for (let i = 0; i < 2; i++) {
      cb.canProceed();
      cb.recordFailure(500);
      clock.advance(100);
    }
    expect(cb.snapshot().state).toBe('CLOSED');
    // 3rd failure — 5 samples, 3/5 = 60 % failure rate → trip
    cb.canProceed();
    cb.recordFailure(500);
    const snap = cb.snapshot();
    expect(snap.state).toBe('OPEN');
    expect(snap.lastTripReason).toContain('failure rate');
    expect(snap.lastTripReason).toContain('60%');
  });

  it('trips OPEN when p90 latency crosses threshold (degraded-but-not-failed case)', () => {
    const clock = makeClock();
    const cb = new CircuitBreaker('serv-nano', {
      now: clock.now,
      minSamples: 5,
      tripP90LatencyMs: 10_000,
      windowSize: 10,
    });
    // Feed samples one at a time, tolerating the mid-loop trip. All calls are
    // successes (no failure-rate signal), just increasingly slow.
    const latencies = [2_000, 3_000, 4_000, 5_000, 8_000, 15_000, 18_000, 20_000, 22_000, 25_000];
    let tripped = false;
    for (const lat of latencies) {
      try {
        cb.canProceed();
      } catch (err) {
        tripped = true;
        break;
      }
      cb.recordSuccess(lat);
      clock.advance(100);
    }
    // Either the loop tripped mid-way, or the last sample tripped it.
    const snap = cb.snapshot();
    expect(snap.state).toBe('OPEN');
    expect(snap.lastTripReason).toContain('p90 latency');
    // Every sample was a success — the trip must NOT mention failure rate
    expect(snap.failureRate).toBe(0);
    // tripped may or may not be true depending on when p90 exceeds threshold;
    // the important assertion is the state.
    void tripped;
  });

  it('refuses calls with CircuitOpenError while OPEN and cooldown has not elapsed', () => {
    const clock = makeClock();
    const cb = new CircuitBreaker('serv-nano', {
      now: clock.now,
      minSamples: 3,
      tripFailureRate: 0.5,
      cooldownMs: 30_000,
    });
    // Feed just enough failures to trip (3), then verify OPEN. Any further
    // canProceed() should throw — that's the assertion below.
    for (let i = 0; i < 3; i++) {
      cb.canProceed();
      cb.recordFailure(500);
      clock.advance(100);
    }
    expect(cb.snapshot().state).toBe('OPEN');

    // Immediately after tripping, canProceed must throw
    expect(() => cb.canProceed()).toThrow(CircuitOpenError);

    // After 10s (still within cooldown), still throws
    clock.advance(10_000);
    expect(() => cb.canProceed()).toThrow(CircuitOpenError);
  });

  it('transitions OPEN → HALF_OPEN after cooldown and closes on healthy probe', () => {
    const clock = makeClock();
    const cb = new CircuitBreaker('serv-nano', {
      now: clock.now,
      minSamples: 3,
      tripFailureRate: 0.5,
      cooldownMs: 30_000,
      probeMaxLatencyMs: 5_000,
    });
    // Trip it — 3 failures reach minSamples & 100% failure rate
    for (let i = 0; i < 3; i++) {
      cb.canProceed();
      cb.recordFailure(500);
      clock.advance(100);
    }
    expect(cb.snapshot().state).toBe('OPEN');

    // Advance past cooldown
    clock.advance(31_000);

    // First canProceed after cooldown should allow the probe through
    expect(() => cb.canProceed()).not.toThrow();
    // While probe is in flight, further calls are rejected
    expect(() => cb.canProceed()).toThrow(CircuitOpenError);

    // Probe succeeds fast → close
    cb.recordSuccess(1_000);
    expect(cb.snapshot().state).toBe('CLOSED');
    // Window is reset — no samples carried over
    expect(cb.snapshot().sampleCount).toBe(0);
  });

  it('re-trips from HALF_OPEN when probe fails', () => {
    const clock = makeClock();
    const cb = new CircuitBreaker('serv-nano', {
      now: clock.now,
      minSamples: 3,
      tripFailureRate: 0.5,
      cooldownMs: 30_000,
    });
    for (let i = 0; i < 3; i++) {
      cb.canProceed();
      cb.recordFailure(500);
      clock.advance(100);
    }
    clock.advance(31_000);
    // Probe allowed
    cb.canProceed();
    // Probe fails
    cb.recordFailure(2_000);
    const snap = cb.snapshot();
    expect(snap.state).toBe('OPEN');
    expect(snap.lastTripReason).toContain('probe failed');
  });

  it('re-trips from HALF_OPEN when probe succeeds slowly (still degraded)', () => {
    const clock = makeClock();
    const cb = new CircuitBreaker('serv-nano', {
      now: clock.now,
      minSamples: 3,
      tripP90LatencyMs: 10_000,
      cooldownMs: 30_000,
      probeMaxLatencyMs: 5_000,
    });
    // Trip on latency — 3 slow successes reach minSamples & p90 well above 10s
    for (let i = 0; i < 3; i++) {
      cb.canProceed();
      cb.recordSuccess(20_000);
      clock.advance(100);
    }
    expect(cb.snapshot().state).toBe('OPEN');
    clock.advance(31_000);
    cb.canProceed();
    // Probe succeeds but slowly
    cb.recordSuccess(12_000);
    const snap = cb.snapshot();
    expect(snap.state).toBe('OPEN');
    expect(snap.lastTripReason).toContain('probe succeeded but latency');
  });

  it('rolls samples out of the window by count', () => {
    const clock = makeClock();
    // Higher tripFailureRate so successes can accumulate without tripping
    const cb = new CircuitBreaker('serv-nano', {
      now: clock.now,
      minSamples: 3,
      windowSize: 5,
      tripFailureRate: 0.9,
    });
    // 8 successes at 500ms — window should be capped at 5
    for (let i = 0; i < 8; i++) {
      cb.canProceed();
      cb.recordSuccess(500);
      clock.advance(100);
    }
    expect(cb.snapshot().state).toBe('CLOSED');
    expect(cb.snapshot().sampleCount).toBe(5);

    // Now flip to failures — after 5 (windowSize) all samples fail → 100% → trip
    for (let i = 0; i < 5; i++) {
      cb.canProceed();
      cb.recordFailure(500);
      clock.advance(100);
    }
    expect(cb.snapshot().state).toBe('OPEN');
    expect(cb.snapshot().sampleCount).toBe(5);

    // After a probe closes it (cooldown default 30s in this test — override needed)
  });

  it('rolls samples out of the window by age (windowAgeMs)', () => {
    const clock = makeClock();
    // Very high tripFailureRate — we're testing age eviction, not trip logic
    const cb = new CircuitBreaker('serv-nano', {
      now: clock.now,
      minSamples: 5,
      windowSize: 100,
      windowAgeMs: 60_000,
      tripFailureRate: 0.99,
    });
    // 4 failures at t=0 — below minSamples so no trip
    for (let i = 0; i < 4; i++) {
      cb.canProceed();
      cb.recordFailure(500);
    }
    // Advance past the age window
    clock.advance(61_000);
    // 2 successes — old failures should have rolled out
    cb.canProceed();
    cb.recordSuccess(500);
    cb.canProceed();
    cb.recordSuccess(500);
    const snap = cb.snapshot();
    // With only the 2 recent samples in the window (below minSamples=3),
    // trip cannot fire and failure rate is 0
    expect(snap.state).toBe('CLOSED');
    expect(snap.sampleCount).toBe(2);
    expect(snap.failureRate).toBe(0);
  });
});
