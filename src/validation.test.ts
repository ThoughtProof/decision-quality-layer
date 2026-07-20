import { describe, it, expect } from 'vitest';
import { validateVerifyRequest } from './validation.js';

const good = {
  mandate: 'Swap 100 USDC to ETH',
  proposed_action: 'Approve USDC spend of 100 for Uniswap router',
  reasoning: 'User asked for USDC→ETH swap; exact-amount approval is minimum permission',
};

describe('validateVerifyRequest', () => {
  it('accepts a minimal valid request', () => {
    const r = validateVerifyRequest(good);
    expect(r.valid).toBe(true);
    if (r.valid) {
      expect(r.request.axes).toEqual(['intent', 'scope', 'risk', 'consistency', 'reversibility']);
      expect(r.request.sandbox).toBe(false);
    }
  });

  it('rejects non-object body', () => {
    const r = validateVerifyRequest('nope');
    expect(r.valid).toBe(false);
  });

  it('rejects when required fields missing', () => {
    const r = validateVerifyRequest({ mandate: 'x' });
    expect(r.valid).toBe(false);
    if (!r.valid) {
      expect(r.errors.some((e) => e.includes('proposed_action'))).toBe(true);
      expect(r.errors.some((e) => e.includes('reasoning'))).toBe(true);
    }
  });

  it('rejects empty strings in required fields', () => {
    const r = validateVerifyRequest({ ...good, mandate: '' });
    expect(r.valid).toBe(false);
  });

  it('accepts a subset of axes', () => {
    const r = validateVerifyRequest({ ...good, axes: ['intent', 'scope'] });
    expect(r.valid).toBe(true);
    if (r.valid) expect(r.request.axes).toEqual(['intent', 'scope']);
  });

  it('rejects unknown axes', () => {
    const r = validateVerifyRequest({ ...good, axes: ['intent', 'bogus'] });
    expect(r.valid).toBe(false);
  });

  it('accepts optional context', () => {
    const r = validateVerifyRequest({ ...good, context: 'user is on Base' });
    expect(r.valid).toBe(true);
    if (r.valid) expect(r.request.context).toBe('user is on Base');
  });

  it('deduplicates repeated axes', () => {
    const r = validateVerifyRequest({ ...good, axes: ['intent', 'intent', 'scope'] });
    expect(r.valid).toBe(true);
    if (r.valid) expect(r.request.axes).toEqual(['intent', 'scope']);
  });

  it('accepts sandbox flag', () => {
    const r = validateVerifyRequest({ ...good, sandbox: true });
    expect(r.valid).toBe(true);
    if (r.valid) expect(r.request.sandbox).toBe(true);
  });

  it('rejects non-boolean sandbox', () => {
    const r = validateVerifyRequest({ ...good, sandbox: 'yes' });
    expect(r.valid).toBe(false);
  });

  it('ignores legacy tier parameter (no longer part of API)', () => {
    // Legacy clients that still send `tier` — we silently accept and ignore it.
    // The API does not error on unknown fields.
    const r = validateVerifyRequest({ ...good, tier: 'standard' });
    expect(r.valid).toBe(true);
  });

  // ── ADR-0020 structural fields ─────────────────────────────────────────

  it('accepts gate_mode shadow|enforce', () => {
    const s = validateVerifyRequest({ ...good, gate_mode: 'shadow' });
    expect(s.valid).toBe(true);
    if (s.valid) expect(s.request.gate_mode).toBe('shadow');

    const e = validateVerifyRequest({ ...good, gate_mode: 'enforce' });
    expect(e.valid).toBe(true);
    if (e.valid) expect(e.request.gate_mode).toBe('enforce');
  });

  it('rejects invalid gate_mode', () => {
    const r = validateVerifyRequest({ ...good, gate_mode: 'hard' });
    expect(r.valid).toBe(false);
    if (!r.valid) expect(r.errors.some((e) => e.includes('gate_mode'))).toBe(true);
  });

  it('accepts structured_context with granted/proposed/history', () => {
    const r = validateVerifyRequest({
      ...good,
      gate_mode: 'shadow',
      structured_context: {
        granted: { max_amount: 100, recipient: 'alice', amount_currency: 'EUR' },
        proposed: { amount: 50, recipient: 'alice', allowance: '50' },
        history: {
          past_payments_to_same_counterparty: 5,
          amount_variance_from_history: 0.02,
        },
      },
    });
    expect(r.valid).toBe(true);
    if (r.valid) {
      expect(r.request.structured_context?.granted?.max_amount).toBe(100);
      expect(r.request.structured_context?.proposed?.amount).toBe(50);
      expect(r.request.structured_context?.history?.past_payments_to_same_counterparty).toBe(5);
    }
  });

  it('rejects structured_context when not an object', () => {
    const r = validateVerifyRequest({ ...good, structured_context: 'nope' });
    expect(r.valid).toBe(false);
  });

  it('rejects non-finite max_amount', () => {
    const r = validateVerifyRequest({
      ...good,
      structured_context: { granted: { max_amount: '100' } },
    });
    expect(r.valid).toBe(false);
    if (!r.valid) {
      expect(r.errors.some((e) => e.includes('max_amount'))).toBe(true);
    }
  });

  it('accepts allowance as string or number', () => {
    const a = validateVerifyRequest({
      ...good,
      structured_context: { proposed: { allowance: 'MAX_UINT256' } },
    });
    expect(a.valid).toBe(true);

    const b = validateVerifyRequest({
      ...good,
      structured_context: { proposed: { allowance: 1e40 } },
    });
    expect(b.valid).toBe(true);
  });

  it('omits structured_context and gate_mode when not provided', () => {
    const r = validateVerifyRequest(good);
    expect(r.valid).toBe(true);
    if (r.valid) {
      expect(r.request.structured_context).toBeUndefined();
      expect(r.request.gate_mode).toBeUndefined();
    }
  });
});
