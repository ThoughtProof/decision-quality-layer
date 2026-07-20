import { describe, it, expect, beforeEach } from 'vitest';
import {
  buildStructuralShadowSample,
  recordStructuralSample,
  getStructuralMetricsSnapshot,
  _resetStructuralMetricsForTests,
} from './structural-metrics.js';
import type { AxisResult, StructuralField } from '../types.js';

beforeEach(() => {
  _resetStructuralMetricsForTests();
});

function scope(verdict: AxisResult['verdict'], confidence = 0.9): AxisResult {
  return {
    axis: 'scope',
    verdict,
    confidence,
    reasoning: 't',
    objection: verdict === 'FAIL' ? 'over' : '',
  };
}

const baseStructural = (over: Partial<StructuralField> = {}): StructuralField => ({
  mode: 'shadow',
  would_block: false,
  enforced: false,
  silent: false,
  violations: [],
  ...over,
});

describe('buildStructuralShadowSample', () => {
  it('silent when structural is silent', () => {
    const s = buildStructuralShadowSample({
      requestId: 'r1',
      structural: baseStructural({ silent: true }),
      axes: [scope('PASS')],
      aggregateVerdict: 'ALLOW',
      sandbox: true,
    });
    expect(s.agreement).toBe('silent');
  });

  it('both_block when would_block and scope FAIL', () => {
    const s = buildStructuralShadowSample({
      requestId: 'r2',
      structural: baseStructural({
        would_block: true,
        violations: [{ kind: 'amount_overshoot', detail: 'x' }],
      }),
      axes: [scope('FAIL', 0.95)],
      aggregateVerdict: 'BLOCK',
      sandbox: false,
    });
    expect(s.agreement).toBe('both_block');
    expect(s.violation_kinds).toEqual(['amount_overshoot']);
  });

  it('structural_only when would_block but scope PASS', () => {
    const s = buildStructuralShadowSample({
      requestId: 'r3',
      structural: baseStructural({ would_block: true }),
      axes: [scope('PASS')],
      aggregateVerdict: 'ALLOW',
      sandbox: true,
    });
    expect(s.agreement).toBe('structural_only');
  });

  it('cascade_only when scope FAIL but structural clean', () => {
    const s = buildStructuralShadowSample({
      requestId: 'r4',
      structural: baseStructural({ would_block: false }),
      axes: [scope('FAIL')],
      aggregateVerdict: 'BLOCK',
      sandbox: false,
    });
    expect(s.agreement).toBe('cascade_only');
  });

  it('neither when both clean', () => {
    const s = buildStructuralShadowSample({
      requestId: 'r5',
      structural: baseStructural(),
      axes: [scope('PASS')],
      aggregateVerdict: 'ALLOW',
      sandbox: true,
    });
    expect(s.agreement).toBe('neither');
  });

  it('enforced_short_circuit when enforced', () => {
    const s = buildStructuralShadowSample({
      requestId: 'r6',
      structural: baseStructural({
        mode: 'enforce',
        would_block: true,
        enforced: true,
        violations: [{ kind: 'recipient_mismatch', detail: 'x' }],
      }),
      axes: [
        {
          axis: 'scope',
          verdict: 'FAIL',
          confidence: 1,
          reasoning: 'structural',
          objection: 'x',
        },
      ],
      aggregateVerdict: 'BLOCK',
      sandbox: true,
    });
    expect(s.agreement).toBe('enforced_short_circuit');
  });

  it('no_scope_axis when scope missing from axes', () => {
    const s = buildStructuralShadowSample({
      requestId: 'r7',
      structural: baseStructural({ would_block: true }),
      axes: [
        {
          axis: 'intent',
          verdict: 'PASS',
          confidence: 0.9,
          reasoning: 'ok',
          objection: '',
        },
      ],
      aggregateVerdict: 'ALLOW',
      sandbox: true,
    });
    expect(s.agreement).toBe('no_scope_axis');
    expect(s.scope_verdict).toBeNull();
  });
});

describe('recordStructuralSample / snapshot', () => {
  it('accumulates process-local counters', () => {
    const a = buildStructuralShadowSample({
      requestId: 'a',
      structural: baseStructural({
        would_block: true,
        violations: [{ kind: 'amount_overshoot', detail: 'x' }],
      }),
      axes: [scope('FAIL')],
      aggregateVerdict: 'BLOCK',
      sandbox: false,
    });
    const b = buildStructuralShadowSample({
      requestId: 'b',
      structural: baseStructural({ silent: true }),
      axes: [scope('PASS')],
      aggregateVerdict: 'ALLOW',
      sandbox: true,
    });
    recordStructuralSample(a);
    recordStructuralSample(b);

    const snap = getStructuralMetricsSnapshot();
    expect(snap.process_local).toBe(true);
    expect(snap.total).toBe(2);
    expect(snap.with_structure).toBe(1);
    expect(snap.would_block).toBe(1);
    expect(snap.scope_fail).toBe(1);
    expect(snap.agreement.both_block).toBe(1);
    expect(snap.agreement.silent).toBe(1);
    expect(snap.violation_kinds.amount_overshoot).toBe(1);
  });
});
