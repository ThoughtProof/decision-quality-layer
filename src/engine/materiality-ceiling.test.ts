import { describe, expect, it } from 'vitest';
import { applyMaterialityCeiling } from './index.js';
import type { AggregateResult } from '../types.js';

const allow: AggregateResult = {
  verdict: 'ALLOW',
  confidence: 0.8,
  triggered_by: [],
  rationale: 'All evaluated axes pass.',
};

const review: AggregateResult = {
  verdict: 'REVIEW',
  confidence: 0.9,
  triggered_by: ['reversibility'],
  rationale: 'Human confirmation required.',
};

const block: AggregateResult = {
  verdict: 'BLOCK',
  confidence: 0.95,
  triggered_by: ['intent'],
  rationale: 'Blocked.',
};

describe('applyMaterialityCeiling (principal autonomy bound)', () => {
  it('ALLOW → REVIEW when amount >= ceiling', () => {
    const out = applyMaterialityCeiling(allow, {
      granted: { materiality_ceiling: 2000 },
      proposed: { amount: 2000 },
    });
    expect(out.verdict).toBe('REVIEW');
    expect(out.rationale).toMatch(/Materiality ceiling exceeded/);
    expect(out.rationale).toMatch(/2000/);
  });

  it('ALLOW stays ALLOW when amount < ceiling', () => {
    const out = applyMaterialityCeiling(allow, {
      granted: { materiality_ceiling: 2000 },
      proposed: { amount: 1999.99 },
    });
    expect(out).toEqual(allow);
  });

  it('is independent of history — no carve-outs by recurrence label', () => {
    // Same rule for "payroll-like" large amount: ceiling still applies.
    const out = applyMaterialityCeiling(allow, {
      granted: { materiality_ceiling: 2000 },
      proposed: { amount: 3200 },
      history: { past_payments_to_same_counterparty: 18, amount_variance_from_history: 0.02 },
    });
    expect(out.verdict).toBe('REVIEW');
  });

  it('silent when ceiling missing (fail toward silence)', () => {
    const out = applyMaterialityCeiling(allow, {
      proposed: { amount: 5000 },
    });
    expect(out).toEqual(allow);
  });

  it('silent when amount missing', () => {
    const out = applyMaterialityCeiling(allow, {
      granted: { materiality_ceiling: 2000 },
    });
    expect(out).toEqual(allow);
  });

  it('never weakens BLOCK or REVIEW', () => {
    expect(
      applyMaterialityCeiling(block, {
        granted: { materiality_ceiling: 2000 },
        proposed: { amount: 5000 },
      }),
    ).toEqual(block);
    expect(
      applyMaterialityCeiling(review, {
        granted: { materiality_ceiling: 2000 },
        proposed: { amount: 5000 },
      }),
    ).toEqual(review);
  });

  it('distinct from max_amount — authorization bound alone does not escalate', () => {
    // max_amount without materiality_ceiling must not trigger this path.
    const out = applyMaterialityCeiling(allow, {
      granted: { max_amount: 100 },
      proposed: { amount: 50 },
    });
    expect(out).toEqual(allow);
  });
});
