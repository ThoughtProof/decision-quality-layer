import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

function makeReqRes(
  method: string,
  opts: { body?: unknown; query?: Record<string, string>; headers?: Record<string, string> } = {},
) {
  const req = {
    method,
    headers: { 'content-type': 'application/json', ...(opts.headers ?? {}) },
    body: opts.body,
    query: opts.query ?? {},
  } as any;
  const state: {
    statusCode: number;
    jsonBody?: any;
    ended: boolean;
    headers: Record<string, string>;
  } = { statusCode: 200, ended: false, headers: {} };
  const res = {
    status(code: number) {
      state.statusCode = code;
      return res;
    },
    json(payload: any) {
      state.jsonBody = payload;
      state.ended = true;
      return res;
    },
    setHeader(k: string, v: string) {
      state.headers[k] = v;
    },
    end() {
      state.ended = true;
      return res;
    },
  } as any;
  return { req, res, state };
}

describe('POST /dql/checkout — flag default OFF', () => {
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

  it('returns 503 CHECKOUT_DISABLED when flag is unset (merge ≠ public billing)', async () => {
    const mod = await import('./checkout.js');
    const { req, res, state } = makeReqRes('POST', { body: { email: 'a@b.co' } });
    await mod.default(req, res);
    expect(state.statusCode).toBe(503);
    expect(state.jsonBody.code).toBe('CHECKOUT_DISABLED');
  });

  it('GET without session_id → 400', async () => {
    const mod = await import('./checkout.js');
    const { req, res, state } = makeReqRes('GET');
    await mod.default(req, res);
    expect(state.statusCode).toBe(400);
  });

  it('OPTIONS is 200', async () => {
    const mod = await import('./checkout.js');
    const { req, res, state } = makeReqRes('OPTIONS');
    await mod.default(req, res);
    expect(state.statusCode).toBe(200);
  });

  it('flag on + missing/unknown pack → 400 INVALID_REQUEST', async () => {
    process.env.DQL_CHECKOUT_ENABLED = 'true';
    process.env.STRIPE_SECRET_KEY = 'sk_test_x';
    process.env.UPSTASH_REDIS_REST_URL = 'https://example.upstash.io';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'token';
    const mod = await import('./checkout.js');
    const missing = makeReqRes('POST', { body: { email: 'a@b.co' } });
    await mod.default(missing.req, missing.res);
    expect(missing.state.statusCode).toBe(400);
    expect(missing.state.jsonBody.code).toBe('INVALID_REQUEST');

    const unknown = makeReqRes('POST', { body: { email: 'a@b.co', pack: 'builder' } });
    await mod.default(unknown.req, unknown.res);
    expect(unknown.state.statusCode).toBe(400);
    expect(unknown.state.jsonBody.code).toBe('INVALID_REQUEST');
  });

  it('flag on + starter without pack price → 503 CHECKOUT_UNAVAILABLE', async () => {
    process.env.DQL_CHECKOUT_ENABLED = 'true';
    process.env.STRIPE_SECRET_KEY = 'sk_test_x';
    process.env.UPSTASH_REDIS_REST_URL = 'https://example.upstash.io';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'token';
    const mod = await import('./checkout.js');
    const { req, res, state } = makeReqRes('POST', {
      body: { email: 'a@b.co', pack: 'starter' },
    });
    await mod.default(req, res);
    expect(state.statusCode).toBe(503);
    expect(state.jsonBody.code).toBe('CHECKOUT_UNAVAILABLE');
  });
});
