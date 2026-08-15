import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import {
  NO_FREEMIUM,
  PACKS,
  PLUS_CREDITS,
  STARTER_CREDITS,
  TRIAL_CREDITS,
  parseCheckoutPack,
} from './packs.js';

const FORBIDDEN = [/free plan/i, /developer trial/i, /\bBuilder\b/];

describe('packs (source of truth)', () => {
  it('locks consumer amounts and no_freemium', () => {
    expect(NO_FREEMIUM).toBe(true);
    expect(TRIAL_CREDITS).toBe(5);
    expect(STARTER_CREDITS).toBe(200);
    expect(PLUS_CREDITS).toBe(1000);
    expect(PACKS.starter.list_price_usd).toBe(8);
    expect(PACKS.plus.list_price_usd).toBe(35);
    expect(PACKS.payg.list_price_usd).toBe(0.05);
    expect(PACKS.trial.trial).toBe(true);
    expect(PACKS.starter.trial).toBe(false);
    expect(PACKS.payg.credits).toBe(0);
    expect(PACKS.payg.payg_opt_in).toBe(true);
  });

  it('parses known slugs and rejects unknown', () => {
    expect(parseCheckoutPack('starter')).toBe('starter');
    expect(parseCheckoutPack('PLUS')).toBe('plus');
    expect(parseCheckoutPack('trial')).toBe('trial');
    expect(parseCheckoutPack('payg')).toBe('payg');
    expect(parseCheckoutPack(undefined)).toBeUndefined();
    expect(parseCheckoutPack('builder')).toBeUndefined();
    expect(parseCheckoutPack('free')).toBeUndefined();
  });

  it('docs and public copy never name a free plan, developer trial, or Builder', () => {
    const files = [
      'docs/PAYMENT.md',
      'docs/ENV.md',
      'src/auth/packs.ts',
      'src/auth/checkout.ts',
      'api/dql/checkout.ts',
      'api/openapi.ts',
    ];
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      for (const re of FORBIDDEN) {
        expect(text, `${file} matches ${re}`).not.toMatch(re);
      }
    }
  });
});
