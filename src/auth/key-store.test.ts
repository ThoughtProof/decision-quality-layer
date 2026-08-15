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
const DIGEST_A = 'digest-aaaaaaaaaaaaaaaa';
const DIGEST_B = 'digest-bbbbbbbbbbbbbbbb';

function holdOf(result: Awaited<ReturnType<UpstashKeyStore['reserveVerify']>>) {
  if (result.kind !== 'ok') throw new Error(`expected ok, got ${result.kind}`);
  return {
    requestId: result.reservation.requestId,
    keyHash: result.reservation.keyHash,
    fence: result.reservation.fence,
  };
}

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
      payloadDigest: DIGEST_A,
      dailyCap: 10,
      paygOptIn: false,
    });
    expect(first.kind).toBe('ok');
    expect(await store.creditBalance(rec.hash)).toBe(2);
    expect(await store.usageToday(rec.hash)).toBe(1);

    const replay = await store.reserveVerify({
      requestId: 'dql_r1',
      keyHash: rec.hash,
      payloadDigest: DIGEST_A,
      dailyCap: 10,
      paygOptIn: false,
    });
    expect(replay.kind).toBe('in_progress');
    expect(await store.creditBalance(rec.hash)).toBe(2);

    await store.releaseVerifyReservation(holdOf(first));
    expect(await store.creditBalance(rec.hash)).toBe(3);
    expect(await store.usageToday(rec.hash)).toBe(0);

    const again = await store.reserveVerify({
      requestId: 'dql_r2',
      keyHash: rec.hash,
      payloadDigest: DIGEST_A,
      dailyCap: 10,
      paygOptIn: false,
    });
    expect(again.kind).toBe('ok');
    await store.commitVerifyReservation(holdOf(again));
    await store.releaseVerifyReservation(holdOf(again));
    expect(await store.creditBalance(rec.hash)).toBe(2);
    expect(await store.usageToday(rec.hash)).toBe(1);
  });

  it('parallel reserveVerify same requestId debits once', async () => {
    const store = new UpstashKeyStore(createMemoryKv());
    const key = generateApiKey();
    const rec = newStoredKeyRecord({
      plaintextKey: key,
      owner: 'ss:cus_same',
      stripeCustomerId: 'cus_same',
    });
    await store.putKey(rec);
    await store.addCredits(rec.hash, 2);

    const [a, b] = await Promise.all([
      store.reserveVerify({
        requestId: 'dql_same_id',
        keyHash: rec.hash,
        payloadDigest: DIGEST_A,
        dailyCap: 10,
        paygOptIn: false,
      }),
      store.reserveVerify({
        requestId: 'dql_same_id',
        keyHash: rec.hash,
        payloadDigest: DIGEST_A,
        dailyCap: 10,
        paygOptIn: false,
      }),
    ]);
    const kinds = [a.kind, b.kind].sort();
    expect(kinds).toEqual(['in_progress', 'ok']);
    expect(await store.creditBalance(rec.hash)).toBe(1);
    expect(await store.usageToday(rec.hash)).toBe(1);
  });

  it('parallel double-release restores credit and cap once', async () => {
    const store = new UpstashKeyStore(createMemoryKv());
    const key = generateApiKey();
    const rec = newStoredKeyRecord({
      plaintextKey: key,
      owner: 'ss:cus_rel',
      stripeCustomerId: 'cus_rel',
    });
    await store.putKey(rec);
    await store.addCredits(rec.hash, 2);
    const held = await store.reserveVerify({
      requestId: 'dql_dbl_rel',
      keyHash: rec.hash,
      payloadDigest: DIGEST_A,
      dailyCap: 10,
      paygOptIn: false,
    });
    expect(held.kind).toBe('ok');
    expect(await store.creditBalance(rec.hash)).toBe(1);

    await Promise.all([
      store.releaseVerifyReservation(holdOf(held)),
      store.releaseVerifyReservation(holdOf(held)),
    ]);
    expect(await store.creditBalance(rec.hash)).toBe(2);
    expect(await store.usageToday(rec.hash)).toBe(0);
  });

  it('commit then release does not refund; release then commit does not debit', async () => {
    const store = new UpstashKeyStore(createMemoryKv());
    const key = generateApiKey();
    const rec = newStoredKeyRecord({
      plaintextKey: key,
      owner: 'ss:cus_state',
      stripeCustomerId: 'cus_state',
    });
    await store.putKey(rec);
    await store.addCredits(rec.hash, 3);

    const c = await store.reserveVerify({
      requestId: 'dql_commit_first',
      keyHash: rec.hash,
      payloadDigest: DIGEST_A,
      dailyCap: 10,
      paygOptIn: false,
    });
    expect(c.kind).toBe('ok');
    await store.commitVerifyReservation(holdOf(c));
    await store.releaseVerifyReservation(holdOf(c));
    expect(await store.creditBalance(rec.hash)).toBe(2);
    expect(await store.usageToday(rec.hash)).toBe(1);

    const r = await store.reserveVerify({
      requestId: 'dql_release_first',
      keyHash: rec.hash,
      payloadDigest: DIGEST_A,
      dailyCap: 10,
      paygOptIn: false,
    });
    expect(r.kind).toBe('ok');
    expect(await store.creditBalance(rec.hash)).toBe(1);
    await store.releaseVerifyReservation(holdOf(r));
    expect(await store.creditBalance(rec.hash)).toBe(2);
    expect(await store.usageToday(rec.hash)).toBe(1);
    await store.commitVerifyReservation(holdOf(r));
    expect(await store.creditBalance(rec.hash)).toBe(2);
    expect(await store.usageToday(rec.hash)).toBe(1);
  });

  it('parallel commit+release does not double-refund or extra-debit', async () => {
    const store = new UpstashKeyStore(createMemoryKv());
    const key = generateApiKey();
    const rec = newStoredKeyRecord({
      plaintextKey: key,
      owner: 'ss:cus_race2',
      stripeCustomerId: 'cus_race2',
    });
    await store.putKey(rec);
    await store.addCredits(rec.hash, 2);
    const held = await store.reserveVerify({
      requestId: 'dql_c_or_r',
      keyHash: rec.hash,
      payloadDigest: DIGEST_A,
      dailyCap: 10,
      paygOptIn: false,
    });
    expect(held.kind).toBe('ok');
    expect(await store.creditBalance(rec.hash)).toBe(1);

    await Promise.all([
      store.commitVerifyReservation(holdOf(held)),
      store.releaseVerifyReservation(holdOf(held)),
    ]);
    const credits = await store.creditBalance(rec.hash);
    const usage = await store.usageToday(rec.hash);
    expect(credits === 1 || credits === 2).toBe(true);
    if (credits === 1) expect(usage).toBe(1);
    else expect(usage).toBe(0);
  });

  it('two accounts with the same requestId reserve independently', async () => {
    const store = new UpstashKeyStore(createMemoryKv());
    const aKey = generateApiKey();
    const bKey = generateApiKey();
    const a = newStoredKeyRecord({
      plaintextKey: aKey,
      owner: 'ss:cus_a',
      stripeCustomerId: 'cus_a',
    });
    const b = newStoredKeyRecord({
      plaintextKey: bKey,
      owner: 'ss:cus_b',
      stripeCustomerId: 'cus_b',
    });
    await store.putKey(a);
    await store.putKey(b);
    await store.addCredits(a.hash, 2);
    await store.addCredits(b.hash, 2);

    const heldA = await store.reserveVerify({
      requestId: 'client-1',
      keyHash: a.hash,
      payloadDigest: DIGEST_A,
      dailyCap: 10,
      paygOptIn: false,
    });
    const heldB = await store.reserveVerify({
      requestId: 'client-1',
      keyHash: b.hash,
      payloadDigest: DIGEST_B,
      dailyCap: 10,
      paygOptIn: false,
    });
    expect(heldA.kind).toBe('ok');
    expect(heldB.kind).toBe('ok');
    expect(await store.creditBalance(a.hash)).toBe(1);
    expect(await store.usageToday(a.hash)).toBe(1);
    expect(await store.creditBalance(b.hash)).toBe(1);
    expect(await store.usageToday(b.hash)).toBe(1);
  });

  it('same id different payload is conflict; no extra debit', async () => {
    const store = new UpstashKeyStore(createMemoryKv());
    const key = generateApiKey();
    const rec = newStoredKeyRecord({
      plaintextKey: key,
      owner: 'ss:cus_pay',
      stripeCustomerId: 'cus_pay',
    });
    await store.putKey(rec);
    await store.addCredits(rec.hash, 2);
    const first = await store.reserveVerify({
      requestId: 'dql_payload',
      keyHash: rec.hash,
      payloadDigest: DIGEST_A,
      dailyCap: 10,
      paygOptIn: false,
    });
    expect(first.kind).toBe('ok');
    const mismatch = await store.reserveVerify({
      requestId: 'dql_payload',
      keyHash: rec.hash,
      payloadDigest: DIGEST_B,
      dailyCap: 10,
      paygOptIn: false,
    });
    expect(mismatch.kind).toBe('conflict');
    if (mismatch.kind === 'conflict') expect(mismatch.reason).toBe('payload');
    expect(await store.creditBalance(rec.hash)).toBe(1);
    expect(await store.usageToday(rec.hash)).toBe(1);
  });

  it('committed replay returns stored result without a new debit', async () => {
    const store = new UpstashKeyStore(createMemoryKv());
    const key = generateApiKey();
    const rec = newStoredKeyRecord({
      plaintextKey: key,
      owner: 'ss:cus_rep',
      stripeCustomerId: 'cus_rep',
    });
    await store.putKey(rec);
    await store.addCredits(rec.hash, 2);
    const first = await store.reserveVerify({
      requestId: 'dql_replay',
      keyHash: rec.hash,
      payloadDigest: DIGEST_A,
      dailyCap: 10,
      paygOptIn: false,
    });
    expect(first.kind).toBe('ok');
    await store.commitVerifyReservation({ ...holdOf(first), result: { id: 'stored' }, meter: 'n/a' });
    const replay = await store.reserveVerify({
      requestId: 'dql_replay',
      keyHash: rec.hash,
      payloadDigest: DIGEST_A,
      dailyCap: 10,
      paygOptIn: false,
    });
    expect(replay.kind).toBe('replay');
    if (replay.kind === 'replay') expect(replay.reservation.result).toEqual({ id: 'stored' });
    expect(await store.creditBalance(rec.hash)).toBe(1);
    expect(await store.usageToday(rec.hash)).toBe(1);
  });

  it('expired held is recovered and restores credit + cap', async () => {
    const store = new UpstashKeyStore(createMemoryKv());
    const key = generateApiKey();
    const rec = newStoredKeyRecord({
      plaintextKey: key,
      owner: 'ss:cus_ttl',
      stripeCustomerId: 'cus_ttl',
    });
    await store.putKey(rec);
    await store.addCredits(rec.hash, 2);
    const t0 = new Date('2026-08-15T00:00:00.000Z');
    const held = await store.reserveVerify({
      requestId: 'dql_ttl',
      keyHash: rec.hash,
      payloadDigest: DIGEST_A,
      dailyCap: 10,
      paygOptIn: false,
      now: t0,
    });
    expect(held.kind).toBe('ok');
    expect(await store.creditBalance(rec.hash)).toBe(1);
    expect(await store.usageToday(rec.hash, t0)).toBe(1);

    const later = new Date(t0.getTime() + 16 * 60 * 1000);
    expect(
      await store.recoverExpiredVerifyReservation({
        requestId: 'dql_ttl',
        keyHash: rec.hash,
        now: later,
      }),
    ).toBe('released');
    expect(await store.creditBalance(rec.hash)).toBe(2);
    expect(await store.usageToday(rec.hash, t0)).toBe(0);

    const swept = await store.recoverExpiredHeldReservations(later);
    expect(swept).toBe(0);
  });

  it('sweep refunds an expired hold without a client retry of that id', async () => {
    const store = new UpstashKeyStore(createMemoryKv());
    const key = generateApiKey();
    const rec = newStoredKeyRecord({
      plaintextKey: key,
      owner: 'ss:cus_sweep',
      stripeCustomerId: 'cus_sweep',
    });
    await store.putKey(rec);
    await store.addCredits(rec.hash, 2);
    const t0 = new Date('2026-08-15T00:00:00.000Z');
    const held = await store.reserveVerify({
      requestId: 'unique-crash-id',
      keyHash: rec.hash,
      payloadDigest: DIGEST_A,
      dailyCap: 10,
      paygOptIn: false,
      now: t0,
    });
    expect(held.kind).toBe('ok');
    expect(await store.creditBalance(rec.hash)).toBe(1);
    const later = new Date(t0.getTime() + 16 * 60 * 1000);
    expect(await store.recoverExpiredHeldReservations(later)).toBe(1);
    expect(await store.creditBalance(rec.hash)).toBe(2);
    expect(await store.usageToday(rec.hash, t0)).toBe(0);
  });

  it('stale fence commit is a no-op after a newer hold', async () => {
    const store = new UpstashKeyStore(createMemoryKv());
    const key = generateApiKey();
    const rec = newStoredKeyRecord({
      plaintextKey: key,
      owner: 'ss:cus_fence',
      stripeCustomerId: 'cus_fence',
    });
    await store.putKey(rec);
    await store.addCredits(rec.hash, 3);
    const t0 = new Date('2026-08-15T00:00:00.000Z');
    const first = await store.reserveVerify({
      requestId: 'dql_fence',
      keyHash: rec.hash,
      payloadDigest: DIGEST_A,
      dailyCap: 10,
      paygOptIn: false,
      now: t0,
    });
    expect(first.kind).toBe('ok');
    const stale = holdOf(first);
    const later = new Date(t0.getTime() + 16 * 60 * 1000);
    const next = await store.reserveVerify({
      requestId: 'dql_fence',
      keyHash: rec.hash,
      payloadDigest: DIGEST_A,
      dailyCap: 10,
      paygOptIn: false,
      now: later,
    });
    expect(next.kind).toBe('ok');
    if (next.kind !== 'ok') return;
    expect(next.reservation.fence).not.toBe(stale.fence);
    expect(await store.creditBalance(rec.hash)).toBe(2);

    expect(
      await store.commitVerifyReservation({
        ...stale,
        result: { stale: true },
        meter: 'n/a',
      }),
    ).toBe('noop');
    expect(await store.releaseVerifyReservation(stale)).toBe('noop');
    expect(await store.creditBalance(rec.hash)).toBe(2);

    expect(
      await store.commitVerifyReservation({
        ...holdOf(next),
        result: { fresh: true },
        meter: 'n/a',
      }),
    ).toBe('committed');
    const replay = await store.reserveVerify({
      requestId: 'dql_fence',
      keyHash: rec.hash,
      payloadDigest: DIGEST_A,
      dailyCap: 10,
      paygOptIn: false,
      now: later,
    });
    expect(replay.kind).toBe('replay');
    if (replay.kind === 'replay') expect(replay.reservation.result).toEqual({ fresh: true });
    expect(await store.creditBalance(rec.hash)).toBe(2);
  });

  it('commit EVAL failure is acknowledged as error; hold stays releasable', async () => {
    const kv = createMemoryKv();
    const orig = kv.eval.bind(kv);
    kv.eval = (script, keys, args) => {
      if (String(script).includes('DQL_COMMIT_V3')) return Promise.reject(new Error('EVAL failed'));
      return orig(script, keys, args);
    };
    const store = new UpstashKeyStore(kv);
    const key = generateApiKey();
    const rec = newStoredKeyRecord({
      plaintextKey: key,
      owner: 'ss:cus_commit_fail',
      stripeCustomerId: 'cus_commit_fail',
    });
    await store.putKey(rec);
    await store.addCredits(rec.hash, 2);
    const held = await store.reserveVerify({
      requestId: 'dql_commit_fail',
      keyHash: rec.hash,
      payloadDigest: DIGEST_A,
      dailyCap: 10,
      paygOptIn: false,
    });
    expect(held.kind).toBe('ok');
    expect(await store.commitVerifyReservation({ ...holdOf(held), result: { id: 'x' } })).toBe(
      'error',
    );
    expect(await store.creditBalance(rec.hash)).toBe(1);
    const again = await store.reserveVerify({
      requestId: 'dql_commit_fail',
      keyHash: rec.hash,
      payloadDigest: DIGEST_A,
      dailyCap: 10,
      paygOptIn: false,
    });
    expect(again.kind).toBe('in_progress');
    expect(await store.releaseVerifyReservation(holdOf(held))).toBe('released');
    expect(await store.creditBalance(rec.hash)).toBe(2);
  });

  it('sweep does not refund meter_pending', async () => {
    const store = new UpstashKeyStore(createMemoryKv());
    const key = generateApiKey();
    const rec = newStoredKeyRecord({
      plaintextKey: key,
      owner: 'ss:cus_pending',
      stripeCustomerId: 'cus_pending',
      paygOptIn: true,
    });
    await store.putKey(rec);
    await store.setCreditBalance(rec.hash, 0);
    const t0 = new Date('2026-08-15T00:00:00.000Z');
    const held = await store.reserveVerify({
      requestId: 'dql_pending',
      keyHash: rec.hash,
      payloadDigest: DIGEST_A,
      dailyCap: 10,
      paygOptIn: true,
      now: t0,
    });
    expect(held.kind).toBe('ok');
    expect(await store.persistMeterPending({ ...holdOf(held), result: { id: 'pending' } })).toBe(
      'pending',
    );
    const later = new Date(t0.getTime() + 16 * 60 * 1000);
    expect(await store.recoverExpiredHeldReservations(later)).toBe(0);
    expect(await store.usageToday(rec.hash, t0)).toBe(1);
    const again = await store.reserveVerify({
      requestId: 'dql_pending',
      keyHash: rec.hash,
      payloadDigest: DIGEST_A,
      dailyCap: 10,
      paygOptIn: true,
      now: later,
    });
    expect(again.kind).toBe('meter_pending');
    if (again.kind === 'meter_pending') expect(again.reservation.result).toEqual({ id: 'pending' });
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
