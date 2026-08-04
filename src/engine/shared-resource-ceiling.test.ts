import { describe, expect, it } from 'vitest';
import { applySharedResourceCeiling } from './index.js';
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

describe('applySharedResourceCeiling (non-monetary blast radius)', () => {
  it('ALLOW → REVIEW when shared_resource_fraction >= ceiling', () => {
    const out = applySharedResourceCeiling(allow, {
      granted: { shared_resource_fraction_ceiling: 0.25 },
      proposed: { shared_resource_fraction: 0.4 },
    });
    expect(out.verdict).toBe('REVIEW');
    expect(out.rationale).toMatch(/Shared-resource fraction ceiling exceeded/);
    expect(out.rationale).toMatch(/Budget-available ≠ reversible|Budget-available/);
  });

  it('ALLOW stays ALLOW when fraction < ceiling', () => {
    const out = applySharedResourceCeiling(allow, {
      granted: { shared_resource_fraction_ceiling: 0.25 },
      proposed: { shared_resource_fraction: 0.1 },
    });
    expect(out).toEqual(allow);
  });

  it('is independent of money amount — €0 cash still escalates on quota blast', () => {
    const out = applySharedResourceCeiling(allow, {
      granted: { shared_resource_fraction_ceiling: 0.25, materiality_ceiling: 2000 },
      proposed: { shared_resource_fraction: 0.4, amount: 0 },
    });
    expect(out.verdict).toBe('REVIEW');
  });

  it('silent when ceiling or fraction missing', () => {
    expect(
      applySharedResourceCeiling(allow, {
        proposed: { shared_resource_fraction: 0.9 },
      }),
    ).toEqual(allow);
    expect(
      applySharedResourceCeiling(allow, {
        granted: { shared_resource_fraction_ceiling: 0.25 },
      }),
    ).toEqual(allow);
  });

  it('never weakens REVIEW', () => {
    expect(
      applySharedResourceCeiling(review, {
        granted: { shared_resource_fraction_ceiling: 0.25 },
        proposed: { shared_resource_fraction: 0.9 },
      }),
    ).toEqual(review);
  });

  it('no case-name carve-out — principle is shared finite resource fraction only', () => {
    // Field names are generic; no api-quota / provider-specific keys required.
    const out = applySharedResourceCeiling(allow, {
      granted: { shared_resource_fraction_ceiling: 0.2 },
      proposed: { shared_resource_fraction: 0.2 },
    });
    expect(out.verdict).toBe('REVIEW');
    expect(out.rationale.toLowerCase()).not.toMatch(/api-quota|enrich|leads/);
  });
});
