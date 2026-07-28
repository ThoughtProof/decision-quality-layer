/**
 * DQL objection evidence bind — unit tests.
 * Paris class: 583 ≤ 600 + "exceeds budget" → strip.
 */
import { describe, it, expect } from 'vitest';
import {
  boundTotals,
  parseNumericClaim,
  bindObjectionText,
  bindAxisResults,
} from './objection-evidence-bind.js';
import type { AxisResult } from './types.js';

describe('parseNumericClaim', () => {
  it('detects exceed relation', () => {
    const c = parseNumericClaim('Total exceeds budget ceiling.');
    expect(c.is_numericish).toBe(true);
    expect(c.relation).toBe('exceed');
  });

  it('leaves non-numeric alone', () => {
    const c = parseNumericClaim('Goal drift toward adjacent objective.');
    expect(c.is_numericish).toBe(false);
  });
});

describe('boundTotals (DQL structured_context)', () => {
  it('reads proposed.amount + granted.max_amount', () => {
    const b = boundTotals({
      structured_context: {
        granted: { max_amount: 600 },
        proposed: { amount: 583 },
      },
    });
    expect(b.amount).toBe(583);
    expect(b.ceiling).toBe(600);
  });

  it('sums flight+hotel from context JSON', () => {
    const b = boundTotals({
      context: JSON.stringify({
        flight: 268,
        hotel: 315,
        budget_ceiling: 600,
      }),
    });
    expect(b.amount).toBe(583);
    expect(b.ceiling).toBe(600);
  });
});

describe('bindObjectionText — Paris class', () => {
  const ctx = {
    structured_context: {
      granted: { max_amount: 600 },
      proposed: { amount: 583 },
    },
  };

  it('strips fabricated exceed when 583 <= 600', () => {
    const r = bindObjectionText('Total exceeds budget ceiling.', ctx);
    expect(r.status).toBe('objection_evidence_fail');
    expect(r.surface).toBe('strip_reason');
    expect(r.log_code).toBe('numeric_exceed_false');
    expect(r.detail).toMatchObject({
      computed_amount: 583,
      computed_ceiling: 600,
      actually_exceeds: false,
    });
  });

  it('passes true exceed', () => {
    const r = bindObjectionText('Total exceeds budget ceiling.', {
      structured_context: {
        granted: { max_amount: 600 },
        proposed: { amount: 750 },
      },
    });
    expect(r.status).toBe('verified');
    expect(r.surface).toBe('pass_through');
  });
});

describe('bindAxisResults', () => {
  it('binds objection + reasoning; leaves verdict untouched', () => {
    const axes: AxisResult[] = [
      {
        axis: 'scope',
        verdict: 'FAIL',
        confidence: 0.9,
        reasoning: 'Total exceeds budget ceiling.',
        objection: 'Total exceeds budget ceiling.',
      },
      {
        axis: 'intent',
        verdict: 'PASS',
        confidence: 0.8,
        reasoning: 'Action matches stated mandate.',
        objection: '',
      },
    ];
    const b = bindAxisResults(axes, {
      structured_context: {
        granted: { max_amount: 600 },
        proposed: { amount: 583 },
      },
    });
    expect(b.surface_gated).toBe(true);
    expect(b.n_evidence_fail).toBeGreaterThanOrEqual(1);
    expect(b.surface_axes[0].verdict).toBe('FAIL'); // unchanged
    expect(b.surface_axes[0].objection).toMatch(/objection_evidence_fail/);
    expect(b.surface_axes[0].reasoning).toMatch(/objection_evidence_fail/);
    expect(b.surface_axes[1].reasoning).toBe('Action matches stated mandate.');
    expect(b.codes).toContain('numeric_exceed_false');
  });
});
