import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

function makeReqRes(
  method: string,
  opts: {
    body?: unknown;
    headers?: Record<string, string>;
    url?: string;
    query?: Record<string, string>;
  } = {},
) {
  const req = {
    method,
    url: opts.url ?? '/dql/account',
    query: opts.query ?? {},
    headers: { 'content-type': 'application/json', ...(opts.headers ?? {}) },
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
    setHeader() {
      return res;
    },
    end() {
      return res;
    },
  } as any;
  return { req, res, state };
}

describe('GET /dql/account — consolidated handler', () => {
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

  it('401 without account token; does not require checkout flag', async () => {
    process.env.UPSTASH_REDIS_REST_URL = 'https://example.upstash.io';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'token';
    const mod = await import('../../../api/dql/account.js');
    const { req, res, state } = makeReqRes('GET');
    await mod.default(req, res);
    expect(state.statusCode).toBe(401);
    expect(state.jsonBody.code).toBe('ACCOUNT_UNAUTHORIZED');
  });

  it('503 when store is unavailable', async () => {
    const mod = await import('../../../api/dql/account.js');
    const { req, res, state } = makeReqRes('GET', {
      headers: { 'x-dql-account': 'dqla_test' },
    });
    await mod.default(req, res);
    expect(state.statusCode).toBe(503);
    expect(state.jsonBody.code).toBe('ACCOUNT_UNAVAILABLE');
  });

  it('rejects POST on the GET account route', async () => {
    const mod = await import('../../../api/dql/account.js');
    const { req, res, state } = makeReqRes('POST');
    await mod.default(req, res);
    expect(state.statusCode).toBe(405);
  });

  it('resolveAccountAction reads rewrite query and path', async () => {
    const mod = await import('../../../api/dql/account.js');
    expect(mod.resolveAccountAction({ query: {}, url: '/dql/account' } as any)).toBe('root');
    expect(
      mod.resolveAccountAction({ query: { action: 'portal' }, url: '/api/dql/account' } as any),
    ).toBe('portal');
    expect(
      mod.resolveAccountAction({
        query: {},
        url: '/dql/account/rotate?x=1',
      } as any),
    ).toBe('rotate');
    expect(
      mod.resolveAccountAction({
        query: {},
        url: '/api/dql/account/revoke',
      } as any),
    ).toBe('revoke');
  });
});

describe('POST /dql/account/portal|rotate|revoke — consolidated handler auth', () => {
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

  it('portal 401 without token', async () => {
    process.env.UPSTASH_REDIS_REST_URL = 'https://example.upstash.io';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'token';
    const mod = await import('../../../api/dql/account.js');
    const { req, res, state } = makeReqRes('POST', {
      query: { action: 'portal' },
      url: '/dql/account?action=portal',
    });
    await mod.default(req, res);
    expect(state.statusCode).toBe(401);
  });

  it('rotate 401 without token (path form)', async () => {
    process.env.UPSTASH_REDIS_REST_URL = 'https://example.upstash.io';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'token';
    const mod = await import('../../../api/dql/account.js');
    const { req, res, state } = makeReqRes('POST', {
      url: '/dql/account/rotate',
    });
    await mod.default(req, res);
    expect(state.statusCode).toBe(401);
  });

  it('revoke 401 without token', async () => {
    process.env.UPSTASH_REDIS_REST_URL = 'https://example.upstash.io';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'token';
    const mod = await import('../../../api/dql/account.js');
    const { req, res, state } = makeReqRes('POST', {
      query: { action: 'revoke' },
    });
    await mod.default(req, res);
    expect(state.statusCode).toBe(401);
  });

  it('GET on portal action is 405', async () => {
    const mod = await import('../../../api/dql/account.js');
    const { req, res, state } = makeReqRes('GET', {
      query: { action: 'portal' },
    });
    await mod.default(req, res);
    expect(state.statusCode).toBe(405);
  });
});
