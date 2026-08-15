import { createHmac } from 'node:crypto';
import { describe, it, expect, vi } from 'vitest';
import { authorizeCall, parseApiKeys, type UsageGate } from './keys.js';
import {
  createCheckoutSession,
  finalizeCheckoutMint,
  handleStripeWebhookEvent,
  loadCheckoutConfig,
} from './checkout.js';
import { UpstashKeyStore, createMemoryKv, selfServeOwner } from './key-store.js';
import { emitStripeMeterEvent, STRIPE_METER_EVENT_NAME } from './stripe-meter.js';
import { PLUS_CREDITS, STARTER_CREDITS, TRIAL_CREDITS } from './packs.js';
import { sha256Hex } from './key-hash.js';

const allowGate: UsageGate = { checkAndRecord: async () => true };

function sign(payload: string, secret: string, t: number): string {
  const hex = createHmac('sha256', secret).update(`${t}.${payload}`, 'utf8').digest('hex');
  return `t=${t},v1=${hex}`;
}

function stripeFetch(handlers: Record<string, (init?: RequestInit) => unknown>): typeof fetch {
  return vi.fn(async (url: string, init?: RequestInit) => {
    const u = String(url);
    for (const [needle, fn] of Object.entries(handlers)) {
      if (u.includes(needle)) {
        const body = await fn(init);
        return { ok: true, status: 200, json: async () => body };
      }
    }
    throw new Error(`unexpected ${u}`);
  }) as unknown as typeof fetch;
}

describe('prepaid packs + trial ledger', () => {
  it('starter mint → N credits → N verifies decrement → N+1 CREDITS_EXHAUSTED', async () => {
    const store = new UpstashKeyStore(createMemoryKv());
    const minted = await finalizeCheckoutMint({
      sessionId: 'cs_starter',
      customerId: 'cus_starter',
      owner: selfServeOwner('cus_starter'),
      store,
      pack: 'starter',
    });
    expect(minted.kind).toBe('minted');
    if (minted.kind !== 'minted') return;
    expect(minted.credits_added).toBe(STARTER_CREDITS);
    expect(minted.trial).toBe(false);
    expect(await store.creditBalance(sha256Hex(minted.plaintext))).toBe(STARTER_CREDITS);

    const ledger = await store.getCreditLedger(sha256Hex(minted.plaintext));
    expect(ledger?.grants[0]?.trial).toBe(false);
    expect(ledger?.grants[0]?.pack).toBe('starter');
    expect(ledger?.grants[0]?.credits).toBe(STARTER_CREDITS);

    const rec = await store.getRecordByHash(sha256Hex(minted.plaintext));
    expect(rec?.trial).toBe(false);
    expect(rec?.payg_opt_in).toBe(false);

    for (let i = 0; i < STARTER_CREDITS; i += 1) {
      const d = await authorizeCall({
        headers: { 'x-dql-key': minted.plaintext },
        sandbox: false,
        keys: new Map(),
        usage: allowGate,
        store,
      });
      expect(d.kind).toBe('allow');
      if (d.kind === 'allow') expect(d.billing).toBe('credit');
    }

    const stop = await authorizeCall({
      headers: { 'x-dql-key': minted.plaintext },
      sandbox: false,
      keys: new Map(),
      usage: allowGate,
      store,
    });
    expect(stop.kind).toBe('deny');
    if (stop.kind !== 'deny') return;
    expect(stop.status).toBe(402);
    expect(stop.payload.code).toBe('CREDITS_EXHAUSTED');
    expect(stop.payload.no_freemium).toBe(true);
    expect(await store.creditBalance(sha256Hex(minted.plaintext))).toBe(0);
  });

  it('plus pack grants 1000 paid credits (not trial)', async () => {
    const store = new UpstashKeyStore(createMemoryKv());
    const minted = await finalizeCheckoutMint({
      sessionId: 'cs_plus',
      customerId: 'cus_plus',
      owner: selfServeOwner('cus_plus'),
      store,
      pack: 'plus',
    });
    expect(minted.kind).toBe('minted');
    if (minted.kind !== 'minted') return;
    expect(minted.credits_added).toBe(PLUS_CREDITS);
    const ledger = await store.getCreditLedger(sha256Hex(minted.plaintext));
    expect(ledger?.grants[0]?.trial).toBe(false);
    expect((await store.getRecordByHash(sha256Hex(minted.plaintext)))?.trial).toBe(false);
  });

  it('PAYG opt-in grants no credits and meters; does not hard-stop at 0', async () => {
    const store = new UpstashKeyStore(createMemoryKv());
    const minted = await finalizeCheckoutMint({
      sessionId: 'cs_payg',
      customerId: 'cus_payg',
      owner: selfServeOwner('cus_payg'),
      store,
      pack: 'payg',
    });
    expect(minted.kind).toBe('minted');
    if (minted.kind !== 'minted') return;
    expect(minted.credits_added).toBe(0);
    expect(await store.creditBalance(sha256Hex(minted.plaintext))).toBe(0);
    expect((await store.getRecordByHash(sha256Hex(minted.plaintext)))?.payg_opt_in).toBe(true);

    const auth = await authorizeCall({
      headers: { 'x-dql-key': minted.plaintext },
      sandbox: false,
      keys: new Map(),
      usage: allowGate,
      store,
    });
    expect(auth.kind).toBe('allow');
    if (auth.kind !== 'allow') return;
    expect(auth.billing).toBe('payg');

    const meter = await emitStripeMeterEvent({
      requestId: 'dql_payg_meter',
      owner: auth.record.owner,
      customerId: auth.record.stripe_customer_id,
      fetchImpl: (async () => ({
        ok: true,
        status: 200,
        json: async () => ({ identifier: 'dql_payg_meter' }),
        text: async () => '',
      })) as unknown as typeof fetch,
      config: {
        enabled: true,
        secretKey: 'sk_test',
        eventName: STRIPE_METER_EVENT_NAME,
        customerByOwner: new Map(),
      },
    });
    expect(meter.kind).toBe('ok');
  });

  it('daily-cap still trips before credits are spent', async () => {
    const store = new UpstashKeyStore(createMemoryKv());
    const minted = await finalizeCheckoutMint({
      sessionId: 'cs_cap',
      customerId: 'cus_cap',
      owner: selfServeOwner('cus_cap'),
      store,
      pack: 'starter',
    });
    expect(minted.kind).toBe('minted');
    if (minted.kind !== 'minted') return;

    const denyGate: UsageGate = { checkAndRecord: async () => false };
    const d = await authorizeCall({
      headers: { 'x-dql-key': minted.plaintext },
      sandbox: false,
      keys: new Map(),
      usage: denyGate,
      store,
    });
    expect(d.kind).toBe('deny');
    if (d.kind !== 'deny') return;
    expect(d.status).toBe(429);
    expect(d.payload.code).toBe('QUOTA_EXCEEDED');
    expect(await store.creditBalance(sha256Hex(minted.plaintext))).toBe(STARTER_CREDITS);
  });

  it('never mints a second live key for the same Stripe customer; adds credits instead', async () => {
    const store = new UpstashKeyStore(createMemoryKv());
    const first = await finalizeCheckoutMint({
      sessionId: 'cs_one',
      customerId: 'cus_same',
      owner: selfServeOwner('cus_same'),
      store,
      pack: 'starter',
    });
    expect(first.kind).toBe('minted');
    if (first.kind !== 'minted') return;

    const second = await finalizeCheckoutMint({
      sessionId: 'cs_two',
      customerId: 'cus_same',
      owner: selfServeOwner('cus_same'),
      store,
      pack: 'plus',
    });
    expect(second.kind).toBe('credits_added');
    if (second.kind !== 'credits_added') return;
    expect(second.credits_added).toBe(PLUS_CREDITS);
    expect(second.balance).toBe(STARTER_CREDITS + PLUS_CREDITS);
    expect(await store.getKeyHashByCustomer('cus_same')).toBe(sha256Hex(first.plaintext));

    const ledger = await store.getCreditLedger(sha256Hex(first.plaintext));
    expect(ledger?.grants.map((g) => g.pack)).toEqual(['starter', 'plus']);
    expect(ledger?.grants.every((g) => g.trial === false)).toBe(true);
  });

  it('trial grants 5 credits marked trial=true; hard-stop after; not the paid path', async () => {
    const store = new UpstashKeyStore(createMemoryKv());
    const minted = await finalizeCheckoutMint({
      sessionId: 'cs_trial',
      customerId: 'cus_trial',
      owner: selfServeOwner('cus_trial'),
      store,
      pack: 'trial',
      emailNormalized: 'first@example.com',
      cardFingerprint: 'fp_trial_1',
    });
    expect(minted.kind).toBe('minted');
    if (minted.kind !== 'minted') return;
    expect(minted.credits_added).toBe(TRIAL_CREDITS);
    expect(minted.trial).toBe(true);

    const rec = await store.getRecordByHash(sha256Hex(minted.plaintext));
    expect(rec?.trial).toBe(true);
    expect(rec?.payg_opt_in).toBe(false);
    const ledger = await store.getCreditLedger(sha256Hex(minted.plaintext));
    expect(ledger?.grants[0]?.trial).toBe(true);
    expect(ledger?.grants[0]?.credits).toBe(5);

    for (let i = 0; i < TRIAL_CREDITS; i += 1) {
      const d = await authorizeCall({
        headers: { 'x-dql-key': minted.plaintext },
        sandbox: false,
        keys: new Map(),
        usage: allowGate,
        store,
      });
      expect(d.kind).toBe('allow');
      if (d.kind === 'allow') expect(d.billing).toBe('credit');
    }
    const stop = await authorizeCall({
      headers: { 'x-dql-key': minted.plaintext },
      sandbox: false,
      keys: new Map(),
      usage: allowGate,
      store,
    });
    expect(stop.kind).toBe('deny');
    if (stop.kind === 'deny') expect(stop.payload.code).toBe('CREDITS_EXHAUSTED');
  });

  it('trial without card fingerprint fails closed (no credits)', async () => {
    const store = new UpstashKeyStore(createMemoryKv());
    const r = await finalizeCheckoutMint({
      sessionId: 'cs_nocard',
      customerId: 'cus_nocard',
      owner: selfServeOwner('cus_nocard'),
      store,
      pack: 'trial',
      emailNormalized: 'cardless@example.com',
    });
    expect(r.kind).toBe('trial_no_card');
    expect(await store.getKeyHashByCustomer('cus_nocard')).toBeUndefined();
  });

  it('reuse of email or card fingerprint burns the trial (409 path)', async () => {
    const store = new UpstashKeyStore(createMemoryKv());
    const first = await finalizeCheckoutMint({
      sessionId: 'cs_t1',
      customerId: 'cus_t1',
      owner: selfServeOwner('cus_t1'),
      store,
      pack: 'trial',
      emailNormalized: 'same@example.com',
      cardFingerprint: 'fp_aaa',
    });
    expect(first.kind).toBe('minted');

    const emailReuse = await finalizeCheckoutMint({
      sessionId: 'cs_t2',
      customerId: 'cus_t2',
      owner: selfServeOwner('cus_t2'),
      store,
      pack: 'trial',
      emailNormalized: 'same@example.com',
      cardFingerprint: 'fp_bbb',
    });
    expect(emailReuse.kind).toBe('trial_used');
    expect(await store.getKeyHashByCustomer('cus_t2')).toBeUndefined();

    const fpReuse = await finalizeCheckoutMint({
      sessionId: 'cs_t3',
      customerId: 'cus_t3',
      owner: selfServeOwner('cus_t3'),
      store,
      pack: 'trial',
      emailNormalized: 'other@example.com',
      cardFingerprint: 'fp_aaa',
    });
    expect(fpReuse.kind).toBe('trial_used');
  });

  it('paid pack after trial stays distinguishable on the ledger', async () => {
    const store = new UpstashKeyStore(createMemoryKv());
    const trial = await finalizeCheckoutMint({
      sessionId: 'cs_mix_t',
      customerId: 'cus_mix',
      owner: selfServeOwner('cus_mix'),
      store,
      pack: 'trial',
      emailNormalized: 'mix@example.com',
      cardFingerprint: 'fp_mix',
    });
    expect(trial.kind).toBe('minted');
    if (trial.kind !== 'minted') return;

    const paid = await finalizeCheckoutMint({
      sessionId: 'cs_mix_p',
      customerId: 'cus_mix',
      owner: selfServeOwner('cus_mix'),
      store,
      pack: 'starter',
    });
    expect(paid.kind).toBe('credits_added');
    const ledger = await store.getCreditLedger(sha256Hex(trial.plaintext));
    expect(ledger?.grants).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ pack: 'trial', trial: true, credits: 5 }),
        expect.objectContaining({ pack: 'starter', trial: false, credits: 200 }),
      ]),
    );
    expect((await store.getRecordByHash(sha256Hex(trial.plaintext)))?.trial).toBe(true);
  });

  it('env canary still meters (credits do not apply to env keys)', async () => {
    const store = new UpstashKeyStore(createMemoryKv());
    const canaryKey = 'dqlk_canary_bootstrap_cccccccccccc';
    const envKeys = parseApiKeys(
      JSON.stringify({
        [canaryKey]: { owner: 'dql-canary', dev_access: false, daily_cap: 50 },
      }),
    );
    const d = await authorizeCall({
      headers: { 'x-dql-key': canaryKey },
      sandbox: false,
      keys: envKeys,
      usage: allowGate,
      store,
    });
    expect(d.kind).toBe('allow');
    if (d.kind === 'allow') expect(d.billing).toBe('env-metered');
  });
});

describe('createCheckoutSession pack modes', () => {
  const baseEnv = {
    DQL_CHECKOUT_ENABLED: 'true',
    STRIPE_SECRET_KEY: 'sk_test_x',
    DQL_PUBLIC_BASE_URL: 'https://dql.thoughtproof.ai',
  };

  it('starter without price env → unconfigured missing_pack_price', async () => {
    const store = new UpstashKeyStore(createMemoryKv());
    const r = await createCheckoutSession({
      email: 'a@b.co',
      pack: 'starter',
      store,
      config: loadCheckoutConfig(baseEnv),
      fetchImpl: (async () => {
        throw new Error('stripe must not be called');
      }) as unknown as typeof fetch,
    });
    expect(r).toEqual({ kind: 'unconfigured', reason: 'missing_pack_price' });
  });

  it('starter with price env uses mode=payment and does not hardcode price ids', async () => {
    const store = new UpstashKeyStore(createMemoryKv());
    const fetchImpl = stripeFetch({
      '/customers': (init) =>
        (init?.method ?? 'GET') === 'GET' ? { data: [] } : { id: 'cus_pack' },
      '/checkout/sessions': (init) => {
        const body = String(init?.body);
        expect(body).toContain('mode=payment');
        expect(body).toContain('price_test_starter');
        expect(body).toContain('starter');
        expect(body).toContain('200');
        expect(body).toContain(
          encodeURIComponent('https://dql.thoughtproof.ai/dql/checkout?session_id={CHECKOUT_SESSION_ID}'),
        );
        expect(body).not.toMatch(/dqlk_[0-9a-f]{16}/);
        return { id: 'cs_pack', url: 'https://checkout.stripe.com/c/pay/cs_pack' };
      },
    });
    const r = await createCheckoutSession({
      email: 'buyer@example.com',
      pack: 'starter',
      store,
      config: loadCheckoutConfig({
        ...baseEnv,
        DQL_STRIPE_PRICE_STARTER: 'price_test_starter',
      }),
      fetchImpl,
    });
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') expect(r.pack).toBe('starter');
  });

  it('trial uses setup mode (card bind, no price id)', async () => {
    const store = new UpstashKeyStore(createMemoryKv());
    const fetchImpl = stripeFetch({
      '/customers': (init) =>
        (init?.method ?? 'GET') === 'GET' ? { data: [] } : { id: 'cus_tr' },
      '/checkout/sessions': (init) => {
        const body = String(init?.body);
        expect(body).toContain('mode=setup');
        expect(body).toContain('trial');
        expect(body).not.toContain('line_items');
        return { id: 'cs_tr', url: 'https://checkout.stripe.com/c/pay/cs_tr' };
      },
    });
    const r = await createCheckoutSession({
      email: 'trial@example.com',
      pack: 'trial',
      store,
      config: loadCheckoutConfig(baseEnv),
      fetchImpl,
    });
    expect(r.kind).toBe('ok');
  });
});

describe('trial webhook fingerprint', () => {
  const secret = 'whsec_' + 'c'.repeat(24);
  const t = 1_700_000_200;

  it('mints trial credits from SetupIntent card fingerprint', async () => {
    const store = new UpstashKeyStore(createMemoryKv());
    const body = JSON.stringify({
      type: 'checkout.session.completed',
      data: {
        object: {
          id: 'cs_fp',
          customer: 'cus_fp',
          setup_intent: 'seti_fp',
          metadata: {
            dql_checkout: '1',
            owner: 'ss:cus_fp',
            pack: 'trial',
            email: 'fp@example.com',
          },
        },
      },
    });
    const fetchImpl = stripeFetch({
      '/setup_intents/seti_fp': () => ({
        payment_method: { id: 'pm_1', card: { fingerprint: 'fp_from_seti' } },
      }),
    });
    const r = await handleStripeWebhookEvent({
      rawBody: body,
      signatureHeader: sign(body, secret, t),
      webhookSecret: secret,
      store,
      secretKey: 'sk_test_x',
      fetchImpl,
      nowSec: t,
    });
    expect(r.kind).toBe('minted');
    const hash = await store.getKeyHashByCustomer('cus_fp');
    expect(hash).toBeTruthy();
    if (!hash) return;
    expect(await store.creditBalance(hash)).toBe(5);
    expect((await store.getRecordByHash(hash))?.trial).toBe(true);
  });

  it('trial webhook without fingerprint does not mint', async () => {
    const store = new UpstashKeyStore(createMemoryKv());
    const body = JSON.stringify({
      type: 'checkout.session.completed',
      data: {
        object: {
          id: 'cs_nofp',
          customer: 'cus_nofp',
          metadata: {
            dql_checkout: '1',
            owner: 'ss:cus_nofp',
            pack: 'trial',
            email: 'nofp@example.com',
          },
        },
      },
    });
    const fetchImpl = stripeFetch({
      '/setup_intents/': () => ({}),
    });
    const r = await handleStripeWebhookEvent({
      rawBody: body,
      signatureHeader: sign(body, secret, t),
      webhookSecret: secret,
      store,
      secretKey: 'sk_test_x',
      fetchImpl,
      nowSec: t,
    });
    expect(r.kind).toBe('trial_no_card');
    expect(await store.getKeyHashByCustomer('cus_nofp')).toBeUndefined();
  });
});
