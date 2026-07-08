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
      expect(r.request.tier).toBe('checkpoint');
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

  it('rejects unknown tier', () => {
    const r = validateVerifyRequest({ ...good, tier: 'premium' });
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
});
