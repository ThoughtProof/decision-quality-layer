import { describe, it, expect } from 'vitest';
import {
  CircuitBreaker,
  CircuitOpenError,
  CircuitAdmissionToken,
  NormalAdmissionToken,
  ProbeAdmissionToken,
  CircuitTransitionEvent,
  CircuitStaleResultEvent,
  CircuitInvalidOutcomeEvent,
} from './circuit-breaker';

/**
 * All tests use an injected clock so state transitions can be verified
 * without setTimeout / Date.now dependencies. Each test builds its own
 * FakeClock; we do NOT share a clock across tests to keep failure output
 * localised.
 *
 * v0.4.3.1 §E: The API is admit() + recordOutcome(token, outcome). The
 * two small helpers below (`success` / `failure`) capture the common case
 * of "admit → immediately report outcome" so the older tests translate
 * with minimal noise.
 */
function makeClock(startAt = 1_000_000): {
  now: () => number;
  advance: (ms: number) => void;
} {
  let t = startAt;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

function success(cb: CircuitBreaker, latencyMs: number) {
  const adm = cb.admit();
  return cb.recordOutcome(adm.token, { ok: true, netLatencyMs: latencyMs });
}

function failure(cb: CircuitBreaker, latencyMs: number) {
  const adm = cb.admit();
  return cb.recordOutcome(adm.token, { ok: false, netLatencyMs: latencyMs });
}

describe('CircuitBreaker — state machine', () => {
  it('starts CLOSED and stays CLOSED under healthy load', () => {
    const clock = makeClock();
    const cb = new CircuitBreaker('serv-nano', { now: clock.now, minSamples: 3 });
    for (let i = 0; i < 10; i++) {
      success(cb, 500);
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
      failure(cb, 500);
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
    for (let i = 0; i < 2; i++) {
      success(cb, 500);
      clock.advance(100);
    }
    for (let i = 0; i < 2; i++) {
      failure(cb, 500);
      clock.advance(100);
    }
    expect(cb.snapshot().state).toBe('CLOSED');
    // 3rd failure — 5 samples, 3/5 = 60% failure rate → trip
    const res = failure(cb, 500);
    const snap = cb.snapshot();
    expect(snap.state).toBe('OPEN');
    expect(snap.lastTripReason).toContain('failure rate');
    expect(snap.lastTripReason).toContain('60%');
    // Event should be exactly-once closed_to_open
    const transitions = res.events.filter(
      (e): e is CircuitTransitionEvent => e.kind === 'closed_to_open',
    );
    expect(transitions).toHaveLength(1);
    const first = transitions[0]!;
    if (first.kind === 'closed_to_open') {
      expect(first.reason).toBe('failure_rate');
    }
  });

  it('trips OPEN when p90 latency crosses threshold (degraded-but-not-failed case)', () => {
    const clock = makeClock();
    const cb = new CircuitBreaker('serv-nano', {
      now: clock.now,
      minSamples: 5,
      tripP90LatencyMs: 10_000,
      windowSize: 10,
    });
    const latencies = [
      2_000, 3_000, 4_000, 5_000, 8_000, 15_000, 18_000, 20_000, 22_000, 25_000,
    ];
    for (const lat of latencies) {
      try {
        const adm = cb.admit();
        cb.recordOutcome(adm.token, { ok: true, netLatencyMs: lat });
      } catch {
        break;
      }
      clock.advance(100);
    }
    const snap = cb.snapshot();
    expect(snap.state).toBe('OPEN');
    expect(snap.lastTripReason).toContain('p90 latency');
    expect(snap.failureRate).toBe(0);
  });

  it('refuses calls with CircuitOpenError while OPEN and cooldown has not elapsed', () => {
    const clock = makeClock();
    const cb = new CircuitBreaker('serv-nano', {
      now: clock.now,
      minSamples: 3,
      tripFailureRate: 0.5,
      cooldownMs: 30_000,
    });
    for (let i = 0; i < 3; i++) {
      failure(cb, 500);
      clock.advance(100);
    }
    expect(cb.snapshot().state).toBe('OPEN');
    expect(() => cb.admit()).toThrow(CircuitOpenError);
    clock.advance(10_000);
    expect(() => cb.admit()).toThrow(CircuitOpenError);
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
    for (let i = 0; i < 3; i++) {
      failure(cb, 500);
      clock.advance(100);
    }
    expect(cb.snapshot().state).toBe('OPEN');
    clock.advance(31_000);

    const probe = cb.admit();
    expect(probe.kind).toBe('probe');
    // Transition event closed on admission
    const transitions = probe.events.filter(
      (e): e is CircuitTransitionEvent => e.kind === 'open_to_half_open',
    );
    expect(transitions).toHaveLength(1);
    // While probe is in flight, further calls are rejected
    expect(() => cb.admit()).toThrow(CircuitOpenError);

    const res = cb.recordOutcome(probe.token, { ok: true, netLatencyMs: 1_000 });
    expect(cb.snapshot().state).toBe('CLOSED');
    expect(cb.snapshot().sampleCount).toBe(0);
    const closeTransitions = res.events.filter(
      (e): e is CircuitTransitionEvent => e.kind === 'half_open_to_closed',
    );
    expect(closeTransitions).toHaveLength(1);
  });

  it('re-trips from HALF_OPEN when probe fails (half_open_to_open with reason=probe_failed)', () => {
    const clock = makeClock();
    const cb = new CircuitBreaker('serv-nano', {
      now: clock.now,
      minSamples: 3,
      tripFailureRate: 0.5,
      cooldownMs: 30_000,
    });
    for (let i = 0; i < 3; i++) {
      failure(cb, 500);
      clock.advance(100);
    }
    clock.advance(31_000);
    const probe = cb.admit();
    const res = cb.recordOutcome(probe.token, { ok: false, netLatencyMs: 2_000 });
    const snap = cb.snapshot();
    expect(snap.state).toBe('OPEN');
    expect(snap.lastTripReason).toContain('probe failed');
    const transitions = res.events.filter(
      (e): e is CircuitTransitionEvent => e.kind === 'half_open_to_open',
    );
    expect(transitions).toHaveLength(1);
    const first = transitions[0]!;
    if (first.kind === 'half_open_to_open') {
      expect(first.reason).toBe('probe_failed');
    }
  });

  it('T14: re-trips from HALF_OPEN when probe succeeds slowly with reason=probe_slow', () => {
    const clock = makeClock();
    const cb = new CircuitBreaker('serv-nano', {
      now: clock.now,
      minSamples: 3,
      tripP90LatencyMs: 10_000,
      cooldownMs: 30_000,
      probeMaxLatencyMs: 5_000,
    });
    for (let i = 0; i < 3; i++) {
      success(cb, 20_000);
      clock.advance(100);
    }
    expect(cb.snapshot().state).toBe('OPEN');
    clock.advance(31_000);
    const probe = cb.admit();
    const res = cb.recordOutcome(probe.token, { ok: true, netLatencyMs: 12_000 });
    const snap = cb.snapshot();
    expect(snap.state).toBe('OPEN');
    expect(snap.lastTripReason).toContain('probe succeeded but latency');
    const transitions = res.events.filter(
      (e): e is CircuitTransitionEvent => e.kind === 'half_open_to_open',
    );
    expect(transitions).toHaveLength(1);
    const first = transitions[0]!;
    if (first.kind === 'half_open_to_open') {
      expect(first.reason).toBe('probe_slow');
    }
  });

  it('rolls samples out of the window by count', () => {
    const clock = makeClock();
    const cb = new CircuitBreaker('serv-nano', {
      now: clock.now,
      minSamples: 3,
      windowSize: 5,
      tripFailureRate: 0.9,
    });
    for (let i = 0; i < 8; i++) {
      success(cb, 500);
      clock.advance(100);
    }
    expect(cb.snapshot().state).toBe('CLOSED');
    expect(cb.snapshot().sampleCount).toBe(5);
    for (let i = 0; i < 5; i++) {
      failure(cb, 500);
      clock.advance(100);
    }
    expect(cb.snapshot().state).toBe('OPEN');
    expect(cb.snapshot().sampleCount).toBe(5);
  });

  it('rolls samples out of the window by age (windowAgeMs)', () => {
    const clock = makeClock();
    const cb = new CircuitBreaker('serv-nano', {
      now: clock.now,
      minSamples: 5,
      windowSize: 100,
      windowAgeMs: 60_000,
      tripFailureRate: 0.99,
    });
    for (let i = 0; i < 4; i++) {
      failure(cb, 500);
    }
    clock.advance(61_000);
    success(cb, 500);
    success(cb, 500);
    const snap = cb.snapshot();
    expect(snap.state).toBe('CLOSED');
    expect(snap.sampleCount).toBe(2);
    expect(snap.failureRate).toBe(0);
  });
});

// -----------------------------------------------------------------------------
// v0.4.3.1 §E new tests (T1-T4, T13-T17, T24, T25, T27)
// -----------------------------------------------------------------------------

describe('CircuitBreaker — token identity & stale results', () => {
  it('T1: single-flight — second admit while probe in flight throws CircuitOpenError', () => {
    const clock = makeClock();
    const cb = new CircuitBreaker('serv-nano', {
      now: clock.now,
      minSamples: 3,
      tripFailureRate: 0.5,
      cooldownMs: 30_000,
    });
    for (let i = 0; i < 3; i++) failure(cb, 500);
    clock.advance(31_000);
    const first = cb.admit();
    expect(first.kind).toBe('probe');
    expect(() => cb.admit()).toThrow(CircuitOpenError);
  });

  it('T2: duplicate probe token → already_consumed (not wrong_state)', () => {
    const clock = makeClock();
    const cb = new CircuitBreaker('serv-nano', {
      now: clock.now,
      minSamples: 3,
      tripFailureRate: 0.5,
      cooldownMs: 30_000,
    });
    for (let i = 0; i < 3; i++) failure(cb, 500);
    clock.advance(31_000);
    const probe = cb.admit();
    cb.recordOutcome(probe.token, { ok: true, netLatencyMs: 500 });
    // Now CLOSED; re-using the probe token
    const dup = cb.recordOutcome(probe.token, { ok: true, netLatencyMs: 500 });
    expect(dup.accepted).toBe(false);
    const stales = dup.events.filter(
      (e): e is CircuitStaleResultEvent => e.kind === 'stale_result',
    );
    expect(stales).toHaveLength(1);
    expect(stales[0]!.reason).toBe('already_consumed');
  });

  it('T3: late normal token outcome delivered while OPEN → wrong_state', () => {
    const clock = makeClock();
    const cb = new CircuitBreaker('serv-nano', {
      now: clock.now,
      minSamples: 3,
      tripFailureRate: 0.5,
    });
    // Admit CLOSED normal token
    const adm = cb.admit();
    expect(adm.kind).toBe('normal');
    // Trip via three additional failures
    for (let i = 0; i < 3; i++) failure(cb, 500);
    expect(cb.snapshot().state).toBe('OPEN');
    // Late normal-token outcome
    const late = cb.recordOutcome(adm.token, { ok: true, netLatencyMs: 500 });
    expect(late.accepted).toBe(false);
    const stales = late.events.filter(
      (e): e is CircuitStaleResultEvent => e.kind === 'stale_result',
    );
    expect(stales).toHaveLength(1);
    expect(stales[0]!.reason).toBe('wrong_state');
  });

  it('T4: transition events are exactly-once (closed_to_open on the tripping outcome only)', () => {
    const clock = makeClock();
    const cb = new CircuitBreaker('serv-nano', {
      now: clock.now,
      minSamples: 3,
      tripFailureRate: 0.5,
    });
    const events: CircuitTransitionEvent[] = [];
    for (let i = 0; i < 3; i++) {
      const res = failure(cb, 500);
      for (const e of res.events) {
        if (
          e.kind === 'closed_to_open' ||
          e.kind === 'open_to_half_open' ||
          e.kind === 'half_open_to_closed' ||
          e.kind === 'half_open_to_open'
        ) {
          events.push(e);
        }
      }
    }
    const trips = events.filter((e) => e.kind === 'closed_to_open');
    expect(trips).toHaveLength(1);
  });

  it('T15: consuming a token twice reports already_consumed', () => {
    const cb = new CircuitBreaker('serv-nano', { minSamples: 100 });
    const adm = cb.admit();
    cb.recordOutcome(adm.token, { ok: true, netLatencyMs: 100 });
    const again = cb.recordOutcome(adm.token, { ok: true, netLatencyMs: 100 });
    expect(again.accepted).toBe(false);
    const stales = again.events.filter(
      (e): e is CircuitStaleResultEvent => e.kind === 'stale_result',
    );
    expect(stales[0]!.reason).toBe('already_consumed');
  });

  it('T16: cross-breaker token → invalid_token on the other breaker', () => {
    const a = new CircuitBreaker('a', { minSamples: 100 });
    const b = new CircuitBreaker('b', { minSamples: 100 });
    const admA = a.admit();
    const cross = b.recordOutcome(admA.token, { ok: true, netLatencyMs: 100 });
    expect(cross.accepted).toBe(false);
    const stales = cross.events.filter(
      (e): e is CircuitStaleResultEvent => e.kind === 'stale_result',
    );
    expect(stales[0]!.reason).toBe('invalid_token');
    // Original breaker's token was never consumed by the forgery
    const legit = a.recordOutcome(admA.token, { ok: true, netLatencyMs: 100 });
    expect(legit.accepted).toBe(true);
  });

  it('T17: plain-object forgery of a token is rejected with invalid_token', () => {
    const cb = new CircuitBreaker('serv-nano', { minSamples: 100 });
    const forged: NormalAdmissionToken = Object.freeze({
      kind: 'normal',
      admissionSequence: 1,
      closedEpoch: 0,
      stateRevision: 0,
    });
    const res = cb.recordOutcome(forged as CircuitAdmissionToken, {
      ok: true,
      netLatencyMs: 100,
    });
    expect(res.accepted).toBe(false);
    const stales = res.events.filter(
      (e): e is CircuitStaleResultEvent => e.kind === 'stale_result',
    );
    expect(stales[0]!.reason).toBe('invalid_token');
  });

  it('T24: invalid latency (NaN / Infinity / negative) coerces outcome to failure with invalid_outcome event', () => {
    const cb1 = new CircuitBreaker('cb1', { minSamples: 100 });
    const r1 = cb1.recordOutcome(cb1.admit().token, {
      ok: true,
      netLatencyMs: NaN,
    });
    expect(r1.accepted).toBe(true);
    const inv1 = r1.events.filter(
      (e): e is CircuitInvalidOutcomeEvent => e.kind === 'invalid_outcome',
    );
    expect(inv1[0]!.reason).toBe('nan_latency');

    const cb2 = new CircuitBreaker('cb2', { minSamples: 100 });
    const r2 = cb2.recordOutcome(cb2.admit().token, {
      ok: true,
      netLatencyMs: Infinity,
    });
    const inv2 = r2.events.filter(
      (e): e is CircuitInvalidOutcomeEvent => e.kind === 'invalid_outcome',
    );
    expect(inv2[0]!.reason).toBe('infinite_latency');

    const cb3 = new CircuitBreaker('cb3', { minSamples: 100 });
    const r3 = cb3.recordOutcome(cb3.admit().token, {
      ok: true,
      netLatencyMs: -5,
    });
    const inv3 = r3.events.filter(
      (e): e is CircuitInvalidOutcomeEvent => e.kind === 'invalid_outcome',
    );
    expect(inv3[0]!.reason).toBe('negative_latency');
    // And the sample must land as a FAILURE at latency=0
    const snap = cb3.snapshot();
    expect(snap.sampleCount).toBe(1);
    expect(snap.failureRate).toBe(1);
  });

  it('T25: epoch reset — HALF_OPEN→CLOSED clears recoveryEpoch to 0 and bumps closedEpoch', () => {
    const clock = makeClock();
    const cb = new CircuitBreaker('serv-nano', {
      now: clock.now,
      minSamples: 3,
      tripFailureRate: 0.5,
      cooldownMs: 30_000,
      probeMaxLatencyMs: 5_000,
    });
    for (let i = 0; i < 3; i++) failure(cb, 500);
    clock.advance(31_000);
    // Fail the first probe → recoveryEpoch bumps to 1 (still tripGen 1)
    let probe = cb.admit() as { token: ProbeAdmissionToken; kind: 'probe' };
    cb.recordOutcome(probe.token, { ok: false, netLatencyMs: 2_000 });
    expect(cb.snapshot().recoveryEpoch).toBe(1);
    expect(cb.snapshot().tripGeneration).toBe(1);
    // Retry cooldown → probe succeeds → CLOSED with closedEpoch bump and recoveryEpoch=0
    clock.advance(31_000);
    probe = cb.admit() as { token: ProbeAdmissionToken; kind: 'probe' };
    cb.recordOutcome(probe.token, { ok: true, netLatencyMs: 1_000 });
    const snap = cb.snapshot();
    expect(snap.state).toBe('CLOSED');
    expect(snap.closedEpoch).toBe(1);
    expect(snap.recoveryEpoch).toBe(0);
    // tripGeneration remains 1 (we did not trip again)
    expect(snap.tripGeneration).toBe(1);
  });

  it('T27: stale normal token from a previous CLOSED epoch → wrong_epoch', () => {
    const clock = makeClock();
    const cb = new CircuitBreaker('serv-nano', {
      now: clock.now,
      minSamples: 3,
      tripFailureRate: 0.5,
      cooldownMs: 30_000,
      probeMaxLatencyMs: 5_000,
    });
    // Admit a CLOSED normal token but delay its outcome.
    const stale = cb.admit();
    expect(stale.kind).toBe('normal');
    // Force a trip and a full recovery so we are back in CLOSED, but on a new closedEpoch.
    for (let i = 0; i < 3; i++) failure(cb, 500);
    expect(cb.snapshot().state).toBe('OPEN');
    clock.advance(31_000);
    const probe = cb.admit();
    cb.recordOutcome(probe.token, { ok: true, netLatencyMs: 500 });
    expect(cb.snapshot().state).toBe('CLOSED');
    expect(cb.snapshot().closedEpoch).toBe(1);
    // Now deliver the stale normal-token outcome — state is CLOSED but epoch mismatches.
    const late = cb.recordOutcome(stale.token, { ok: true, netLatencyMs: 500 });
    expect(late.accepted).toBe(false);
    const stales = late.events.filter(
      (e): e is CircuitStaleResultEvent => e.kind === 'stale_result',
    );
    expect(stales[0]!.reason).toBe('wrong_epoch');
  });

  it('T13: policy fingerprint — snapshot exposes epochs and stateRevision', () => {
    const cb = new CircuitBreaker('serv-nano', { minSamples: 100 });
    const s0 = cb.snapshot();
    expect(s0.closedEpoch).toBe(0);
    expect(s0.tripGeneration).toBe(0);
    expect(s0.recoveryEpoch).toBe(0);
    expect(s0.probeSequence).toBe(0);
    // stateRevision starts at 0 and advances monotonically on transitions.
    const before = s0.stateRevision;
    // No transition on a healthy sample
    success(cb, 100);
    expect(cb.snapshot().stateRevision).toBe(before);
  });
});
