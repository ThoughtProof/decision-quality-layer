import { createHmac } from 'node:crypto';
import { describe, it, expect, vi } from 'vitest';
import { authorizeCall, parseApiKeys, type UsageGate } from './keys.js';
import {
  checkoutRedirectUrls,
  createCheckoutSession,
  finalizeCheckoutMint,
  generateApiKey,
  handleStripeWebhookEvent,
  isCheckoutEnabled,
  loadCheckoutConfig,
  publicAppUrl,
  publicBaseUrl,
  revealCheckoutKey,
} from './checkout.js';
import { UpstashKeyStore, createMemoryKv, selfServeOwner } from './key-store.js';
import { emitStripeMeterEvent, STRIPE_METER_EVENT_NAME } from './stripe-meter.js';
import { sha256Hex } from './key-hash.js';

const allowGate: UsageGate = { checkAndRecord: async () => true };

function sign(payload: string, secret: string, t: number): string {
  const hex = createHmac('sha256', secret).update(`${t}.${payload}`, 'utf8').digest('hex');
  return `t=${t},v1=${hex}`;
}

describe('checkout flags', () => {
  it('DQL_CHECKOUT_ENABLED defaults OFF', () => {
    expect(isCheckoutEnabled({})).toBe(false);
    expect(loadCheckoutConfig({ STRIPE_SECRET_KEY: 'sk_test_x' }).enabled).toBe(false);
    expect(
      loadCheckoutConfig({
        DQL_CHECKOUT_ENABLED: 'true',
        STRIPE_SECRET_KEY: 'sk_test_x',
      }).enabled,
    ).toBe(true);
  });

  it('publicBaseUrl prefers explicit env then VERCEL_URL', () => {
    expect(publicBaseUrl({ DQL_PUBLIC_BASE_URL: 'https://dql.example/' })).toBe('https://dql.example');
    expect(publicBaseUrl({ VERCEL_URL: 'preview.vercel.app' })).toBe('https://preview.vercel.app');
  });

  it('success/cancel land on the App only when DQL_PUBLIC_APP_URL is set', () => {
    expect(publicAppUrl({})).toBe('');
    const dql = checkoutRedirectUrls({ DQL_PUBLIC_BASE_URL: 'https://dql.thoughtproof.ai' });
    expect(dql.successUrl).toBe(
      'https://dql.thoughtproof.ai/dql/checkout?session_id={CHECKOUT_SESSION_ID}',
    );
    expect(dql.cancelUrl).toBe('https://dql.thoughtproof.ai/');
    expect(dql.publicApp).toBe('');

    const app = checkoutRedirectUrls({
      DQL_PUBLIC_BASE_URL: 'https://dql.thoughtproof.ai',
      DQL_PUBLIC_APP_URL: 'https://app.thoughtproof.ai/',
    });
    expect(app.successUrl).toBe(
      'https://app.thoughtproof.ai/keys?session_id={CHECKOUT_SESSION_ID}',
    );
    expect(app.cancelUrl).toBe('https://app.thoughtproof.ai/pricing?canceled=1');
    expect(app.successUrl).not.toContain('dql.thoughtproof.ai/dql/checkout');
  });
});

describe('finalizeCheckoutMint + auth + meter + revoke', () => {
  it('mints a billable key, auth accepts, meter sees cus_, revoke rejects; no plaintext in logs', async () => {
    const logs: string[] = [];
    const logSpy = vi.spyOn(console, 'log').mockImplementation((line: unknown) => {
      logs.push(String(line));
    });

    const store = new UpstashKeyStore(createMemoryKv());
    const customerId = 'cus_V4abfGkmWdyxyC';
    const owner = selfServeOwner(customerId);
    const minted = await finalizeCheckoutMint({
      sessionId: 'cs_test_mint_1',
      customerId,
      owner,
      store,
      pack: 'payg',
    });
    expect(minted.kind).toBe('minted');
    if (minted.kind !== 'minted') return;
    const plaintext = minted.plaintext;
    expect(plaintext.startsWith('dqlk_')).toBe(true);
    expect(plaintext.length).toBeGreaterThan(20);

    const joined = logs.join('\n');
    expect(joined).not.toContain(plaintext);
    expect(joined).not.toContain(minted.accountToken);
    expect(joined).not.toMatch(/dqla_[0-9a-f]{16}/);
    expect(joined).toContain('dql_key_mint');

    const canaryKey = 'dqlk_canary_bootstrap_bbbbbbbbbbbb';
    const envKeys = parseApiKeys(
      JSON.stringify({
        [canaryKey]: { owner: 'dql-canary', dev_access: false, daily_cap: 50 },
      }),
    );

    const storeAuth = await authorizeCall({
      headers: { 'x-dql-key': plaintext },
      sandbox: false,
      keys: envKeys,
      usage: allowGate,
      store,
    });
    expect(storeAuth.kind).toBe('allow');
    if (storeAuth.kind !== 'allow') return;
    expect(storeAuth.record.dev_access).toBe(false);
    expect(storeAuth.record.stripe_customer_id).toBe(customerId);

    const canaryAuth = await authorizeCall({
      headers: { 'x-dql-key': canaryKey },
      sandbox: false,
      keys: envKeys,
      usage: allowGate,
      store,
    });
    expect(canaryAuth.kind).toBe('allow');
    if (canaryAuth.kind === 'allow') expect(canaryAuth.record.owner).toBe('dql-canary');

    const meter = await emitStripeMeterEvent({
      requestId: 'dql_meter_self_serve',
      owner: storeAuth.record.owner,
      customerId: storeAuth.record.stripe_customer_id,
      fetchImpl: (async () => ({
        ok: true,
        status: 200,
        json: async () => ({ identifier: 'dql_meter_self_serve' }),
        text: async () => '',
      })) as unknown as typeof fetch,
      config: {
        enabled: true,
        secretKey: 'sk_test',
        eventName: STRIPE_METER_EVENT_NAME,
        customerByOwner: new Map(), // env map empty — store cus_ must be enough
      },
    });
    expect(meter.kind).toBe('ok');

    await store.revokeByHash(sha256Hex(plaintext));
    const revoked = await authorizeCall({
      headers: { 'x-dql-key': plaintext },
      sandbox: false,
      keys: envKeys,
      usage: allowGate,
      store,
    });
    expect(revoked.kind).toBe('deny');

    expect(logs.join('\n')).not.toContain(plaintext);
    logSpy.mockRestore();
  });

  it('mint is idempotent per session', async () => {
    const store = new UpstashKeyStore(createMemoryKv());
    const a = await finalizeCheckoutMint({
      sessionId: 'cs_dup',
      customerId: 'cus_dup',
      owner: 'ss:cus_dup',
      store,
      pack: 'payg',
    });
    const b = await finalizeCheckoutMint({
      sessionId: 'cs_dup',
      customerId: 'cus_dup',
      owner: 'ss:cus_dup',
      store,
      pack: 'payg',
    });
    expect(a.kind).toBe('minted');
    expect(b.kind).toBe('already_minted');
  });
});

describe('createCheckoutSession', () => {
  const cfg = loadCheckoutConfig({
    DQL_CHECKOUT_ENABLED: 'true',
    STRIPE_SECRET_KEY: 'sk_test_x',
    DQL_PUBLIC_BASE_URL: 'https://dql.thoughtproof.ai',
  });

  it('rejects invalid email and disabled flag', async () => {
    const store = new UpstashKeyStore(createMemoryKv());
    expect(
      await createCheckoutSession({
        email: 'not-an-email',
        pack: 'payg',
        store,
        config: cfg,
        fetchImpl: (async () => {
          throw new Error('stripe must not be called');
        }) as unknown as typeof fetch,
      }),
    ).toEqual({ kind: 'invalid', reason: 'invalid_email' });

    expect(
      await createCheckoutSession({
        email: 'a@b.co',
        pack: 'payg',
        store,
        config: { ...cfg, enabled: false },
      }),
    ).toEqual({ kind: 'disabled' });

    expect(
      await createCheckoutSession({
        email: 'a@b.co',
        pack: 'nope',
        store,
        config: cfg,
        fetchImpl: (async () => {
          throw new Error('stripe must not be called');
        }) as unknown as typeof fetch,
      }),
    ).toEqual({ kind: 'invalid', reason: 'invalid_pack' });
  });

  it('creates customer + setup-mode session and persists pending checkout', async () => {
    const store = new UpstashKeyStore(createMemoryKv());
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      const u = String(url);
      if (u.includes('/customers') && (init?.method ?? 'GET') === 'GET') {
        return { ok: true, status: 200, json: async () => ({ data: [] }) };
      }
      if (u.includes('/customers') && init?.method === 'POST') {
        return { ok: true, status: 200, json: async () => ({ id: 'cus_new1' }) };
      }
      if (u.includes('/checkout/sessions')) {
        expect(String(init?.body)).toContain('mode=setup');
        expect(String(init?.body)).toContain('dql_checkout');
        expect(String(init?.body)).toContain(
          encodeURIComponent('https://dql.thoughtproof.ai/dql/checkout?session_id={CHECKOUT_SESSION_ID}'),
        );
        expect(String(init?.body)).not.toMatch(/dqlk_[0-9a-f]{16}/);
        return {
          ok: true,
          status: 200,
          json: async () => ({
            id: 'cs_new1',
            url: 'https://checkout.stripe.com/c/pay/cs_new1',
          }),
        };
      }
      throw new Error(`unexpected ${u}`);
    }) as unknown as typeof fetch;

    const r = await createCheckoutSession({
      email: 'buyer@example.com',
      pack: 'payg',
      store,
      config: cfg,
      fetchImpl,
    });
    expect(r.kind).toBe('ok');
    if (r.kind !== 'ok') return;
    expect(r.url).toContain('checkout.stripe.com');
    const pending = await store.getCheckout('cs_new1');
    expect(pending?.status).toBe('pending');
    expect(pending?.customer_id).toBe('cus_new1');
    expect(pending?.owner).toBe('ss:cus_new1');
  });

  it('uses App keys/pricing URLs when DQL_PUBLIC_APP_URL is set', async () => {
    const store = new UpstashKeyStore(createMemoryKv());
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      const u = String(url);
      if (u.includes('/customers') && (init?.method ?? 'GET') === 'GET') {
        return { ok: true, status: 200, json: async () => ({ data: [] }) };
      }
      if (u.includes('/customers') && init?.method === 'POST') {
        return { ok: true, status: 200, json: async () => ({ id: 'cus_app1' }) };
      }
      if (u.includes('/checkout/sessions')) {
        const body = String(init?.body);
        expect(body).toContain(encodeURIComponent('https://app.thoughtproof.ai/keys'));
        expect(body).toContain(encodeURIComponent('https://app.thoughtproof.ai/pricing?canceled=1'));
        expect(body).not.toContain(encodeURIComponent('/dql/checkout?session_id'));
        return {
          ok: true,
          status: 200,
          json: async () => ({
            id: 'cs_app1',
            url: 'https://checkout.stripe.com/c/pay/cs_app1',
          }),
        };
      }
      throw new Error(`unexpected ${u}`);
    }) as unknown as typeof fetch;

    const r = await createCheckoutSession({
      email: 'buyer@example.com',
      pack: 'payg',
      store,
      config: loadCheckoutConfig({
        DQL_CHECKOUT_ENABLED: 'true',
        STRIPE_SECRET_KEY: 'sk_test_x',
        DQL_PUBLIC_BASE_URL: 'https://dql.thoughtproof.ai',
        DQL_PUBLIC_APP_URL: 'https://app.thoughtproof.ai',
      }),
      fetchImpl,
    });
    expect(r.kind).toBe('ok');
  });
});

describe('revealCheckoutKey', () => {
  it('returns key once then KEY_ALREADY_DELIVERED; key never in session fetch URL', async () => {
    const store = new UpstashKeyStore(createMemoryKv());
    const minted = await finalizeCheckoutMint({
      sessionId: 'cs_reveal',
      customerId: 'cus_r',
      owner: 'ss:cus_r',
      store,
      pack: 'payg',
    });
    expect(minted.kind).toBe('minted');
    if (minted.kind !== 'minted') return;

    const fetchImpl = vi.fn(async (url: string) => {
      expect(String(url)).not.toContain(minted.plaintext);
      return {
        ok: true,
        status: 200,
        json: async () => ({
          id: 'cs_reveal',
          status: 'complete',
          customer: 'cus_r',
          metadata: { dql_checkout: '1', owner: 'ss:cus_r', pack: 'payg' },
        }),
      };
    }) as unknown as typeof fetch;

    const cfg = loadCheckoutConfig({
      DQL_CHECKOUT_ENABLED: 'true',
      STRIPE_SECRET_KEY: 'sk_test_x',
    });

    const first = await revealCheckoutKey({
      sessionId: 'cs_reveal',
      store,
      config: cfg,
      fetchImpl,
    });
    expect(first.kind).toBe('ok');
    if (first.kind !== 'ok') return;
    expect(first.api_key).toBe(minted.plaintext);
    expect(first.account_token.startsWith('dqla_')).toBe(true);
    expect(first.key_prefix).toBe(minted.prefix);
    expect(first.credits).toBe(0);
    expect(first.pack).toBe('payg');
    expect(first.trial).toBe(false);
    expect(first.payg_opt_in).toBe(true);
    expect(first.shown_once).toBe(true);
    expect(first.account_token).toBe(minted.accountToken);

    const second = await revealCheckoutKey({
      sessionId: 'cs_reveal',
      store,
      config: cfg,
      fetchImpl,
    });
    expect(second.kind).toBe('already_delivered');
    if (second.kind === 'already_delivered') {
      expect(JSON.stringify(second)).not.toContain(minted.plaintext);
      expect(JSON.stringify(second)).not.toMatch(/dqla_[0-9a-f]{16}/);
    }
  });
});

describe('handleStripeWebhookEvent', () => {
  const secret = 'whsec_' + 'b'.repeat(24);
  const t = 1_700_000_100;

  it('rejects unsigned / bad signature and never mints', async () => {
    const store = new UpstashKeyStore(createMemoryKv());
    const body = JSON.stringify({
      type: 'checkout.session.completed',
      data: {
        object: {
          id: 'cs_unsigned',
          customer: 'cus_x',
          metadata: { dql_checkout: '1', owner: 'ss:cus_x', pack: 'payg' },
        },
      },
    });
    const bad = await handleStripeWebhookEvent({
      rawBody: body,
      signatureHeader: undefined,
      webhookSecret: secret,
      store,
      nowSec: t,
    });
    expect(bad.kind).toBe('unauthorized');
    expect(await store.getCheckout('cs_unsigned')).toBeNull();
  });

  it('mints on signed checkout.session.completed without putting key in the response path', async () => {
    const logs: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((l: unknown) => {
      logs.push(String(l));
    });
    const store = new UpstashKeyStore(createMemoryKv());
    const body = JSON.stringify({
      type: 'checkout.session.completed',
      data: {
        object: {
          id: 'cs_signed',
          customer: 'cus_signed',
          metadata: { dql_checkout: '1', owner: 'ss:cus_signed', pack: 'payg' },
        },
      },
    });
    const r = await handleStripeWebhookEvent({
      rawBody: body,
      signatureHeader: sign(body, secret, t),
      webhookSecret: secret,
      store,
      nowSec: t,
    });
    expect(r.kind).toBe('minted');
    const state = await store.getCheckout('cs_signed');
    expect(state?.status).toBe('minted');
    expect(state?.key_hash).toBeTruthy();
    expect(JSON.stringify(r)).not.toMatch(/dqlk_[0-9a-f]{20}/);
    expect(logs.join('\n')).not.toMatch(/dqlk_[0-9a-f]{20}/);

    const key = generateApiKey();
    // Auth still requires the plaintext; webhook must not have leaked it.
    const denied = await authorizeCall({
      headers: { 'x-dql-key': key },
      sandbox: false,
      keys: new Map(),
      usage: allowGate,
      store,
    });
    expect(denied.kind).toBe('deny');
    spy.mockRestore();
  });

  it('ignores DQL sessions with no pack (fail closed, no mint)', async () => {
    const store = new UpstashKeyStore(createMemoryKv());
    const body = JSON.stringify({
      type: 'checkout.session.completed',
      data: {
        object: {
          id: 'cs_nopack',
          customer: 'cus_nopack',
          metadata: { dql_checkout: '1', owner: 'ss:cus_nopack' },
        },
      },
    });
    const r = await handleStripeWebhookEvent({
      rawBody: body,
      signatureHeader: sign(body, secret, t),
      webhookSecret: secret,
      store,
      nowSec: t,
    });
    expect(r).toEqual({ kind: 'ignored', reason: 'invalid_pack' });
    expect(await store.getCheckout('cs_nopack')).toBeNull();
  });

  it('ignores non-DQL sessions on a shared Stripe account', async () => {
    const store = new UpstashKeyStore(createMemoryKv());
    const body = JSON.stringify({
      type: 'checkout.session.completed',
      data: { object: { id: 'cs_other', customer: 'cus_other', metadata: {} } },
    });
    const r = await handleStripeWebhookEvent({
      rawBody: body,
      signatureHeader: sign(body, secret, t),
      webhookSecret: secret,
      store,
      nowSec: t,
    });
    expect(r).toEqual({ kind: 'ignored', reason: 'not_dql_checkout' });
  });
});
