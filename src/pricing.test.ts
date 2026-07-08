import { describe, it, expect } from 'vitest';
import { priceForCall, PRICE_USD_PER_CALL } from './pricing.js';

describe('priceForCall', () => {
  it('normal call costs the flat rate', () => {
    expect(priceForCall({ sandbox: false, dev_access: false })).toBe(PRICE_USD_PER_CALL);
    expect(PRICE_USD_PER_CALL).toBe(0.05);
  });

  it('sandbox calls are free', () => {
    expect(priceForCall({ sandbox: true, dev_access: false })).toBe(0);
  });

  it('dev-access keys are free', () => {
    expect(priceForCall({ sandbox: false, dev_access: true })).toBe(0);
  });

  it('sandbox is free even for dev-access keys', () => {
    expect(priceForCall({ sandbox: true, dev_access: true })).toBe(0);
  });
});
