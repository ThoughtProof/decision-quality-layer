import { describe, it, expect } from 'vitest';
import {
  runStructuralPrecheck,
  toStructuralField,
  type DqlStructuredContext,
} from './structural-precheck.js';

describe('runStructuralPrecheck', () => {
  it('is silent with no structured context', () => {
    const r = runStructuralPrecheck(undefined, 'shadow');
    expect(r.silent).toBe(true);
    expect(r.would_block).toBe(false);
    expect(r.enforced).toBe(false);
    expect(r.violations).toEqual([]);
  });

  it('is silent with empty objects', () => {
    const r = runStructuralPrecheck({ granted: {}, proposed: {} }, 'enforce');
    expect(r.silent).toBe(true);
    expect(r.would_block).toBe(false);
    expect(r.enforced).toBe(false);
  });

  it('is silent when only one side of amount pair is present', () => {
    const r = runStructuralPrecheck(
      { granted: { max_amount: 100 }, proposed: {} },
      'enforce',
    );
    expect(r.would_block).toBe(false);
    expect(r.silent).toBe(false); // had fields, just incomplete pairs
  });

  it('detects amount overshoot deterministically', () => {
    const ctx: DqlStructuredContext = {
      granted: { max_amount: 200, amount_currency: 'EUR' },
      proposed: { amount: 2000, amount_currency: 'EUR' },
    };
    const r = runStructuralPrecheck(ctx, 'shadow');
    expect(r.would_block).toBe(true);
    expect(r.enforced).toBe(false);
    expect(r.violations.map((v) => v.kind)).toEqual(['amount_overshoot']);
  });

  it('allows amount within 0.5% tolerance', () => {
    const r = runStructuralPrecheck(
      {
        granted: { max_amount: 100 },
        proposed: { amount: 100.4 }, // 0.4% over
      },
      'enforce',
    );
    expect(r.would_block).toBe(false);
  });

  it('blocks amount just beyond tolerance', () => {
    const r = runStructuralPrecheck(
      {
        granted: { max_amount: 100 },
        proposed: { amount: 100.6 }, // 0.6% over
      },
      'enforce',
    );
    expect(r.would_block).toBe(true);
    expect(r.enforced).toBe(true);
  });

  it('stays silent on amount when currencies disagree (no FX)', () => {
    const r = runStructuralPrecheck(
      {
        granted: { max_amount: 100, amount_currency: 'EUR' },
        proposed: { amount: 10_000, amount_currency: 'USD' },
      },
      'enforce',
    );
    expect(r.would_block).toBe(false);
    expect(r.violations).toEqual([]);
  });

  it('Probe 1 — silent on one-sided currency (asymmetry is unknown unit, not same)', () => {
    // granted EUR + proposed bare amount must NOT hard-block (false-block risk).
    const r = runStructuralPrecheck(
      {
        granted: { max_amount: 100, amount_currency: 'EUR' },
        proposed: { amount: 1000 },
      },
      'enforce',
    );
    expect(r.would_block).toBe(false);
    expect(r.violations.filter((v) => v.kind === 'amount_overshoot')).toEqual([]);
  });

  it('Probe 1b — silent when only proposed has currency', () => {
    const r = runStructuralPrecheck(
      {
        granted: { max_amount: 100 },
        proposed: { amount: 1000, amount_currency: 'USD' },
      },
      'enforce',
    );
    expect(r.would_block).toBe(false);
  });

  it('compares amounts when both currencies unset (implicit same unit)', () => {
    const r = runStructuralPrecheck(
      {
        granted: { max_amount: 100 },
        proposed: { amount: 1000 },
      },
      'enforce',
    );
    expect(r.would_block).toBe(true);
    expect(r.violations[0]?.kind).toBe('amount_overshoot');
  });

  it('detects recipient mismatch (case-insensitive)', () => {
    const r = runStructuralPrecheck(
      {
        granted: { recipient: 'Anna Müller' },
        proposed: { recipient: 'evil-payee.eth' },
      },
      'enforce',
    );
    expect(r.would_block).toBe(true);
    expect(r.violations[0]?.kind).toBe('recipient_mismatch');
  });

  it('accepts matching recipients ignoring case/space', () => {
    const r = runStructuralPrecheck(
      {
        granted: { recipient: '  Alice  ' },
        proposed: { recipient: 'alice' },
      },
      'enforce',
    );
    expect(r.violations.filter((v) => v.kind === 'recipient_mismatch')).toEqual([]);
  });

  it('detects IBAN mismatch ignoring spaces', () => {
    const r = runStructuralPrecheck(
      {
        granted: { iban: 'DE89 3704 0044 0532 0130 00' },
        proposed: { iban: 'DE89370400440532013001' },
      },
      'shadow',
    );
    expect(r.would_block).toBe(true);
    expect(r.violations[0]?.kind).toBe('iban_mismatch');
  });

  it('detects unlimited approval without grant', () => {
    const r = runStructuralPrecheck(
      {
        proposed: { allowance: 'MAX_UINT256' },
      },
      'enforce',
    );
    expect(r.would_block).toBe(true);
    expect(r.enforced).toBe(true);
    expect(r.violations[0]?.kind).toBe('unlimited_approval');
  });

  it('allows unlimited when explicitly granted', () => {
    const r = runStructuralPrecheck(
      {
        granted: { allow_unlimited: true },
        proposed: { allowance: 'unlimited' },
      },
      'enforce',
    );
    expect(r.would_block).toBe(false);
  });

  it('history variance: silent below min count even if variance high', () => {
    const r = runStructuralPrecheck(
      {
        history: {
          past_payments_to_same_counterparty: 2,
          amount_variance_from_history: 0.9,
        },
      },
      'enforce',
    );
    expect(r.would_block).toBe(false);
  });

  it('history variance: silent when variance within hard band', () => {
    const r = runStructuralPrecheck(
      {
        history: {
          past_payments_to_same_counterparty: 18,
          amount_variance_from_history: 0.05,
        },
      },
      'enforce',
    );
    expect(r.would_block).toBe(false);
  });

  it('history variance: blocks clear break on established counterparty', () => {
    const r = runStructuralPrecheck(
      {
        history: {
          past_payments_to_same_counterparty: 18,
          amount_variance_from_history: 0.45,
        },
      },
      'shadow',
    );
    expect(r.would_block).toBe(true);
    expect(r.enforced).toBe(false);
    expect(r.violations[0]?.kind).toBe('history_variance_break');
  });

  it('never throws on garbage nested shapes (fail silent)', () => {
    const r = runStructuralPrecheck(
      // cast: runtime resilience if a caller bypasses validation
      { granted: { max_amount: Number.NaN } } as DqlStructuredContext,
      'enforce',
    );
    expect(r.would_block).toBe(false);
  });

  it('toStructuralField mirrors public shape', () => {
    const r = runStructuralPrecheck(
      {
        granted: { max_amount: 10 },
        proposed: { amount: 100 },
      },
      'shadow',
    );
    const f = toStructuralField(r);
    expect(f.mode).toBe('shadow');
    expect(f.would_block).toBe(true);
    expect(f.enforced).toBe(false);
    expect(f.violations).toHaveLength(1);
  });
});
