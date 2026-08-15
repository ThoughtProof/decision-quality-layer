import { describe, it, expect } from 'vitest';
import { authorizeCall, parseApiKeys, type UsageGate } from './keys.js';
import {
  UpstashKeyStore,
  createKeyStore,
  createMemoryKv,
  newStoredKeyRecord,
  selfServeOwner,
} from './key-store.js';
import { generateApiKey } from './checkout.js';
import { sha256Hex } from './key-hash.js';

const allowGate: UsageGate = { checkAndRecord: async () => true };

describe('createKeyStore', () => {
  it('returns null without Upstash env', () => {
    expect(createKeyStore({} as NodeJS.ProcessEnv)).toBeNull();
  });
});

describe('UpstashKeyStore (memory)', () => {
  it('persists hash only — plaintext never written to kv', async () => {
    const kv = createMemoryKv();
    const store = new UpstashKeyStore(kv);
    const key = generateApiKey();
    const rec = newStoredKeyRecord({
      plaintextKey: key,
      owner: selfServeOwner('cus_abc'),
      stripeCustomerId: 'cus_abc',
    });
    await store.putKey(rec);
    await store.putCustomerMap(rec.owner, rec.stripe_customer_id);

    const dump = kv.dump();
    const serialized = JSON.stringify([...dump.entries()]);
    expect(serialized).not.toContain(key);
    expect(dump.has(`dql:key:${sha256Hex(key)}`)).toBe(true);
    expect(await store.getCustomerByOwner(rec.owner)).toBe('cus_abc');
  });

  it('lookup accepts minted key and rejects revoked', async () => {
    const store = new UpstashKeyStore(createMemoryKv());
    const key = generateApiKey();
    const rec = newStoredKeyRecord({
      plaintextKey: key,
      owner: 'ss:cus_1',
      stripeCustomerId: 'cus_1',
    });
    await store.putKey(rec);

    const found = await store.lookup(key);
    expect(found?.owner).toBe('ss:cus_1');
    expect(found?.dev_access).toBe(false);
    expect(found?.stripe_customer_id).toBe('cus_1');

    await store.revokeByHash(rec.hash);
    expect(await store.lookup(key)).toBeUndefined();
  });

  it('credits decrement atomically and trial claim is once per email ∪ fingerprint', async () => {
    const store = new UpstashKeyStore(createMemoryKv());
    const key = generateApiKey();
    const rec = newStoredKeyRecord({
      plaintextKey: key,
      owner: 'ss:cus_c',
      stripeCustomerId: 'cus_c',
    });
    await store.putKey(rec);
    expect(await store.addCredits(rec.hash, 2)).toBe(2);
    expect(await store.consumeCredit(rec.hash)).toBe('consumed');
    expect(await store.consumeCredit(rec.hash)).toBe('consumed');
    expect(await store.consumeCredit(rec.hash)).toBe('empty');
    expect(await store.creditBalance(rec.hash)).toBe(0);

    expect(await store.claimTrial('a@b.co', 'fp_1')).toBe('ok');
    expect(await store.claimTrial('a@b.co', 'fp_2')).toBe('already_used');
    expect(await store.claimTrial('c@d.co', 'fp_1')).toBe('already_used');
    expect(await store.claimTrial('e@f.co', 'fp_3')).toBe('ok');
  });

  it('reserveVerify holds credit+cap; release restores; commit is sticky', async () => {
    const store = new UpstashKeyStore(createMemoryKv());
    const key = generateApiKey();
    const rec = newStoredKeyRecord({
      plaintextKey: key,
      owner: 'ss:cus_rsv',
      stripeCustomerId: 'cus_rsv',
    });
    await store.putKey(rec);
    await store.addCredits(rec.hash, 3);

    const first = await store.reserveVerify({
      requestId: 'dql_r1',
      keyHash: rec.hash,
      dailyCap: 10,
      paygOptIn: false,
    });
    expect(first.kind).toBe('ok');
    expect(await store.creditBalance(rec.hash)).toBe(2);
    expect(await store.usageToday(rec.hash)).toBe(1);

    const replay = await store.reserveVerify({
      requestId: 'dql_r1',
      keyHash: rec.hash,
      dailyCap: 10,
      paygOptIn: false,
    });
    expect(replay.kind).toBe('ok');
    expect(await store.creditBalance(rec.hash)).toBe(2);

    await store.releaseVerifyReservation('dql_r1');
    expect(await store.creditBalance(rec.hash)).toBe(3);
    expect(await store.usageToday(rec.hash)).toBe(0);

    const again = await store.reserveVerify({
      requestId: 'dql_r2',
      keyHash: rec.hash,
      dailyCap: 10,
      paygOptIn: false,
    });
    expect(again.kind).toBe('ok');
    await store.commitVerifyReservation('dql_r2');
    await store.releaseVerifyReservation('dql_r2');
    expect(await store.creditBalance(rec.hash)).toBe(2);
    expect(await store.usageToday(rec.hash)).toBe(1);
  });

  it('reveal is one-time (GETDEL)', async () => {
    const store = new UpstashKeyStore(createMemoryKv());
    const key = generateApiKey();
    await store.putReveal('tok_1', { key }, 60);
    expect(await store.consumeReveal('tok_1')).toEqual({ key });
    expect(await store.consumeReveal('tok_1')).toBeNull();
  });
});

describe('authorizeCall env ∪ store', () => {
  const canaryKey = 'dqlk_canary_bootstrap_aaaaaaaaaaaa';
  const envKeys = parseApiKeys(
    JSON.stringify({
      [canaryKey]: { owner: 'dql-canary', dev_access: false, daily_cap: 100 },
    }),
  );

  it('env canary still works when store is empty', async () => {
    const store = new UpstashKeyStore(createMemoryKv());
    const d = await authorizeCall({
      headers: { 'x-dql-key': canaryKey },
      sandbox: false,
      keys: envKeys,
      usage: allowGate,
      store,
    });
    expect(d.kind).toBe('allow');
    if (d.kind !== 'allow') return;
    expect(d.record.owner).toBe('dql-canary');
  });

  it('mint → auth accepts → revoke rejects', async () => {
    const store = new UpstashKeyStore(createMemoryKv());
    const key = generateApiKey();
    await store.putKey(
      newStoredKeyRecord({
        plaintextKey: key,
        owner: 'ss:cus_mint',
        stripeCustomerId: 'cus_mint',
        paygOptIn: true,
      }),
    );

    const allowed = await authorizeCall({
      headers: { authorization: `Bearer ${key}` },
      sandbox: false,
      keys: envKeys,
      usage: allowGate,
      store,
    });
    expect(allowed.kind).toBe('allow');
    if (allowed.kind !== 'allow') return;
    expect(allowed.record.dev_access).toBe(false);
    expect(allowed.record.stripe_customer_id).toBe('cus_mint');

    await store.revokeByHash(sha256Hex(key));
    const denied = await authorizeCall({
      headers: { 'x-dql-key': key },
      sandbox: false,
      keys: envKeys,
      usage: allowGate,
      store,
    });
    expect(denied.kind).toBe('deny');
    if (denied.kind !== 'deny') return;
    expect(denied.status).toBe(402);
  });

  it('env wins over store on the same plaintext (canary cannot be shadowed)', async () => {
    const store = new UpstashKeyStore(createMemoryKv());
    await store.putKey(
      newStoredKeyRecord({
        plaintextKey: canaryKey,
        owner: 'ss:cus_shadow',
        stripeCustomerId: 'cus_shadow',
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
    if (d.kind !== 'allow') return;
    expect(d.record.owner).toBe('dql-canary');
  });
});
