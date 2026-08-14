import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  buildX402Challenge,
  isX402Enabled,
  paymentWallet,
  paymentReconcileId,
  processX402Payment,
  resolveFacilitatorUrl,
  sanitizePaymentClientError,
  sanitizeServerLogReason,
  settleX402Payment,
  verifyX402Payment,
  type X402PaymentContext,
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

describe('resolveFacilitatorUrl', () => {
  it('fails closed without CDP or explicit URL (no silent x402.org fallback)', () => {
    const r = resolveFacilitatorUrl({});
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/no CDP credentials/i);
  });

  it('uses CDP URL when credentials present', () => {
    const r = resolveFacilitatorUrl({
      X402_CDP_KEY_ID: 'key-id',
      X402_CDP_KEY_SECRET: 'key-secret',
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.mode).toBe('cdp');
      expect(r.url).toContain('api.cdp.coinbase.com');
    }
  });

  it('uses explicit facilitator URL override', () => {
    const r = resolveFacilitatorUrl({
      X402_FACILITATOR_URL: 'https://example.test/fac/',
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.mode).toBe('explicit');
      expect(r.url).toBe('https://example.test/fac');
    }
  });
});

describe('sanitizePaymentClientError / sanitizeServerLogReason', () => {
  it('maps timeout/network to clean client messages', () => {
    expect(sanitizePaymentClientError(new Error('The operation was aborted'))).toMatch(/timed out/i);
    expect(sanitizePaymentClientError(new Error('fetch failed'))).toMatch(/unreachable/i);
    expect(sanitizePaymentClientError(new Error('secret sk_live_xxx at host'))).toBe(
      'Payment facilitator error',
    );
  });

  it('server log reasons stay coarse (no secrets)', () => {
    expect(sanitizeServerLogReason(new Error('The operation was aborted'))).toBe('timeout');
    expect(sanitizeServerLogReason(new Error('fetch failed to https://secret.example'))).toBe(
      'network',
    );
    expect(sanitizeServerLogReason(new Error('sk_live_xxx leaked'))).toBe('error');
  });
});

describe('paymentReconcileId', () => {
  it('returns SHA-256 fingerprint, never raw nonce/wallet', () => {
    const id = paymentReconcileId({
      network: 'base',
      payload: { authorization: { from: '0xabc123', nonce: 'n-1' }, signature: 'sig' },
    });
    expect(id.startsWith('pay_')).toBe(true);
    expect(id).toMatch(/^pay_[0-9a-f]{24}$/);
    expect(id).not.toContain('n-1');
    expect(id).not.toContain('0xabc123');
    expect(id).not.toContain('sig');
  });

  it('is stable for same non-sensitive material', () => {
    const a = paymentReconcileId({ network: 'base', scheme: 'exact' });
    const b = paymentReconcileId({ network: 'base', scheme: 'exact' });
    expect(a).toBe(b);
    expect(a.startsWith('pay_')).toBe(true);
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
    const decoded = JSON.parse(Buffer.from(paymentRequiredHeader, 'base64').toString('utf8'));
    expect(decoded.x402Version).toBe(2);
  });
});

describe('verifyX402Payment / processX402Payment', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('disabled → disabled', async () => {
    const r = await processX402Payment({ headers: {} } as any, {});
    expect(r).toEqual({ kind: 'disabled' });
  });

  it('flag on + no credentials + no signature → 503, not challenge', async () => {
    const r = await processX402Payment({ headers: {} } as any, { DQL_X402_ENABLED: 'true' });
    expect(r.kind).toBe('reject');
    if (r.kind === 'reject') {
      expect(r.status).toBe(503);
      expect(r.body.code).toBe('PAYMENT_UNAVAILABLE');
    }
  });

  it('enabled + ready without signature → challenge', async () => {
    const r = await processX402Payment(
      { headers: {} } as any,
      { DQL_X402_ENABLED: 'true', X402_FACILITATOR_URL: 'https://fac.example' },
    );
    expect(r).toEqual({ kind: 'challenge' });
  });

  it('invalid signature base64 → reject 402', async () => {
    const r = await processX402Payment(
      { headers: { 'payment-signature': '!!!not-b64!!!' } } as any,
      { DQL_X402_ENABLED: 'true', X402_FACILITATOR_URL: 'https://fac.example' },
    );
    expect(r.kind).toBe('reject');
    if (r.kind === 'reject') expect(r.status).toBe(402);
  });

  it('non-Base network → reject', async () => {
    const sig = Buffer.from(JSON.stringify({ network: 'eip155:1', payload: {} })).toString('base64');
    const r = await processX402Payment(
      { headers: { 'payment-signature': sig } } as any,
      { DQL_X402_ENABLED: 'true', X402_FACILITATOR_URL: 'https://fac.example' },
    );
    expect(r.kind).toBe('reject');
    if (r.kind === 'reject') {
      expect(r.body.error).toMatch(/Base mainnet only/i);
    }
  });

  it('enabled + signature without CDP/explicit facilitator → 503 misconfigured', async () => {
    const sig = Buffer.from(JSON.stringify({ network: 'base', payload: {} })).toString('base64');
    const r = await verifyX402Payment(
      { headers: { 'payment-signature': sig } } as any,
      { DQL_X402_ENABLED: 'true' },
    );
    expect(r.kind).toBe('reject');
    if (r.kind === 'reject') {
      expect(r.status).toBe(503);
      expect(r.body.code).toBe('PAYMENT_UNAVAILABLE');
    }
  });

  it('verify-only: valid facilitator response does NOT settle', async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        calls.push(String(url));
        return {
          ok: true,
          json: async () => ({ isValid: true }),
          text: async () => '',
          status: 200,
        };
      }),
    );

    const sig = Buffer.from(JSON.stringify({ network: 'base', payload: { signature: 's' } })).toString(
      'base64',
    );
    const r = await verifyX402Payment(
      { headers: { 'payment-signature': sig } } as any,
      { DQL_X402_ENABLED: 'true', X402_FACILITATOR_URL: 'https://fac.example' },
    );

    expect(r.kind).toBe('verified');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('/verify');
    expect(calls.some((u) => u.includes('/settle'))).toBe(false);
  });

  it('verify: facilitator timeout → clean 502', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        const err = new Error('The operation was aborted');
        err.name = 'AbortError';
        throw err;
      }),
    );

    const sig = Buffer.from(JSON.stringify({ network: 'base', payload: {} })).toString('base64');
    const r = await verifyX402Payment(
      { headers: { 'payment-signature': sig } } as any,
      { DQL_X402_ENABLED: 'true', X402_FACILITATOR_URL: 'https://fac.example' },
    );
    expect(r.kind).toBe('reject');
    if (r.kind === 'reject') {
      expect(r.status).toBe(502);
      expect(String(r.body.error)).toMatch(/timed out|unreachable|facilitator/i);
      expect(JSON.stringify(r.body)).not.toMatch(/fac\.example|sk_|secret/i);
    }
  });
});

describe('settleX402Payment', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const ctx: X402PaymentContext = {
    payload: { network: 'base', payload: { signature: 's', authorization: { nonce: 'n-99' } } },
    paymentRequirements: {
      scheme: 'exact',
      network: 'base',
      amount: '50000',
      asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      payTo: '0xAB9f84864662f980614bD1453dB9950Ef2b82E83',
    },
    clientNetwork: 'base',
    facilitatorUrl: 'https://fac.example',
    facilitatorMode: 'explicit',
  };

  it('settles successfully after DQL', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ success: true, transaction: '0xabc', network: 'base' }),
        text: async () => '',
        status: 200,
      })),
    );
    const r = await settleX402Payment(ctx, {});
    expect(r.kind).toBe('settled');
    if (r.kind === 'settled') {
      expect(r.txHash).toBe('0xabc');
      expect(r.network).toBe('base');
    }
  });

  it('authoritative success:false → PAYMENT_FAILED (not charged)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ success: false, errorReason: 'insufficient' }),
        text: async () => '',
        status: 200,
      })),
    );
    const r = await settleX402Payment(ctx, {});
    expect(r.kind).toBe('reject');
    if (r.kind === 'reject') {
      expect(r.body.code).toBe('PAYMENT_FAILED');
      expect(String(r.body.details)).toMatch(/not charged/i);
      expect(String(r.body.payment_id)).toMatch(/^pay_[0-9a-f]{24}$/);
      expect(String(r.body.payment_id)).not.toContain('n-99');
    }
  });

  it('settle timeout → PAYMENT_STATUS_UNKNOWN (never claims not charged)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        const err = new Error('The operation was aborted');
        err.name = 'AbortError';
        throw err;
      }),
    );
    const r = await settleX402Payment(ctx, {});
    expect(r.kind).toBe('reject');
    if (r.kind === 'reject') {
      expect(r.status).toBe(502);
      expect(r.body.code).toBe('PAYMENT_STATUS_UNKNOWN');
      expect(JSON.stringify(r.body)).not.toMatch(/not charged/i);
      expect(String(r.body.details)).toMatch(/Reconcile/i);
      expect(String(r.body.payment_id)).toMatch(/^pay_[0-9a-f]{24}$/);
      expect(String(r.body.payment_id)).not.toContain('n-99');
    }
  });

  it('settle HTTP 5xx after request → PAYMENT_STATUS_UNKNOWN', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: false,
        status: 503,
        json: async () => ({}),
        text: async () => 'service unavailable secret',
      })),
    );
    const r = await settleX402Payment(ctx, {});
    expect(r.kind).toBe('reject');
    if (r.kind === 'reject') {
      expect(r.body.code).toBe('PAYMENT_STATUS_UNKNOWN');
      expect(JSON.stringify(r.body)).not.toMatch(/secret|not charged|not accepted/i);
      expect(String(r.body.payment_id)).toMatch(/^pay_[0-9a-f]{24}$/);
    }
  });

  it('verify HTTP 5xx → 502 PAYMENT_UNAVAILABLE (not 402 invalid)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: false,
        status: 503,
        json: async () => ({}),
        text: async () => 'upstream down',
      })),
    );
    const sig = Buffer.from(JSON.stringify({ network: 'base', payload: {} })).toString('base64');
    const r = await verifyX402Payment(
      { headers: { 'payment-signature': sig } } as any,
      { DQL_X402_ENABLED: 'true', X402_FACILITATOR_URL: 'https://fac.example' },
    );
    expect(r.kind).toBe('reject');
    if (r.kind === 'reject') {
      expect(r.status).toBe(502);
      expect(r.body.code).toBe('PAYMENT_UNAVAILABLE');
      expect(r.status).not.toBe(402);
    }
  });
});
