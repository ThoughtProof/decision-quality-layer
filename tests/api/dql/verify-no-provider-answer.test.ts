/**
 * Credit / meter / x402 must not run when the engine reports no provider
 * answer. A genuine served UNCERTAIN, ALLOW, and BLOCK still commit.
 * Replay after a successful release is not 409 and does not keep a debit.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { finalizeCheckoutMint } from '../../../src/auth/checkout.js';
import { sha256Hex } from '../../../src/auth/key-hash.js';
import { UpstashKeyStore, createMemoryKv, selfServeOwner } from '../../../src/auth/key-store.js';
import { STARTER_CREDITS } from '../../../src/auth/packs.js';

type Mode = 'outage' | 'http' | 'deadline' | 'abort' | 'uncertain' | 'allow' | 'block';
type PartialFail = 'outage' | 'http' | 'deadline';

const harness = vi.hoisted(() => ({
  store: null as InstanceType<typeof UpstashKeyStore> | null,
  mode: 'outage' as Mode,
  /** When set, `intent` is served and `scope` fails. Null keeps `mode` for every axis. */
  partial: null as PartialFail | null,
  runs: 0,
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
      return { kind: 'ok' as const, event_name: 'dql_verify_call' };
    },
  };
});

vi.mock('../../../src/engine/cascade.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/engine/cascade.js')>();
  class ScriptedStub extends actual.StubCascade {
    override async run(input: { axis: import('../../../src/types.js').Axis }) {
      harness.runs += 1;
      // Re-import on each call so the thrown classes match the engine copy
      // after vi.resetModules() (instanceof would otherwise miss).
      const llm = await import('../../../src/engine/llm-client.js');
      if (harness.partial && input.axis === 'intent') {
        return {
          result: {
            axis: input.axis,
            verdict: 'PASS' as const,
            confidence: 0.9,
            reasoning: 'scripted provider answer',
            objection: '',
            provider_outcome: 'served' as const,
            provider_route: 'primary' as const,
          },
          modelsUsed: ['serv:scripted'],
        };
      }
      const failKind = harness.partial ?? harness.mode;
      if (failKind === 'outage') {
        throw new llm.CircuitAllOpenError('serv-nano', 'serv-swift', 'open', 'open', []);
      }
      if (failKind === 'http') {
        throw new llm.ProviderCallError('[llm-client] serv 503: unavailable', 'serv', 503);
      }
      if (failKind === 'deadline') {
        throw new llm.DeadlineExceededError(
          '[llm-client] request deadline exhausted',
          'serv',
          'request_deadline',
        );
      }
      if (!harness.partial && harness.mode === 'abort') {
        const err = new Error('The operation was aborted');
        err.name = 'AbortError';
        throw err;
      }
      const verdict =
        harness.mode === 'allow' ? 'PASS' : harness.mode === 'block' ? 'FAIL' : 'UNCERTAIN';
      const confidence = harness.mode === 'block' ? 0.95 : harness.mode === 'allow' ? 0.9 : 0.4;
      return {
        result: {
          axis: input.axis,
          verdict,
          confidence,
          reasoning: 'scripted provider answer',
          objection: verdict === 'PASS' ? '' : 'noted',
          provider_outcome: 'served' as const,
          provider_route: 'primary' as const,
        },
        modelsUsed: ['serv:scripted'],
      };
    }
  }
  return { ...actual, StubCascade: ScriptedStub };
});

function makeReqRes(body?: unknown, headers: Record<string, string> = {}) {
  const req = {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body,
  } as any;
  const state: { statusCode: number; jsonBody?: any; headers: Record<string, string> } = {
    statusCode: 200,
    headers: {},
  };
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

const body = {
  mandate: 'Book a refundable fare',
  proposed_action: 'Book the refundable fare as specified',
  reasoning: 'Matches the mandate and stays reversible',
  axes: ['intent'],
  sandbox: false,
};

function instrument(store: UpstashKeyStore) {
  const counts = { commit: 0, release: 0, pending: 0 };
  const commit = store.commitVerifyReservation.bind(store);
  const release = store.releaseVerifyReservation.bind(store);
  const pending = store.persistMeterPending.bind(store);
  store.commitVerifyReservation = async (opts) => {
    counts.commit += 1;
    return commit(opts);
  };
  store.releaseVerifyReservation = async (opts) => {
    counts.release += 1;
    return release(opts);
  };
  store.persistMeterPending = async (opts) => {
    counts.pending += 1;
    return pending(opts);
  };
  return counts;
}

describe.sequential('POST /dql/verify — no provider answer is not billed', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
    for (const k of Object.keys(process.env)) {
      if (
        k.startsWith('DQL_') ||
        k === 'SERV_API_KEY' ||
        k === 'SERV_BASE_URL' ||
        k.startsWith('UPSTASH_') ||
        k.startsWith('STRIPE_') ||
        k === 'X402_FACILITATOR_URL'
      ) {
        delete process.env[k];
      }
    }
    harness.store = new UpstashKeyStore(createMemoryKv());
    harness.mode = 'outage';
    harness.partial = null;
    harness.runs = 0;
    harness.meterCalls = 0;
  });

  afterEach(() => {
    process.env = originalEnv;
    harness.store = null;
    vi.unstubAllGlobals();
  });

  async function mint(pack: 'starter' | 'payg' = 'starter') {
    const minted = await finalizeCheckoutMint({
      sessionId: `cs_${pack}_${harness.runs}`,
      customerId: `cus_${pack}`,
      owner: selfServeOwner(`cus_${pack}`),
      store: harness.store!,
      pack,
    });
    expect(minted.kind).toBe('minted');
    if (minted.kind !== 'minted') throw new Error('mint failed');
    return minted;
  }

  async function post(headers: Record<string, string>, requestBody: unknown = body) {
    const mod = await import('../../../api/dql/verify.js');
    const made = makeReqRes(requestBody, headers);
    await mod.default(made.req, made.res);
    return made.state;
  }

  const partialBody = {
    ...body,
    axes: ['intent', 'scope'],
  };

  function expectPartialBillable(state: { statusCode: number; jsonBody: any }, failedOutcome: string) {
    expect(state.statusCode).toBe(200);
    const axes = state.jsonBody.axes as Array<{
      axis: string;
      verdict: string;
      provider_outcome?: string;
    }>;
    const served = axes.find((axis) => axis.axis === 'intent');
    const failed = axes.find((axis) => axis.axis === 'scope');
    expect(served?.provider_outcome).toBe('served');
    expect(served?.verdict).toBe('PASS');
    expect(failed?.verdict).toBe('UNCERTAIN');
    expect(failed?.provider_outcome).toBe(failedOutcome);
    expect(state.jsonBody.meta.no_provider_answer).toBeUndefined();
    expect(state.jsonBody.aggregate.verdict).not.toBe('ALLOW');
    expect(JSON.stringify(state.jsonBody)).not.toMatch(/dqlk_|dqla_/);
  }

  it.each([
    ['outage', 'outage'],
    ['http', 'http_error'],
    ['deadline', 'deadline'],
    ['abort', 'abort'],
  ] as const)('%s releases, does not commit or meter, verdict UNCERTAIN', async (mode, reason) => {
    harness.mode = mode;
    const minted = await mint();
    const hash = sha256Hex(minted.plaintext);
    const counts = instrument(harness.store!);
    const state = await post({
      'x-dql-account': minted.accountToken,
      'idempotency-key': `no-answer-${mode}`,
    });

    expect(state.statusCode).toBe(200);
    expect(state.jsonBody.axes[0].verdict).toBe('UNCERTAIN');
    expect(state.jsonBody.aggregate.verdict).not.toBe('ALLOW');
    expect(state.jsonBody.meta.no_provider_answer).toEqual({ reasons: [reason] });
    expect(counts.release).toBe(1);
    expect(counts.commit).toBe(0);
    expect(counts.pending).toBe(0);
    expect(harness.meterCalls).toBe(0);
    expect(state.headers['X-DQL-Meter']).toBeUndefined();
    expect(await harness.store!.creditBalance(hash)).toBe(STARTER_CREDITS);
    expect(await harness.store!.usageToday(hash)).toBe(0);
    expect(JSON.stringify(state.jsonBody)).not.toMatch(/dqlk_|dqla_/);
  });

  it('PAYG outage does not meter and restores the daily cap', async () => {
    harness.mode = 'outage';
    const minted = await mint('payg');
    const hash = sha256Hex(minted.plaintext);
    const counts = instrument(harness.store!);
    const state = await post({
      'x-dql-account': minted.accountToken,
      'idempotency-key': 'payg-outage-01',
    });
    expect(state.statusCode).toBe(200);
    expect(state.jsonBody.axes[0].verdict).toBe('UNCERTAIN');
    expect(state.jsonBody.meta.no_provider_answer.reasons).toEqual(['outage']);
    expect(counts.release).toBe(1);
    expect(counts.commit).toBe(0);
    expect(counts.pending).toBe(0);
    expect(harness.meterCalls).toBe(0);
    expect(await harness.store!.usageToday(hash)).toBe(0);
    expect(await harness.store!.creditBalance(hash)).toBe(0);
  });

  it('x402 HTTP 5xx does not settle', async () => {
    harness.mode = 'http';
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).includes('/settle')) {
        throw new Error('settle must not be called');
      }
      if (String(url).includes('/verify')) {
        return { ok: true, status: 200, json: async () => ({ isValid: true }), text: async () => '' };
      }
      return { ok: true, status: 200, json: async () => ({}), text: async () => '' };
    });
    vi.stubGlobal('fetch', fetchMock);
    process.env.DQL_X402_ENABLED = 'true';
    process.env.X402_FACILITATOR_URL = 'https://fac.example';
    const sig = Buffer.from(JSON.stringify({ network: 'base', payload: { authorization: { nonce: 'n-na' } } })).toString(
      'base64',
    );
    const state = await post({ 'payment-signature': sig });
    expect(state.statusCode).toBe(200);
    expect(state.jsonBody.axes[0].verdict).toBe('UNCERTAIN');
    expect(state.jsonBody.aggregate.verdict).not.toBe('ALLOW');
    expect(state.jsonBody.meta.no_provider_answer).toEqual({ reasons: ['http_error'] });
    expect(state.headers['X-DQL-Billing']).not.toBe('x402');
    const urls = fetchMock.mock.calls.map((call) => String(call[0]));
    expect(urls.some((url) => url.includes('/verify'))).toBe(true);
    expect(urls.some((url) => url.includes('/settle'))).toBe(false);
    expect(harness.meterCalls).toBe(0);
  });

  it('env-key deadline does not emit a Stripe meter', async () => {
    harness.mode = 'deadline';
    process.env.DQL_API_KEYS = JSON.stringify({
      dqlk_test_bill_key_000000000000000: {
        owner: 'acme',
        dev_access: false,
        daily_cap: 1000,
      },
    });
    process.env.DQL_STRIPE_METER_ENABLED = 'true';
    process.env.STRIPE_SECRET_KEY = 'sk_test_x';
    process.env.DQL_STRIPE_CUSTOMER_MAP = JSON.stringify({ acme: 'cus_test123' });
    const state = await post({ 'x-dql-key': 'dqlk_test_bill_key_000000000000000' });
    expect(state.statusCode).toBe(200);
    expect(state.jsonBody.axes[0].verdict).toBe('UNCERTAIN');
    expect(state.jsonBody.meta.no_provider_answer).toEqual({ reasons: ['deadline'] });
    expect(harness.meterCalls).toBe(0);
    expect(state.headers['X-DQL-Meter']).toBeUndefined();
  });

  it('genuine served UNCERTAIN commits (founder decision: still billable)', async () => {
    harness.mode = 'uncertain';
    const minted = await mint();
    const hash = sha256Hex(minted.plaintext);
    const counts = instrument(harness.store!);
    const state = await post({
      'x-dql-account': minted.accountToken,
      'idempotency-key': 'genuine-uncertain-01',
    });
    expect(state.statusCode).toBe(200);
    expect(state.jsonBody.axes[0].verdict).toBe('UNCERTAIN');
    expect(state.jsonBody.axes[0].provider_outcome).toBe('served');
    expect(state.jsonBody.meta.no_provider_answer).toBeUndefined();
    expect(counts.commit).toBe(1);
    expect(counts.release).toBe(0);
    expect(await harness.store!.creditBalance(hash)).toBe(STARTER_CREDITS - 1);
  });

  it.each(['allow', 'block'] as const)('%s commits as before', async (mode) => {
    harness.mode = mode;
    const minted = await mint();
    const hash = sha256Hex(minted.plaintext);
    const counts = instrument(harness.store!);
    const state = await post({
      'x-dql-account': minted.accountToken,
      'idempotency-key': `billable-${mode}`,
    });
    expect(state.statusCode).toBe(200);
    expect(state.jsonBody.aggregate.verdict).toBe(mode === 'allow' ? 'ALLOW' : 'BLOCK');
    expect(state.jsonBody.meta.no_provider_answer).toBeUndefined();
    expect(counts.commit).toBe(1);
    expect(counts.release).toBe(0);
    expect(harness.meterCalls).toBe(0);
    expect(await harness.store!.creditBalance(hash)).toBe(STARTER_CREDITS - 1);
  });

  it('replay after release is not 409 and does not double-charge', async () => {
    const minted = await mint();
    const hash = sha256Hex(minted.plaintext);
    const counts = instrument(harness.store!);
    const headers = {
      'x-dql-account': minted.accountToken,
      'idempotency-key': 'replay-after-release-01',
    };

    harness.mode = 'outage';
    const first = await post(headers);
    expect(first.statusCode).toBe(200);
    expect(first.jsonBody.axes[0].verdict).toBe('UNCERTAIN');
    expect(first.jsonBody.meta.no_provider_answer.reasons).toEqual(['outage']);

    harness.mode = 'http';
    const second = await post(headers);
    expect(second.statusCode).toBe(200);
    expect(second.statusCode).not.toBe(409);
    expect(second.jsonBody.meta.no_provider_answer.reasons).toEqual(['http_error']);
    expect(await harness.store!.creditBalance(hash)).toBe(STARTER_CREDITS);
    expect(await harness.store!.usageToday(hash)).toBe(0);
    expect(counts.commit).toBe(0);
    expect(counts.release).toBe(2);
    expect(harness.runs).toBe(2);

    harness.mode = 'allow';
    const recovered = await post(headers);
    expect(recovered.statusCode).toBe(200);
    expect(recovered.jsonBody.aggregate.verdict).toBe('ALLOW');
    expect(counts.commit).toBe(1);
    expect(await harness.store!.creditBalance(hash)).toBe(STARTER_CREDITS - 1);
    expect(harness.runs).toBe(3);

    const replay = await post(headers);
    expect(replay.statusCode).toBe(200);
    expect(replay.jsonBody.id).toBe(recovered.jsonBody.id);
    expect(harness.runs).toBe(3);
    expect(counts.commit).toBe(1);
    expect(await harness.store!.creditBalance(hash)).toBe(STARTER_CREDITS - 1);
    expect(harness.meterCalls).toBe(0);
  });

  it.each([
    ['outage', 'circuit_rejected'],
    ['http', 'provider_error'],
    ['deadline', 'provider_error'],
  ] as const)(
    'partial %s is billed in full (founder decision: never pro rata)',
    async (fail, failedOutcome) => {
      harness.partial = fail;
      const counts = instrument(harness.store!);

      const credit = await mint();
      const creditHash = sha256Hex(credit.plaintext);
      const creditState = await post(
        { 'x-dql-account': credit.accountToken, 'idempotency-key': `partial-credit-${fail}` },
        partialBody,
      );
      expectPartialBillable(creditState, failedOutcome);
      expect(counts.commit).toBe(1);
      expect(counts.release).toBe(0);
      expect(harness.meterCalls).toBe(0);
      expect(await harness.store!.creditBalance(creditHash)).toBe(STARTER_CREDITS - 1);
      expect(await harness.store!.usageToday(creditHash)).toBe(1);

      harness.meterCalls = 0;
      const payg = await mint('payg');
      const paygHash = sha256Hex(payg.plaintext);
      const paygState = await post(
        { 'x-dql-account': payg.accountToken, 'idempotency-key': `partial-payg-${fail}` },
        partialBody,
      );
      expectPartialBillable(paygState, failedOutcome);
      expect(paygState.headers['X-DQL-Meter']).toBe('ok');
      expect(counts.commit).toBe(2);
      expect(counts.release).toBe(0);
      expect(counts.pending).toBe(1);
      expect(harness.meterCalls).toBe(1);
      expect(await harness.store!.creditBalance(paygHash)).toBe(0);
      expect(await harness.store!.usageToday(paygHash)).toBe(1);
      expect(await harness.store!.creditBalance(creditHash)).toBe(STARTER_CREDITS - 1);

      harness.meterCalls = 0;
      const fetchMock = vi.fn(async (url: string) => {
        if (String(url).includes('/settle')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({ success: true, transaction: '0xpartial' }),
            text: async () => '',
          };
        }
        if (String(url).includes('/verify')) {
          return { ok: true, status: 200, json: async () => ({ isValid: true }), text: async () => '' };
        }
        return { ok: true, status: 200, json: async () => ({}), text: async () => '' };
      });
      vi.stubGlobal('fetch', fetchMock);
      process.env.DQL_X402_ENABLED = 'true';
      process.env.X402_FACILITATOR_URL = 'https://fac.example';
      const sig = Buffer.from(
        JSON.stringify({ network: 'base', payload: { authorization: { nonce: `n-partial-${fail}` } } }),
      ).toString('base64');
      const x402 = await post({ 'payment-signature': sig }, partialBody);
      expectPartialBillable(x402, failedOutcome);
      expect(x402.headers['X-DQL-Billing']).toBe('x402');
      const urls = fetchMock.mock.calls.map((call) => String(call[0]));
      expect(urls.filter((url) => url.includes('/settle'))).toHaveLength(1);
      expect(harness.meterCalls).toBe(0);
      expect(counts.release).toBe(0);
      expect(counts.commit).toBe(2);
    },
  );

  it('release failure is logged without secrets and leaves the hold for sweep', async () => {
    harness.mode = 'abort';
    const minted = await mint();
    const hash = sha256Hex(minted.plaintext);
    const counts = instrument(harness.store!);
    harness.store!.releaseVerifyReservation = async () => {
      counts.release += 1;
      throw new Error('redis unavailable');
    };
    const errors: string[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((line: unknown) => {
      errors.push(String(line));
    });

    const headers = {
      'x-dql-account': minted.accountToken,
      'idempotency-key': 'release-fail-01',
    };
    const state = await post(headers);
    expect(state.statusCode).toBe(200);
    expect(state.jsonBody.axes[0].verdict).toBe('UNCERTAIN');
    expect(state.jsonBody.aggregate.verdict).not.toBe('ALLOW');
    expect(state.jsonBody.meta.no_provider_answer).toEqual({ reasons: ['abort'] });
    expect(counts.commit).toBe(0);
    expect(counts.release).toBe(1);
    expect(harness.meterCalls).toBe(0);
    expect(await harness.store!.creditBalance(hash)).toBe(STARTER_CREDITS - 1);

    const logged = errors.filter((line) => line.includes('dql_reservation_release'));
    expect(logged.length).toBe(1);
    const event = JSON.parse(logged[0]!) as {
      type: string;
      outcome: string;
      reason: string;
      request_id: string;
    };
    expect(event).toMatchObject({
      type: 'dql_reservation_release',
      outcome: 'error',
      reason: 'no_provider_answer',
      request_id: 'release-fail-01',
    });
    expect(logged[0]).not.toMatch(/dqlk_|dqla_|sk_|redis unavailable/);

    const replay = await post(headers);
    expect(replay.statusCode).toBe(409);
    expect(replay.jsonBody.code).toBe('IDEMPOTENCY_IN_PROGRESS');
    expect(harness.runs).toBe(1);
    expect(await harness.store!.creditBalance(hash)).toBe(STARTER_CREDITS - 1);

    spy.mockRestore();
  });
});
