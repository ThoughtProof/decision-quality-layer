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

const UNVERIFIED_STUB_RE =
  /numeric claims? without bound evidence|\[objection_unverified\]/i;

/** Live BLOCK family: Sony ZV-E10 $848 vs $700 (receipt dql_msz25pfd_du7vbv). */
const SONY_CTX = {
  mandate: 'Buy a compact camera. Hard max $700.',
  proposed_action: 'Buy the Sony ZV-E10 at $848 from the retailer cart.',
  reasoning: 'Best image quality in the shortlist.',
};

function mcpObjections(axes: AxisResult[]): string[] {
  return axes.map((a) => (a.objection ?? '').trim()).filter(Boolean);
}

describe('boundTotals — free-text proposed_action money', () => {
  it('binds $848 from proposed_action + $700 max from mandate', () => {
    const b = boundTotals(SONY_CTX);
    expect(b.amount).toBe(848);
    expect(b.ceiling).toBe(700);
  });

  it('does not treat model numbers like A6400 as an amount', () => {
    const b = boundTotals({
      mandate: 'Buy a Sony camera. Max $700.',
      proposed_action: 'Buy the Sony A6400 for $848.',
    });
    expect(b.amount).toBe(848);
    expect(b.ceiling).toBe(700);
  });
});

describe('bindObjectionText — Sony-class free-text bounds', () => {
  it('verifies exceed when the proposed_action dollar is the bound amount', () => {
    const r = bindObjectionText('The $848 price exceeds the $700 budget.', SONY_CTX);
    expect(r.status).toBe('verified');
    expect(r.surface).toBe('pass_through');
    expect(r.safe_reason).not.toMatch(UNVERIFIED_STUB_RE);
  });
});

describe('bindAxisResults', () => {
  it('does not append the unverified stub next to a real budget-mismatch FAIL', () => {
    const axes: AxisResult[] = [
      {
        axis: 'scope',
        verdict: 'FAIL',
        confidence: 0.95,
        reasoning: 'Proposed $848 is above the $700 mandate ceiling.',
        objection: 'budget mismatch ($848 vs $700 max)',
      },
      {
        axis: 'risk',
        verdict: 'FAIL',
        confidence: 0.8,
        reasoning: 'Price is $848 with no structured evidence row.',
        objection: 'price is $848',
      },
      {
        axis: 'intent',
        verdict: 'PASS',
        confidence: 0.9,
        reasoning: 'Action matches the camera purchase mandate.',
        objection: '',
      },
    ];
    const b = bindAxisResults(axes, SONY_CTX);
    const scope = b.surface_axes.find((a) => a.axis === 'scope')!;
    const risk = b.surface_axes.find((a) => a.axis === 'risk')!;
    expect(scope.verdict).toBe('FAIL');
    expect(risk.verdict).toBe('FAIL');
    expect(scope.objection).toBe('budget mismatch ($848 vs $700 max)');
    expect(scope.objection).not.toMatch(UNVERIFIED_STUB_RE);
    expect(risk.objection).not.toMatch(UNVERIFIED_STUB_RE);
    expect(scope.reasoning).not.toMatch(UNVERIFIED_STUB_RE);
    expect(risk.reasoning).not.toMatch(UNVERIFIED_STUB_RE);

    const objections = mcpObjections(b.surface_axes);
    expect(objections).toContain('budget mismatch ($848 vs $700 max)');
    expect(objections.join('\n')).not.toMatch(UNVERIFIED_STUB_RE);
  });

  it('keeps the unverified stub when it is the only FAIL surface (fail-closed)', () => {
    const axes: AxisResult[] = [
      {
        axis: 'scope',
        verdict: 'FAIL',
        confidence: 0.9,
        reasoning: 'Amount exceeds budget.',
        objection: 'Total exceeds budget ceiling.',
      },
      {
        axis: 'intent',
        verdict: 'PASS',
        confidence: 0.8,
        reasoning: 'Goal matches.',
        objection: '',
      },
    ];
    const b = bindAxisResults(axes, {
      mandate: 'Do something useful.',
      proposed_action: 'Proceed with the plan.',
    });
    expect(b.surface_axes[0]!.verdict).toBe('FAIL');
    expect(b.surface_axes[0]!.objection).toMatch(UNVERIFIED_STUB_RE);
  });

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
    expect(b.surface_axes.length).toBeGreaterThanOrEqual(2);
    const surface0 = b.surface_axes[0]!;
    const surface1 = b.surface_axes[1]!;
    expect(surface0.verdict).toBe('FAIL'); // unchanged
    expect(surface0.objection).toMatch(/objection_evidence_fail/);
    expect(surface0.reasoning).toMatch(/objection_evidence_fail/);
    expect(surface1.reasoning).toBe('Action matches stated mandate.');
    expect(b.codes).toContain('numeric_exceed_false');
  });
});
