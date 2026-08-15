import { describe, it, expect, vi } from 'vitest';
import { authorizeCall, type UsageGate } from './keys.js';
import {
  authorizeAccount,
  createBillingPortalSession,
  extractAccountToken,
  getAccountSnapshot,
  maskEmail,
  revokeAccountKey,
  rotateAccountKey,
} from './account.js';
import {
  finalizeCheckoutMint,
  generateApiKey,
  generateAccountToken,
  revealCheckoutKey,
  loadCheckoutConfig,
} from './checkout.js';
import { UpstashKeyStore, createMemoryKv, selfServeOwner } from './key-store.js';
import { sha256Hex } from './key-hash.js';
import { STARTER_CREDITS } from './packs.js';
import { usageCounterKeyFromHash } from './usage.js';

const allowGate: UsageGate = { checkAndRecord: async () => true };

function stripeSessionFetch(sessionId: string, customerId: string, pack: string): typeof fetch {
  return vi.fn(async (url: string) => {
    expect(String(url)).not.toMatch(/dqlk_[0-9a-f]{16}/);
    expect(String(url)).not.toMatch(/dqla_[0-9a-f]{16}/);
    return {
      ok: true,
      status: 200,
      json: async () => ({
        id: sessionId,
        status: 'complete',
        customer: customerId,
        metadata: { dql_checkout: '1', owner: selfServeOwner(customerId), pack },
      }),
    };
  }) as unknown as typeof fetch;
}

describe('extractAccountToken / maskEmail', () => {
  it('accepts X-DQL-Account or Bearer dqla_ and rejects verify keys', () => {
    expect(extractAccountToken({ 'x-dql-account': 'dqla_abc' })).toBe('dqla_abc');
    expect(extractAccountToken({ authorization: 'Bearer dqla_xyz' })).toBe('dqla_xyz');
    expect(extractAccountToken({ 'x-dql-account': 'dqlk_not_an_account' })).toBeNull();
    expect(extractAccountToken({ authorization: 'Bearer dqlk_verify' })).toBeNull();
    expect(extractAccountToken({ 'x-dql-key': 'dqla_abc' })).toBeNull();
    expect(extractAccountToken({})).toBeNull();
  });

  it('masks local-part, keeps domain', () => {
    expect(maskEmail('Buyer@Example.com')).toBe('b***@example.com');
    expect(maskEmail('')).toBe('');
    expect(maskEmail('nope')).toBe('');
  });
});

describe('reveal + account surface', () => {
  it('reveal returns token+credits once; replay is 409 with no secrets', async () => {
    const store = new UpstashKeyStore(createMemoryKv());
    const minted = await finalizeCheckoutMint({
      sessionId: 'cs_acct',
      customerId: 'cus_acct',
      owner: selfServeOwner('cus_acct'),
      store,
      pack: 'starter',
      emailNormalized: 'buyer@example.com',
    });
    expect(minted.kind).toBe('minted');
    if (minted.kind !== 'minted') return;

    const cfg = loadCheckoutConfig({ STRIPE_SECRET_KEY: 'sk_test_x' });
    const fetchImpl = stripeSessionFetch('cs_acct', 'cus_acct', 'starter');

    const first = await revealCheckoutKey({
      sessionId: 'cs_acct',
      store,
      config: cfg,
      fetchImpl,
    });
    expect(first.kind).toBe('ok');
    if (first.kind !== 'ok') return;
    expect(first.api_key).toBe(minted.plaintext);
    expect(first.account_token).toBe(minted.accountToken);
    expect(first.account_token.startsWith('dqla_')).toBe(true);
    expect(first.credits).toBe(STARTER_CREDITS);
    expect(first.pack).toBe('starter');
    expect(first.trial).toBe(false);
    expect(first.payg_opt_in).toBe(false);
    expect(first.key_prefix).toBe(minted.prefix);

    const replay = await revealCheckoutKey({
      sessionId: 'cs_acct',
      store,
      config: cfg,
      fetchImpl,
    });
    expect(replay.kind).toBe('already_delivered');
    expect(JSON.stringify(replay)).not.toContain(first.api_key);
    expect(JSON.stringify(replay)).not.toContain(first.account_token);
  });

  it('GET account works with token, not with the verify key', async () => {
    const kv = createMemoryKv();
    const store = new UpstashKeyStore(kv);
    const minted = await finalizeCheckoutMint({
      sessionId: 'cs_get',
      customerId: 'cus_get',
      owner: selfServeOwner('cus_get'),
      store,
      pack: 'starter',
      emailNormalized: 'buyer@example.com',
    });
    expect(minted.kind).toBe('minted');
    if (minted.kind !== 'minted') return;

    const day = new Date().toISOString().slice(0, 10);
    await kv.set(usageCounterKeyFromHash(sha256Hex(minted.plaintext), day), 3);

    const withToken = await authorizeAccount({
      headers: { 'x-dql-account': minted.accountToken },
      store,
    });
    expect(withToken.kind).toBe('ok');
    if (withToken.kind !== 'ok') return;
    const snap = await getAccountSnapshot({ record: withToken.record, store });
    expect(snap.key_prefix).toBe(minted.prefix);
    expect(snap.credits).toBe(STARTER_CREDITS);
    expect(snap.trial).toBe(false);
    expect(snap.payg_opt_in).toBe(false);
    expect(snap.usage_today).toBe(3);
    expect(snap.daily_cap).toBeGreaterThan(0);
    expect(snap.email_masked).toBe('b***@example.com');
    expect(snap.revoked).toBe(false);
    expect(JSON.stringify(snap)).not.toContain(minted.plaintext);
    expect(JSON.stringify(snap)).not.toContain(minted.accountToken);

    const withKey = await authorizeAccount({
      headers: { 'x-dql-account': minted.plaintext },
      store,
    });
    expect(withKey.kind).toBe('unauthorized');

    const withKeyAsBearer = await authorizeAccount({
      headers: { authorization: `Bearer ${minted.plaintext}` },
      store,
    });
    expect(withKeyAsBearer.kind).toBe('unauthorized');

    const missing = await authorizeAccount({ headers: {}, store });
    expect(missing.kind).toBe('unauthorized');

    const dump = JSON.stringify([...kv.dump().entries()]);
    expect(dump).not.toContain(minted.accountToken);
    expect(dump).not.toContain(minted.plaintext);
  });

  it('account token is not a verify key', async () => {
    const store = new UpstashKeyStore(createMemoryKv());
    const minted = await finalizeCheckoutMint({
      sessionId: 'cs_notkey',
      customerId: 'cus_notkey',
      owner: selfServeOwner('cus_notkey'),
      store,
      pack: 'starter',
    });
    expect(minted.kind).toBe('minted');
    if (minted.kind !== 'minted') return;

    const denied = await authorizeCall({
      headers: { 'x-dql-key': minted.accountToken },
      sandbox: false,
      keys: new Map(),
      usage: allowGate,
      store,
    });
    expect(denied.kind).toBe('deny');
    if (denied.kind === 'deny') expect(denied.status).toBe(402);
  });

  it('rotate issues a new key; old verify dies; credits/customer/token preserved', async () => {
    const logs: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((l: unknown) => {
      logs.push(String(l));
    });
    const store = new UpstashKeyStore(createMemoryKv());
    const minted = await finalizeCheckoutMint({
      sessionId: 'cs_rot',
      customerId: 'cus_rot',
      owner: selfServeOwner('cus_rot'),
      store,
      pack: 'starter',
      emailNormalized: 'rot@example.com',
    });
    expect(minted.kind).toBe('minted');
    if (minted.kind !== 'minted') return;

    const auth = await authorizeAccount({
      headers: { authorization: `Bearer ${minted.accountToken}` },
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
    expect(rotated.api_key.startsWith('dqlk_')).toBe(true);
    expect(rotated.api_key).not.toBe(minted.plaintext);
    expect(rotated.shown_once).toBe(true);

    const oldAuth = await authorizeCall({
      headers: { 'x-dql-key': minted.plaintext },
      sandbox: false,
      keys: new Map(),
      usage: allowGate,
      store,
    });
    expect(oldAuth.kind).toBe('deny');
    if (oldAuth.kind === 'deny') {
      expect([401, 402]).toContain(oldAuth.status);
    }

    const newAuth = await authorizeCall({
      headers: { 'x-dql-key': rotated.api_key },
      sandbox: false,
      keys: new Map(),
      usage: allowGate,
      store,
    });
    expect(newAuth.kind).toBe('allow');
    if (newAuth.kind === 'allow') {
      expect(newAuth.record.stripe_customer_id).toBe('cus_rot');
      expect(newAuth.billing).toBe('credit');
    }
    expect(await store.creditBalance(sha256Hex(rotated.api_key))).toBe(STARTER_CREDITS - 1);
    expect(await store.getKeyHashByCustomer('cus_rot')).toBe(sha256Hex(rotated.api_key));

    const still = await authorizeAccount({
      headers: { 'x-dql-account': minted.accountToken },
      store,
    });
    expect(still.kind).toBe('ok');
    if (still.kind === 'ok') {
      const snap = await getAccountSnapshot({ record: still.record, store });
      expect(snap.key_prefix).toBe(rotated.key_prefix);
      expect(snap.credits).toBe(STARTER_CREDITS - 1);
    }

    expect(logs.join('\n')).not.toContain(minted.plaintext);
    expect(logs.join('\n')).not.toContain(rotated.api_key);
    expect(logs.join('\n')).not.toContain(minted.accountToken);
    spy.mockRestore();
  });

  it('revoke stops verify; credits stay unused', async () => {
    const store = new UpstashKeyStore(createMemoryKv());
    const minted = await finalizeCheckoutMint({
      sessionId: 'cs_rev',
      customerId: 'cus_rev',
      owner: selfServeOwner('cus_rev'),
      store,
      pack: 'starter',
    });
    expect(minted.kind).toBe('minted');
    if (minted.kind !== 'minted') return;

    const auth = await authorizeAccount({
      headers: { 'x-dql-account': minted.accountToken },
      store,
    });
    expect(auth.kind).toBe('ok');
    if (auth.kind !== 'ok') return;

    const revoked = await revokeAccountKey({ record: auth.record, store });
    expect(revoked.kind).toBe('ok');

    const dead = await authorizeCall({
      headers: { 'x-dql-key': minted.plaintext },
      sandbox: false,
      keys: new Map(),
      usage: allowGate,
      store,
    });
    expect(dead.kind).toBe('deny');
    if (dead.kind === 'deny') expect([401, 402]).toContain(dead.status);
    expect(await store.creditBalance(sha256Hex(minted.plaintext))).toBe(STARTER_CREDITS);
  });

  it('portal fails closed when Stripe portal is not configured', async () => {
    const rec = {
      hash: 'abc',
      prefix: 'dqlk_…xxxx',
      owner: 'ss:cus_p',
      stripe_customer_id: 'cus_p',
      created: new Date().toISOString(),
      revoked: false,
      dev_access: false as const,
      daily_cap: 1000,
      source: 'self_serve' as const,
      payg_opt_in: false,
      trial: false,
    };
    const missingSecret = await createBillingPortalSession({
      record: rec,
      secretKey: '',
      returnUrl: 'https://app.example/keys',
    });
    expect(missingSecret.kind).toBe('unconfigured');

    const stripeFail = await createBillingPortalSession({
      record: rec,
      secretKey: 'sk_test_x',
      returnUrl: 'https://app.example/keys',
      fetchImpl: (async () => ({
        ok: false,
        status: 400,
        json: async () => ({ error: { message: 'No configuration provided' } }),
      })) as unknown as typeof fetch,
    });
    expect(stripeFail.kind).toBe('unconfigured');

    const ok = await createBillingPortalSession({
      record: rec,
      secretKey: 'sk_test_x',
      returnUrl: 'https://app.example/keys',
      fetchImpl: (async () => ({
        ok: true,
        status: 200,
        json: async () => ({ url: 'https://billing.stripe.com/p/session/test' }),
      })) as unknown as typeof fetch,
    });
    expect(ok).toEqual({ kind: 'ok', url: 'https://billing.stripe.com/p/session/test' });
  });
});

describe('generateAccountToken', () => {
  it('is opaque dqla_ and distinct from verify keys', () => {
    const t = generateAccountToken();
    expect(t.startsWith('dqla_')).toBe(true);
    expect(generateApiKey().startsWith('dqlk_')).toBe(true);
    expect(t).not.toBe(generateAccountToken());
  });
});
