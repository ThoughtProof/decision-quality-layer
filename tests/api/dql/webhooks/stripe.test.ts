import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

function makeReqRes(method: string, opts: { body?: unknown; headers?: Record<string, string> } = {}) {
  const req = {
    method,
    headers: { ...(opts.headers ?? {}) },
    body: opts.body,
  } as any;
  const state: { statusCode: number; jsonBody?: any } = { statusCode: 200 };
  const res = {
    status(code: number) {
      state.statusCode = code;
      return res;
    },
    json(payload: any) {
      state.jsonBody = payload;
      return res;
    },
    end() {
      return res;
    },
  } as any;
  return { req, res, state };
}

describe('POST /dql/webhooks/stripe', () => {
  const originalEnv = process.env;
  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
    for (const k of Object.keys(process.env)) {
      if (k.startsWith('DQL_') || k.startsWith('STRIPE_') || k.startsWith('UPSTASH_')) {
        delete process.env[k];
      }
    }
  });
  afterEach(() => {
    process.env = originalEnv;
  });

  it('503 when STRIPE_WEBHOOK_SECRET is missing', async () => {
    const mod = await import('../../../../api/dql/webhooks/stripe.js');
    const { req, res, state } = makeReqRes('POST', { body: '{}' });
    await mod.default(req, res);
    expect(state.statusCode).toBe(503);
    expect(state.jsonBody.code).toBe('WEBHOOK_UNAVAILABLE');
  });

  it('400 when body was pre-parsed (signature cannot be verified)', async () => {
    process.env.STRIPE_WEBHOOK_SECRET = 'whsec_' + 'a'.repeat(24);
    process.env.UPSTASH_REDIS_REST_URL = 'https://example.upstash.io';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'token';
    const mod = await import('../../../../api/dql/webhooks/stripe.js');
    const { req, res, state } = makeReqRes('POST', {
      body: { type: 'checkout.session.completed' },
      headers: { 'stripe-signature': 't=1,v1=abcd' },
    });
    await mod.default(req, res);
    expect(state.statusCode).toBe(400);
  });

  it('rejects GET', async () => {
    const mod = await import('../../../../api/dql/webhooks/stripe.js');
    const { req, res, state } = makeReqRes('GET');
    await mod.default(req, res);
    expect(state.statusCode).toBe(405);
  });
});
