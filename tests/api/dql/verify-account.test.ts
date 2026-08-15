/**
 * App-credential path: POST /dql/verify authorized with dqla_…
 * (X-DQL-Account / Bearer). Bills the bound ledger; never returns dqlk_.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { authorizeAccount, revokeAccountKey, rotateAccountKey } from '../../../src/auth/account.js';
import { finalizeCheckoutMint } from '../../../src/auth/checkout.js';
import { sha256Hex } from '../../../src/auth/key-hash.js';
import { UpstashKeyStore, createMemoryKv, selfServeOwner } from '../../../src/auth/key-store.js';
import { DEFAULT_DAILY_CAP } from '../../../src/auth/keys.js';
import { STARTER_CREDITS } from '../../../src/auth/packs.js';
import { usageCounterKeyFromHash } from '../../../src/auth/usage.js';
import { verifyPayloadDigest } from '../../../src/auth/verify-payload.js';
import { AXES } from '../../../src/types.js';

const harness = vi.hoisted(() => ({
  store: null as InstanceType<typeof UpstashKeyStore> | null,
  kv: null as ReturnType<typeof createMemoryKv> | null,
  failVerify: false,
  verifyCalls: 0,
  meterKind: 'skipped' as 'ok' | 'error' | 'skipped',
  meterCalls: 0,
}));

vi.mock('../../../src/auth/key-store.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/auth/key-store.js')>();
  return {
    ...actual,
    createKeyStore: () => harness.store,
  };
});

vi.mock('../../../src/auth/stripe-meter.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/auth/stripe-meter.js')>();
  return {
    ...actual,
    emitStripeMeterEvent: async () => {
      harness.meterCalls += 1;
      if (harness.meterKind === 'ok') {
        return { kind: 'ok' as const, event_name: 'dql_verify_call' };
      }
      if (harness.meterKind === 'error') {
        return { kind: 'error' as const, reason: 'http_503' };
      }
      return { kind: 'skipped' as const, reason: 'meter_disabled' };
    },
  };
});

vi.mock('../../../src/engine/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/engine/index.js')>();
  return {
    ...actual,
    runVerification: async (opts: Parameters<typeof actual.runVerification>[0]) => {
      harness.verifyCalls += 1;
      if (harness.failVerify) throw new Error('provider down');
      return actual.runVerification(opts);
    },
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
    harness.kv = createMemoryKv();
    harness.store = new UpstashKeyStore(harness.kv);
    harness.failVerify = false;
    harness.verifyCalls = 0;
    harness.meterKind = 'skipped';
    harness.meterCalls = 0;
  });

  afterEach(() => {
    process.env = originalEnv;
    harness.store = null;
    harness.kv = null;
    harness.failVerify = false;
    harness.verifyCalls = 0;
    harness.meterKind = 'skipped';
    harness.meterCalls = 0;
  });

  async function mintAccount(
    sessionId = 'cs_handler',
    customerId = 'cus_handler',
    pack: 'starter' | 'payg' = 'starter',
  ) {
    const store = harness.store!;
    const minted = await finalizeCheckoutMint({
      sessionId,
      customerId,
      owner: selfServeOwner(customerId),
      store,
      pack,
    });
    expect(minted.kind).toBe('minted');
    if (minted.kind !== 'minted') throw new Error('mint failed');
    return minted;
  }

  async function mintStarter() {
    return mintAccount();
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
    expect(harness.verifyCalls).toBe(1);
    expect(await harness.store!.creditBalance(sha256Hex(minted.plaintext))).toBe(STARTER_CREDITS - 1);
    expect(await harness.store!.usageToday(sha256Hex(minted.plaintext))).toBe(1);
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

  it('CONFIG_INVALID after valid dqla_ leaves credits unchanged', async () => {
    process.env.DQL_CASCADE = 'pot-cli';
    const minted = await mintStarter();
    const before = await harness.store!.creditBalance(sha256Hex(minted.plaintext));
    expect(before).toBe(STARTER_CREDITS);

    const mod = await import('../../../api/dql/verify.js');
    const { req, res, state } = makeReqRes(
      { ...validVerifyBody, sandbox: false },
      'POST',
      { 'x-dql-account': minted.accountToken },
    );
    await mod.default(req, res);
    expect(state.statusCode).toBe(503);
    expect(state.jsonBody.code).toBe('CONFIG_INVALID');
    expect(JSON.stringify(state.jsonBody)).not.toContain(minted.plaintext);
    expect(JSON.stringify(state.jsonBody)).not.toContain(minted.accountToken);
    expect(harness.verifyCalls).toBe(0);
    expect(await harness.store!.creditBalance(sha256Hex(minted.plaintext))).toBe(STARTER_CREDITS);
    expect(await harness.store!.usageToday(sha256Hex(minted.plaintext))).toBe(0);
  });

  it('thrown verify after valid dqla_ leaves credits unchanged', async () => {
    harness.failVerify = true;
    const minted = await mintStarter();
    const mod = await import('../../../api/dql/verify.js');
    const { req, res, state } = makeReqRes(
      { ...validVerifyBody, sandbox: false },
      'POST',
      { 'x-dql-account': minted.accountToken },
    );
    await mod.default(req, res);
    expect(state.statusCode).toBe(500);
    expect(state.jsonBody.code).toBe('INTERNAL_ERROR');
    expect(JSON.stringify(state.jsonBody)).not.toContain(minted.plaintext);
    expect(JSON.stringify(state.jsonBody)).not.toContain(minted.accountToken);
    expect(harness.verifyCalls).toBe(1);
    expect(await harness.store!.creditBalance(sha256Hex(minted.plaintext))).toBe(STARTER_CREDITS);
    expect(await harness.store!.usageToday(sha256Hex(minted.plaintext))).toBe(0);
  });

  it('0 credits + valid dqla_ is 402 without calling runVerification', async () => {
    const minted = await mintStarter();
    await harness.store!.setCreditBalance(sha256Hex(minted.plaintext), 0);
    const mod = await import('../../../api/dql/verify.js');
    const { req, res, state } = makeReqRes(
      { ...validVerifyBody, sandbox: false },
      'POST',
      { 'x-dql-account': minted.accountToken },
    );
    await mod.default(req, res);
    expect(state.statusCode).toBe(402);
    expect(state.jsonBody.code).toBe('CREDITS_EXHAUSTED');
    expect(state.jsonBody.axes).toBeUndefined();
    expect(harness.verifyCalls).toBe(0);
    expect(await harness.store!.creditBalance(sha256Hex(minted.plaintext))).toBe(0);
    expect(await harness.store!.usageToday(sha256Hex(minted.plaintext))).toBe(0);
  });

  it('daily-cap exhausted is 429 without running verify; credits unchanged', async () => {
    const minted = await mintStarter();
    const hash = sha256Hex(minted.plaintext);
    const day = new Date().toISOString().slice(0, 10);
    await harness.kv!.set(usageCounterKeyFromHash(hash, day), DEFAULT_DAILY_CAP);
    const mod = await import('../../../api/dql/verify.js');
    const { req, res, state } = makeReqRes(
      { ...validVerifyBody, sandbox: false },
      'POST',
      { 'x-dql-account': minted.accountToken },
    );
    await mod.default(req, res);
    expect(state.statusCode).toBe(429);
    expect(state.jsonBody.code).toBe('QUOTA_EXCEEDED');
    expect(harness.verifyCalls).toBe(0);
    expect(await harness.store!.creditBalance(hash)).toBe(STARTER_CREDITS);
    expect(await harness.store!.usageToday(hash)).toBe(DEFAULT_DAILY_CAP);
  });

  it('two concurrent verifies with 1 credit: one 200, one 402; engine once', async () => {
    const minted = await mintStarter();
    const hash = sha256Hex(minted.plaintext);
    await harness.store!.setCreditBalance(hash, 1);
    const mod = await import('../../../api/dql/verify.js');
    const a = makeReqRes({ ...validVerifyBody, sandbox: false }, 'POST', {
      'x-dql-account': minted.accountToken,
    });
    const b = makeReqRes({ ...validVerifyBody, sandbox: false }, 'POST', {
      'x-dql-account': minted.accountToken,
    });
    await Promise.all([mod.default(a.req, a.res), mod.default(b.req, b.res)]);
    const codes = [a.state.statusCode, b.state.statusCode].sort();
    expect(codes).toEqual([200, 402]);
    const failed = a.state.statusCode === 402 ? a.state : b.state;
    expect(failed.jsonBody.code).toBe('CREDITS_EXHAUSTED');
    expect(harness.verifyCalls).toBe(1);
    expect(await harness.store!.creditBalance(hash)).toBe(0);
    expect(JSON.stringify(a.state.jsonBody)).not.toContain(minted.plaintext);
    expect(JSON.stringify(b.state.jsonBody)).not.toContain(minted.accountToken);
  });

  it('CORS allows X-DQL-Account', async () => {
    const mod = await import('../../../api/dql/verify.js');
    const { req, res, state } = makeReqRes(undefined, 'OPTIONS');
    await mod.default(req, res);
    expect(state.statusCode).toBe(200);
    expect(state.headers['Access-Control-Allow-Headers']).toMatch(/X-DQL-Account/);
    expect(state.headers['Access-Control-Allow-Headers']).toMatch(/Idempotency-Key/);
  });

  it('client Idempotency-Key is the reservation id; retry does not double-debit', async () => {
    const minted = await mintStarter();
    const hash = sha256Hex(minted.plaintext);
    const mod = await import('../../../api/dql/verify.js');
    const headers = {
      'x-dql-account': minted.accountToken,
      'idempotency-key': 'client-retry-key-01',
    };
    const first = makeReqRes({ ...validVerifyBody, sandbox: false }, 'POST', headers);
    await mod.default(first.req, first.res);
    expect(first.state.statusCode).toBe(200);
    expect(first.state.headers['X-Request-Id']).toBe('client-retry-key-01');
    expect(await harness.store!.creditBalance(hash)).toBe(STARTER_CREDITS - 1);

    const retry = makeReqRes({ ...validVerifyBody, sandbox: false }, 'POST', headers);
    await mod.default(retry.req, retry.res);
    expect(retry.state.statusCode).toBe(200);
    expect(retry.state.headers['X-Request-Id']).toBe('client-retry-key-01');
    expect(await harness.store!.creditBalance(hash)).toBe(STARTER_CREDITS - 1);
    expect(await harness.store!.usageToday(hash)).toBe(1);
    expect(harness.verifyCalls).toBe(1);
    expect(retry.state.jsonBody.id).toBe(first.state.jsonBody.id);
  });

  it('client X-Request-Id is the reservation id when Idempotency-Key is absent', async () => {
    const minted = await mintStarter();
    const hash = sha256Hex(minted.plaintext);
    const mod = await import('../../../api/dql/verify.js');
    const headers = {
      'x-dql-account': minted.accountToken,
      'x-request-id': 'req-client-id-42',
    };
    const first = makeReqRes({ ...validVerifyBody, sandbox: false }, 'POST', headers);
    await mod.default(first.req, first.res);
    expect(first.state.statusCode).toBe(200);
    expect(first.state.headers['X-Request-Id']).toBe('req-client-id-42');

    const retry = makeReqRes({ ...validVerifyBody, sandbox: false }, 'POST', headers);
    await mod.default(retry.req, retry.res);
    expect(retry.state.statusCode).toBe(200);
    expect(await harness.store!.creditBalance(hash)).toBe(STARTER_CREDITS - 1);
    expect(harness.verifyCalls).toBe(1);
  });

  it('invalid Idempotency-Key is 400 and does not run verify', async () => {
    const minted = await mintStarter();
    const mod = await import('../../../api/dql/verify.js');
    const { req, res, state } = makeReqRes({ ...validVerifyBody, sandbox: false }, 'POST', {
      'x-dql-account': minted.accountToken,
      'idempotency-key': 'dqlk_looks_like_a_secret',
    });
    await mod.default(req, res);
    expect(state.statusCode).toBe(400);
    expect(state.jsonBody.code).toBe('INVALID_IDEMPOTENCY_KEY');
    expect(harness.verifyCalls).toBe(0);
    expect(await harness.store!.creditBalance(sha256Hex(minted.plaintext))).toBe(STARTER_CREDITS);
    expect(JSON.stringify(state.jsonBody)).not.toContain(minted.plaintext);
    expect(JSON.stringify(state.jsonBody)).not.toContain(minted.accountToken);
  });

  it('two accounts with the same Idempotency-Key and different payloads both succeed', async () => {
    const funded = await mintAccount('cs_fund', 'cus_fund');
    const other = await mintAccount('cs_peer', 'cus_peer');
    const mod = await import('../../../api/dql/verify.js');
    const first = makeReqRes({ ...validVerifyBody, sandbox: false }, 'POST', {
      'x-dql-account': funded.accountToken,
      'idempotency-key': 'client-1',
    });
    await mod.default(first.req, first.res);
    expect(first.state.statusCode).toBe(200);
    expect(harness.verifyCalls).toBe(1);

    const peer = makeReqRes(
      { ...validVerifyBody, mandate: 'A completely different mandate', sandbox: false },
      'POST',
      {
        'x-dql-account': other.accountToken,
        'idempotency-key': 'client-1',
      },
    );
    await mod.default(peer.req, peer.res);
    expect(peer.state.statusCode).toBe(200);
    expect(peer.state.jsonBody.axes).toHaveLength(5);
    expect(harness.verifyCalls).toBe(2);
    expect(await harness.store!.creditBalance(sha256Hex(funded.plaintext))).toBe(STARTER_CREDITS - 1);
    expect(await harness.store!.creditBalance(sha256Hex(other.plaintext))).toBe(STARTER_CREDITS - 1);
    expect(JSON.stringify(peer.state.jsonBody)).not.toContain(funded.plaintext);
    expect(JSON.stringify(peer.state.jsonBody)).not.toContain(other.accountToken);
  });

  it('parallel retries same id+payload: engine once; second is 409; credits -1', async () => {
    const minted = await mintStarter();
    const hash = sha256Hex(minted.plaintext);
    const mod = await import('../../../api/dql/verify.js');
    const headers = {
      'x-dql-account': minted.accountToken,
      'idempotency-key': 'parallel-same-id-01',
    };
    const a = makeReqRes({ ...validVerifyBody, sandbox: false }, 'POST', headers);
    const b = makeReqRes({ ...validVerifyBody, sandbox: false }, 'POST', headers);
    await Promise.all([mod.default(a.req, a.res), mod.default(b.req, b.res)]);
    const codes = [a.state.statusCode, b.state.statusCode].sort();
    expect(codes).toEqual([200, 409]);
    const conflict = a.state.statusCode === 409 ? a.state : b.state;
    expect(conflict.jsonBody.code).toBe('IDEMPOTENCY_IN_PROGRESS');
    expect(harness.verifyCalls).toBe(1);
    expect(await harness.store!.creditBalance(hash)).toBe(STARTER_CREDITS - 1);
    expect(await harness.store!.usageToday(hash)).toBe(1);
  });

  it('same id different payload is 409; no second engine; no extra debit', async () => {
    const minted = await mintStarter();
    const hash = sha256Hex(minted.plaintext);
    const mod = await import('../../../api/dql/verify.js');
    const headers = {
      'x-dql-account': minted.accountToken,
      'idempotency-key': 'payload-mismatch-01',
    };
    const first = makeReqRes({ ...validVerifyBody, sandbox: false }, 'POST', headers);
    await mod.default(first.req, first.res);
    expect(first.state.statusCode).toBe(200);
    const mismatch = makeReqRes(
      { ...validVerifyBody, mandate: 'A completely different mandate', sandbox: false },
      'POST',
      headers,
    );
    await mod.default(mismatch.req, mismatch.res);
    expect(mismatch.state.statusCode).toBe(409);
    expect(mismatch.state.jsonBody.code).toBe('IDEMPOTENCY_PAYLOAD_MISMATCH');
    expect(harness.verifyCalls).toBe(1);
    expect(await harness.store!.creditBalance(hash)).toBe(STARTER_CREDITS - 1);
  });

  it('expired held reservation is recovered and restores credit + cap', async () => {
    const minted = await mintStarter();
    const hash = sha256Hex(minted.plaintext);
    const t0 = new Date('2026-08-15T00:00:00.000Z');
    const digest = verifyPayloadDigest({
      ...validVerifyBody,
      axes: [...AXES],
      sandbox: false,
    });
    const held = await harness.store!.reserveVerify({
      requestId: 'ttl-recover-key-01',
      keyHash: hash,
      payloadDigest: digest,
      dailyCap: DEFAULT_DAILY_CAP,
      paygOptIn: false,
      now: t0,
    });
    expect(held.kind).toBe('ok');
    expect(await harness.store!.creditBalance(hash)).toBe(STARTER_CREDITS - 1);
    const later = new Date(t0.getTime() + 16 * 60 * 1000);
    expect(
      await harness.store!.recoverExpiredVerifyReservation({
        requestId: 'ttl-recover-key-01',
        keyHash: hash,
        now: later,
      }),
    ).toBe('released');
    expect(await harness.store!.creditBalance(hash)).toBe(STARTER_CREDITS);
    expect(await harness.store!.usageToday(hash, t0)).toBe(0);
    expect(harness.verifyCalls).toBe(0);
  });

  it('PAYG meter fail then retry remeters the stored result; engine once', async () => {
    harness.meterKind = 'error';
    const minted = await mintAccount('cs_payg', 'cus_payg', 'payg');
    const hash = sha256Hex(minted.plaintext);
    const mod = await import('../../../api/dql/verify.js');
    const headers = {
      'x-dql-account': minted.accountToken,
      'idempotency-key': 'payg-meter-fail-01',
    };
    const first = makeReqRes({ ...validVerifyBody, sandbox: false }, 'POST', headers);
    await mod.default(first.req, first.res);
    expect(first.state.statusCode).toBe(503);
    expect(first.state.jsonBody.code).toBe('METER_UNAVAILABLE');
    expect(first.state.jsonBody.axes).toBeUndefined();
    expect(harness.verifyCalls).toBe(1);
    expect(harness.meterCalls).toBe(1);
    expect(await harness.store!.usageToday(hash)).toBe(1);

    const stillDown = makeReqRes({ ...validVerifyBody, sandbox: false }, 'POST', headers);
    await mod.default(stillDown.req, stillDown.res);
    expect(stillDown.state.statusCode).toBe(503);
    expect(stillDown.state.jsonBody.code).toBe('METER_UNAVAILABLE');
    expect(stillDown.state.jsonBody.axes).toBeUndefined();
    expect(harness.verifyCalls).toBe(1);
    expect(harness.meterCalls).toBe(2);
    expect(await harness.store!.usageToday(hash)).toBe(1);

    harness.meterKind = 'ok';
    const retry = makeReqRes({ ...validVerifyBody, sandbox: false }, 'POST', headers);
    await mod.default(retry.req, retry.res);
    expect(retry.state.statusCode).toBe(200);
    expect(retry.state.jsonBody.axes).toHaveLength(5);
    expect(retry.state.headers['X-DQL-Meter']).toBe('ok');
    expect(harness.verifyCalls).toBe(1);
    expect(harness.meterCalls).toBe(3);
    expect(await harness.store!.usageToday(hash)).toBe(1);
  });

  it('changing context, structured_context, or gate_mode is 409 and does not replay', async () => {
    const minted = await mintStarter();
    const hash = sha256Hex(minted.plaintext);
    const mod = await import('../../../api/dql/verify.js');
    const headers = {
      'x-dql-account': minted.accountToken,
      'idempotency-key': 'digest-fields-01',
    };
    const first = makeReqRes({ ...validVerifyBody, sandbox: false }, 'POST', headers);
    await mod.default(first.req, first.res);
    expect(first.state.statusCode).toBe(200);
    const storedId = first.state.jsonBody.id;

    const contextChange = makeReqRes(
      { ...validVerifyBody, context: 'prior tool output that changes the verdict', sandbox: false },
      'POST',
      headers,
    );
    await mod.default(contextChange.req, contextChange.res);
    expect(contextChange.state.statusCode).toBe(409);
    expect(contextChange.state.jsonBody.code).toBe('IDEMPOTENCY_PAYLOAD_MISMATCH');
    expect(contextChange.state.jsonBody.id).toBeUndefined();

    const structuredChange = makeReqRes(
      {
        ...validVerifyBody,
        structured_context: { granted: { max_amount: 10 }, proposed: { amount: 50 } },
        sandbox: false,
      },
      'POST',
      headers,
    );
    await mod.default(structuredChange.req, structuredChange.res);
    expect(structuredChange.state.statusCode).toBe(409);
    expect(structuredChange.state.jsonBody.code).toBe('IDEMPOTENCY_PAYLOAD_MISMATCH');

    const gateChange = makeReqRes(
      { ...validVerifyBody, gate_mode: 'enforce', sandbox: false },
      'POST',
      headers,
    );
    await mod.default(gateChange.req, gateChange.res);
    expect(gateChange.state.statusCode).toBe(409);
    expect(gateChange.state.jsonBody.code).toBe('IDEMPOTENCY_PAYLOAD_MISMATCH');

    expect(harness.verifyCalls).toBe(1);
    expect(await harness.store!.creditBalance(hash)).toBe(STARTER_CREDITS - 1);
    const replay = makeReqRes({ ...validVerifyBody, sandbox: false }, 'POST', headers);
    await mod.default(replay.req, replay.res);
    expect(replay.state.statusCode).toBe(200);
    expect(replay.state.jsonBody.id).toBe(storedId);
    expect(harness.verifyCalls).toBe(1);
  });

  it('commit EVAL failure is not 200 and does not fake a durable commit', async () => {
    const minted = await mintStarter();
    const hash = sha256Hex(minted.plaintext);
    const kv = harness.kv!;
    const orig = kv.eval.bind(kv);
    kv.eval = (script, keys, args) => {
      if (String(script).includes('DQL_COMMIT_V3')) return Promise.reject(new Error('EVAL failed'));
      return orig(script, keys, args);
    };
    const mod = await import('../../../api/dql/verify.js');
    const headers = {
      'x-dql-account': minted.accountToken,
      'idempotency-key': 'commit-fail-01',
    };
    const first = makeReqRes({ ...validVerifyBody, sandbox: false }, 'POST', headers);
    await mod.default(first.req, first.res);
    expect(first.state.statusCode).toBe(503);
    expect(first.state.jsonBody.code).toBe('COMMIT_UNAVAILABLE');
    expect(first.state.jsonBody.axes).toBeUndefined();
    expect(harness.verifyCalls).toBe(1);
    expect(await harness.store!.creditBalance(hash)).toBe(STARTER_CREDITS - 1);
    expect(await harness.store!.usageToday(hash)).toBe(1);

    const retry = makeReqRes({ ...validVerifyBody, sandbox: false }, 'POST', headers);
    await mod.default(retry.req, retry.res);
    expect(retry.state.statusCode).toBe(409);
    expect(retry.state.jsonBody.code).toBe('IDEMPOTENCY_IN_PROGRESS');
    expect(harness.verifyCalls).toBe(1);
    expect(await harness.store!.creditBalance(hash)).toBe(STARTER_CREDITS - 1);
  });
});
