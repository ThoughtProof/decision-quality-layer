import { describe, it, expect } from 'vitest';
import {
  buildX402Challenge,
  isX402Enabled,
  paymentWallet,
  processX402Payment,
} from './x402.js';

describe('isX402Enabled', () => {
  it('default off', () => {
    expect(isX402Enabled({})).toBe(false);
    expect(isX402Enabled({ DQL_X402_ENABLED: 'false' })).toBe(false);
    expect(isX402Enabled({ DQL_X402_ENABLED: 'true' })).toBe(true);
  });
});

describe('paymentWallet', () => {
  it('defaults to shared ThoughtProof wallet', () => {
    expect(paymentWallet({})).toBe('0xAB9f84864662f980614bD1453dB9950Ef2b82E83');
  });
});

describe('buildX402Challenge', () => {
  it('advertises Base dual network + $0.05 micro-amount', () => {
    const { body, paymentRequiredHeader } = buildX402Challenge({});
    expect(body.code).toBe('PAYMENT_REQUIRED');
    expect(body.price_usd_per_call).toBe(0.05);
    expect(body.protocol).toBe('x402');
    const challenge = body.x402 as { accepts: Array<{ network: string; amount: string; payTo: string }> };
    const nets = challenge.accepts.map((a) => a.network);
    expect(nets).toContain('eip155:8453');
    expect(nets).toContain('base');
    expect(challenge.accepts[0]!.amount).toBe('50000'); // 0.05 * 1e6
    expect(paymentRequiredHeader.length).toBeGreaterThan(20);
    // header is base64 of challenge
    const decoded = JSON.parse(Buffer.from(paymentRequiredHeader, 'base64').toString('utf8'));
    expect(decoded.x402Version).toBe(2);
  });
});

describe('processX402Payment', () => {
  it('disabled → disabled', async () => {
    const r = await processX402Payment({ headers: {} } as any, {});
    expect(r).toEqual({ kind: 'disabled' });
  });

  it('enabled without signature → challenge', async () => {
    const r = await processX402Payment({ headers: {} } as any, { DQL_X402_ENABLED: 'true' });
    expect(r).toEqual({ kind: 'challenge' });
  });

  it('invalid signature base64 → reject 402', async () => {
    const r = await processX402Payment(
      { headers: { 'payment-signature': '!!!not-b64!!!' } } as any,
      { DQL_X402_ENABLED: 'true' },
    );
    expect(r.kind).toBe('reject');
    if (r.kind === 'reject') expect(r.status).toBe(402);
  });

  it('non-Base network → reject', async () => {
    const sig = Buffer.from(JSON.stringify({ network: 'eip155:1', payload: {} })).toString('base64');
    const r = await processX402Payment(
      { headers: { 'payment-signature': sig } } as any,
      { DQL_X402_ENABLED: 'true' },
    );
    expect(r.kind).toBe('reject');
    if (r.kind === 'reject') {
      expect(r.body.error).toMatch(/Base mainnet only/i);
    }
  });
});
