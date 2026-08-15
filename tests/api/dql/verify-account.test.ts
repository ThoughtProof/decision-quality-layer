/**
 * App-credential path: POST /dql/verify authorized with dqla_…
 * (X-DQL-Account / Bearer). Bills the bound ledger; never returns dqlk_.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { authorizeAccount, revokeAccountKey, rotateAccountKey } from '../../../src/auth/account.js';
import { finalizeCheckoutMint } from '../../../src/auth/checkout.js';
import { sha256Hex } from '../../../src/auth/key-hash.js';
import { UpstashKeyStore, createMemoryKv, selfServeOwner } from '../../../src/auth/key-store.js';
import { STARTER_CREDITS } from '../../../src/auth/packs.js';

const harness = vi.hoisted(() => ({
  store: null as InstanceType<typeof UpstashKeyStore> | null,
}));

vi.mock('../../../src/auth/key-store.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/auth/key-store.js')>();
  return {
    ...actual,
    createKeyStore: () => harness.store,
  };
});

function makeReqRes(body?: unknown, method = 'POST', headers: Record<string, string> = {}) {
  const req = {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body,
  } as any;
  const state: {
    statusCode: number;
    jsonBody?: any;
    headers: Record<string, string>;
  } = { statusCode: 200, jsonBody: undefined, headers: {} };
  const res = {
    status(code: number) {
      state.statusCode = code;
      return res;
    },
    json(payload: any) {
      state.jsonBody = payload;
      return res;
    },
    setHeader(k: string, v: string) {
      state.headers[k] = v;
    },
    end() {
      return res;
    },
  } as any;
  return { req, res, state };
}

const validVerifyBody = {
  mandate: 'Book a refundable fare',
  proposed_action: 'Book the refundable fare as specified',
  reasoning: 'Matches the mandate and stays reversible',
  axes: ['intent', 'scope', 'risk', 'consistency', 'reversibility'],
};

const DEV_KEY = 'dqlk_test_dev_key_0000000000000000';
const DEV_KEYS_ENV = JSON.stringify({
  [DEV_KEY]: { owner: 'test-suite', dev_access: true, daily_cap: 1000 },
});

describe('POST /dql/verify — account token (dqla_)', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
    for (const k of Object.keys(process.env)) {
      if (k.startsWith('DQL_') || k === 'SERV_API_KEY' || k === 'SERV_BASE_URL' || k.startsWith('UPSTASH_')) {
        delete process.env[k];
      }
    }
    harness.store = new UpstashKeyStore(createMemoryKv());
  });

  afterEach(() => {
    process.env = originalEnv;
    harness.store = null;
  });

  async function mintStarter() {
    const store = harness.store!;
    const minted = await finalizeCheckoutMint({
      sessionId: 'cs_handler',
      customerId: 'cus_handler',
      owner: selfServeOwner('cus_handler'),
      store,
      pack: 'starter',
    });
    expect(minted.kind).toBe('minted');
    if (minted.kind !== 'minted') throw new Error('mint failed');
    return minted;
  }

  it('valid dqla_ completes a live-shaped verify and decrements credits', async () => {
    const minted = await mintStarter();
    const logs: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((l: unknown) => {
      logs.push(String(l));
    });

    const mod = await import('../../../api/dql/verify.js');
    const { req, res, state } = makeReqRes(
      { ...validVerifyBody, sandbox: false },
      'POST',
      { 'x-dql-account': minted.accountToken },
    );
    await mod.default(req, res);

    expect(state.statusCode).toBe(200);
    expect(state.jsonBody.mandate).toBeUndefined();
    expect(state.jsonBody.axes).toHaveLength(5);
    expect(state.jsonBody.aggregate).toBeDefined();
    expect(state.jsonBody.aggregate.verdict).toMatch(/^(ALLOW|BLOCK|REVIEW)$/);
    expect(JSON.stringify(state.jsonBody)).not.toContain(minted.plaintext);
    expect(JSON.stringify(state.jsonBody)).not.toContain(minted.accountToken);
    expect(JSON.stringify(state.jsonBody)).not.toMatch(/dqlk_[0-9a-f]{16}/);
    expect(state.headers['X-DQL-Billing']).toBe('credit');
    expect(await harness.store!.creditBalance(sha256Hex(minted.plaintext))).toBe(STARTER_CREDITS - 1);
    expect(logs.join('\n')).not.toContain(minted.plaintext);
    expect(logs.join('\n')).not.toContain(minted.accountToken);
    spy.mockRestore();
  });

  it('Bearer dqla_ is accepted; invalid token is 401', async () => {
    const minted = await mintStarter();
    const mod = await import('../../../api/dql/verify.js');

    const ok = makeReqRes({ ...validVerifyBody, sandbox: false }, 'POST', {
      authorization: `Bearer ${minted.accountToken}`,
    });
    await mod.default(ok.req, ok.res);
    expect(ok.state.statusCode).toBe(200);

    const bad = makeReqRes({ ...validVerifyBody, sandbox: false }, 'POST', {
      'x-dql-account': 'dqla_not_issued',
    });
    await mod.default(bad.req, bad.res);
    expect(bad.state.statusCode).toBe(401);
    expect(bad.state.jsonBody.code).toBe('ACCOUNT_UNAUTHORIZED');
    expect(JSON.stringify(bad.state.jsonBody)).not.toContain(minted.plaintext);
  });

  it('dqlk_ path still works alongside the account path', async () => {
    process.env.DQL_API_KEYS = DEV_KEYS_ENV;
    const minted = await mintStarter();
    const mod = await import('../../../api/dql/verify.js');

    const keyCall = makeReqRes({ ...validVerifyBody, sandbox: false }, 'POST', {
      'x-dql-key': DEV_KEY,
    });
    await mod.default(keyCall.req, keyCall.res);
    expect(keyCall.state.statusCode).toBe(200);
    expect(keyCall.state.headers['X-DQL-Billing']).toBe('dev-access');

    const storeKey = makeReqRes({ ...validVerifyBody, sandbox: false }, 'POST', {
      'x-dql-key': minted.plaintext,
    });
    await mod.default(storeKey.req, storeKey.res);
    expect(storeKey.state.statusCode).toBe(200);
    expect(storeKey.state.headers['X-DQL-Billing']).toBe('credit');
    expect(await harness.store!.creditBalance(sha256Hex(minted.plaintext))).toBe(STARTER_CREDITS - 1);

    const asKeyHeader = makeReqRes({ ...validVerifyBody, sandbox: false }, 'POST', {
      'x-dql-key': minted.accountToken,
    });
    await mod.default(asKeyHeader.req, asKeyHeader.res);
    expect(asKeyHeader.state.statusCode).toBe(402);
  });

  it('rotate keeps dqla_ verify on the new ledger; revoke stops verify', async () => {
    const minted = await mintStarter();
    const store = harness.store!;
    const auth = await authorizeAccount({
      headers: { 'x-dql-account': minted.accountToken },
      store,
    });
    expect(auth.kind).toBe('ok');
    if (auth.kind !== 'ok') return;

    const rotated = await rotateAccountKey({
      record: auth.record,
      store,
      token: minted.accountToken,
    });
    expect(rotated.kind).toBe('ok');
    if (rotated.kind !== 'ok') return;

    const mod = await import('../../../api/dql/verify.js');

    const oldKey = makeReqRes({ ...validVerifyBody, sandbox: false }, 'POST', {
      'x-dql-key': minted.plaintext,
    });
    await mod.default(oldKey.req, oldKey.res);
    expect(oldKey.state.statusCode).toBe(402);

    const afterRotate = makeReqRes({ ...validVerifyBody, sandbox: false }, 'POST', {
      'x-dql-account': minted.accountToken,
    });
    await mod.default(afterRotate.req, afterRotate.res);
    expect(afterRotate.state.statusCode).toBe(200);
    expect(JSON.stringify(afterRotate.state.jsonBody)).not.toContain(rotated.api_key);
    expect(await store.creditBalance(sha256Hex(rotated.api_key))).toBe(STARTER_CREDITS - 1);

    const live = await authorizeAccount({
      headers: { 'x-dql-account': minted.accountToken },
      store,
    });
    expect(live.kind).toBe('ok');
    if (live.kind !== 'ok') return;
    expect((await revokeAccountKey({ record: live.record, store })).kind).toBe('ok');

    const afterRevoke = makeReqRes({ ...validVerifyBody, sandbox: false }, 'POST', {
      'x-dql-account': minted.accountToken,
    });
    await mod.default(afterRevoke.req, afterRevoke.res);
    expect(afterRevoke.state.statusCode).toBe(401);
    expect(afterRevoke.state.jsonBody.code).toBe('ACCOUNT_UNAUTHORIZED');
  });

  it('CORS allows X-DQL-Account', async () => {
    const mod = await import('../../../api/dql/verify.js');
    const { req, res, state } = makeReqRes(undefined, 'OPTIONS');
    await mod.default(req, res);
    expect(state.statusCode).toBe(200);
    expect(state.headers['Access-Control-Allow-Headers']).toMatch(/X-DQL-Account/);
  });
});
