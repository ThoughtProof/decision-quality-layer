/**
 * Persisted billable API-key store (Upstash Redis).
 *
 * Env `DQL_API_KEYS` remains the bootstrap registry (canary / guardian-pwa /
 * manual dev_access). Self-serve keys are minted here so Production can auth
 * without editing Vercel env.
 *
 * Redis layout (never plaintext after create):
 *   dql:key:<sha256hex>           → StoredKeyRecord
 *   dql:owner-cus:<owner>         → cus_…
 *   dql:checkout:<session_id>     → CheckoutMintState
 *   dql:reveal:<token>            → { key }  (short TTL, GETDEL once)
 *   dql:mint-lock:<session_id>    → "1" (short TTL, mint race)
 *
 * Usage counters stay on `dql:usage:<sha256[:24]>:<day>` (src/auth/usage.ts).
 */

import { Redis } from '@upstash/redis';

import { DEFAULT_DAILY_CAP, type ApiKeyRecord } from './keys.js';
import { keyDisplayPrefix, sha256Hex } from './key-hash.js';

export const KEY_RECORD_PREFIX = 'dql:key:';
export const OWNER_CUS_PREFIX = 'dql:owner-cus:';
export const CHECKOUT_PREFIX = 'dql:checkout:';
export const REVEAL_PREFIX = 'dql:reveal:';
export const MINT_LOCK_PREFIX = 'dql:mint-lock:';

export const REVEAL_TTL_SEC = 15 * 60;
export const MINT_LOCK_TTL_SEC = 60;

export interface StoredKeyRecord {
  hash: string;
  prefix: string;
  owner: string;
  stripe_customer_id: string;
  created: string;
  revoked: boolean;
  dev_access: false;
  daily_cap: number;
  source: 'self_serve';
}

export interface CheckoutMintState {
  session_id: string;
  customer_id: string;
  owner: string;
  status: 'pending' | 'minted';
  key_hash?: string;
  prefix?: string;
  reveal_token?: string;
  minted_at?: string;
}

export interface RevealPayload {
  key: string;
}

export interface KvStore {
  get<T = unknown>(key: string): Promise<T | null>;
  set(
    key: string,
    value: unknown,
    opts?: { nx?: boolean; ex?: number },
  ): Promise<'OK' | string | boolean | null>;
  del(...keys: string[]): Promise<number>;
  getdel?<T = unknown>(key: string): Promise<T | null>;
}

export interface KeyStore {
  lookup(plaintextKey: string): Promise<ApiKeyRecord | undefined>;
  getRecordByHash(hash: string): Promise<StoredKeyRecord | null>;
  putKey(record: StoredKeyRecord): Promise<void>;
  revokeByHash(hash: string): Promise<boolean>;
  getCustomerByOwner(owner: string): Promise<string | undefined>;
  putCustomerMap(owner: string, customerId: string): Promise<void>;
  getCheckout(sessionId: string): Promise<CheckoutMintState | null>;
  putCheckout(state: CheckoutMintState): Promise<void>;
  putReveal(token: string, plaintextKey: string, ttlSec?: number): Promise<void>;
  consumeReveal(token: string): Promise<string | null>;
  acquireMintLock(sessionId: string): Promise<boolean>;
}

function asRecord(v: unknown): StoredKeyRecord | null {
  if (v == null) return null;
  let obj: unknown = v;
  if (typeof v === 'string') {
    try {
      obj = JSON.parse(v);
    } catch {
      return null;
    }
  }
  if (typeof obj !== 'object' || obj === null) return null;
  const r = obj as Record<string, unknown>;
  if (typeof r.hash !== 'string' || typeof r.owner !== 'string') return null;
  if (typeof r.stripe_customer_id !== 'string' || !r.stripe_customer_id.startsWith('cus_')) {
    return null;
  }
  return {
    hash: r.hash,
    prefix: typeof r.prefix === 'string' ? r.prefix : 'dqlk_…',
    owner: r.owner,
    stripe_customer_id: r.stripe_customer_id,
    created: typeof r.created === 'string' ? r.created : new Date().toISOString(),
    revoked: r.revoked === true,
    dev_access: false,
    daily_cap:
      typeof r.daily_cap === 'number' && Number.isFinite(r.daily_cap) && r.daily_cap > 0
        ? Math.floor(r.daily_cap)
        : DEFAULT_DAILY_CAP,
    source: 'self_serve',
  };
}

function asCheckout(v: unknown): CheckoutMintState | null {
  if (v == null) return null;
  let obj: unknown = v;
  if (typeof v === 'string') {
    try {
      obj = JSON.parse(v);
    } catch {
      return null;
    }
  }
  if (typeof obj !== 'object' || obj === null) return null;
  const r = obj as Record<string, unknown>;
  if (typeof r.session_id !== 'string' || typeof r.customer_id !== 'string') return null;
  if (typeof r.owner !== 'string') return null;
  return {
    session_id: r.session_id,
    customer_id: r.customer_id,
    owner: r.owner,
    status: r.status === 'minted' ? 'minted' : 'pending',
    key_hash: typeof r.key_hash === 'string' ? r.key_hash : undefined,
    prefix: typeof r.prefix === 'string' ? r.prefix : undefined,
    reveal_token: typeof r.reveal_token === 'string' ? r.reveal_token : undefined,
    minted_at: typeof r.minted_at === 'string' ? r.minted_at : undefined,
  };
}

function asReveal(v: unknown): string | null {
  if (v == null) return null;
  if (typeof v === 'string') {
    if (v.startsWith('dqlk_')) return v;
    try {
      const parsed = JSON.parse(v) as unknown;
      if (typeof parsed === 'object' && parsed && typeof (parsed as RevealPayload).key === 'string') {
        return (parsed as RevealPayload).key;
      }
    } catch {
      return null;
    }
    return null;
  }
  if (typeof v === 'object' && typeof (v as RevealPayload).key === 'string') {
    return (v as RevealPayload).key;
  }
  return null;
}

function customerId(v: unknown): string | undefined {
  if (typeof v === 'string' && v.startsWith('cus_')) return v;
  return undefined;
}

export class UpstashKeyStore implements KeyStore {
  constructor(private readonly kv: KvStore) {}

  async lookup(plaintextKey: string): Promise<ApiKeyRecord | undefined> {
    if (!plaintextKey.startsWith('dqlk_')) return undefined;
    try {
      const rec = await this.getRecordByHash(sha256Hex(plaintextKey));
      if (!rec || rec.revoked) return undefined;
      return storedToAuthRecord(rec);
    } catch {
      // Redis failure on store lookup: fail closed for this key (env keys
      // still work — they never reach here). Do not 500 the verify path.
      return undefined;
    }
  }

  async getRecordByHash(hash: string): Promise<StoredKeyRecord | null> {
    return asRecord(await this.kv.get(`${KEY_RECORD_PREFIX}${hash}`));
  }

  async putKey(record: StoredKeyRecord): Promise<void> {
    await this.kv.set(`${KEY_RECORD_PREFIX}${record.hash}`, record);
  }

  async revokeByHash(hash: string): Promise<boolean> {
    const rec = await this.getRecordByHash(hash);
    if (!rec) return false;
    rec.revoked = true;
    await this.putKey(rec);
    return true;
  }

  async getCustomerByOwner(owner: string): Promise<string | undefined> {
    try {
      return customerId(await this.kv.get(`${OWNER_CUS_PREFIX}${owner}`));
    } catch {
      return undefined;
    }
  }

  async putCustomerMap(owner: string, customerIdValue: string): Promise<void> {
    if (!customerIdValue.startsWith('cus_')) return;
    await this.kv.set(`${OWNER_CUS_PREFIX}${owner}`, customerIdValue);
  }

  async getCheckout(sessionId: string): Promise<CheckoutMintState | null> {
    return asCheckout(await this.kv.get(`${CHECKOUT_PREFIX}${sessionId}`));
  }

  async putCheckout(state: CheckoutMintState): Promise<void> {
    await this.kv.set(`${CHECKOUT_PREFIX}${state.session_id}`, state);
  }

  async putReveal(token: string, plaintextKey: string, ttlSec: number = REVEAL_TTL_SEC): Promise<void> {
    await this.kv.set(`${REVEAL_PREFIX}${token}`, { key: plaintextKey } satisfies RevealPayload, {
      ex: ttlSec,
    });
  }

  async consumeReveal(token: string): Promise<string | null> {
    const redisKey = `${REVEAL_PREFIX}${token}`;
    if (this.kv.getdel) {
      return asReveal(await this.kv.getdel(redisKey));
    }
    const v = asReveal(await this.kv.get(redisKey));
    if (v != null) await this.kv.del(redisKey);
    return v;
  }

  async acquireMintLock(sessionId: string): Promise<boolean> {
    const res = await this.kv.set(`${MINT_LOCK_PREFIX}${sessionId}`, '1', {
      nx: true,
      ex: MINT_LOCK_TTL_SEC,
    });
    return res === 'OK' || res === 'ok' || res === true;
  }
}

export function storedToAuthRecord(rec: StoredKeyRecord): ApiKeyRecord {
  return {
    owner: rec.owner,
    dev_access: false,
    daily_cap: rec.daily_cap,
    stripe_customer_id: rec.stripe_customer_id,
    revoked: rec.revoked,
    source: 'store',
  };
}

export function newStoredKeyRecord(opts: {
  plaintextKey: string;
  owner: string;
  stripeCustomerId: string;
  dailyCap?: number;
  now?: () => Date;
}): StoredKeyRecord {
  return {
    hash: sha256Hex(opts.plaintextKey),
    prefix: keyDisplayPrefix(opts.plaintextKey),
    owner: opts.owner,
    stripe_customer_id: opts.stripeCustomerId,
    created: (opts.now ?? (() => new Date()))().toISOString(),
    revoked: false,
    dev_access: false,
    daily_cap: opts.dailyCap ?? DEFAULT_DAILY_CAP,
    source: 'self_serve',
  };
}

export function selfServeOwner(customerIdValue: string): string {
  return `ss:${customerIdValue}`;
}

export function createKeyStore(env: NodeJS.ProcessEnv = process.env): KeyStore | null {
  const url = env.UPSTASH_REDIS_REST_URL;
  const token = env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  const redis = new Redis({ url, token });
  const kv: KvStore = {
    get: (key) => redis.get(key),
    set: async (key, value, opts) => {
      const r =
        opts?.nx && opts.ex != null
          ? await redis.set(key, value, { nx: true, ex: opts.ex })
          : opts?.nx
            ? await redis.set(key, value, { nx: true })
            : opts?.ex != null
              ? await redis.set(key, value, { ex: opts.ex })
              : await redis.set(key, value);
      return (r ?? null) as 'OK' | string | boolean | null;
    },
    del: (...keys) => redis.del(...keys),
    getdel: (key) => redis.getdel(key),
  };
  return new UpstashKeyStore(kv);
}

/** In-memory KvStore for unit tests. */
export function createMemoryKv(): KvStore & { dump(): Map<string, unknown> } {
  const data = new Map<string, { value: unknown; exp?: number }>();
  const now = () => Date.now();
  const alive = (k: string): { value: unknown; exp?: number } | undefined => {
    const row = data.get(k);
    if (!row) return undefined;
    if (row.exp != null && row.exp <= now()) {
      data.delete(k);
      return undefined;
    }
    return row;
  };
  return {
    async get<T = unknown>(key: string): Promise<T | null> {
      const row = alive(key);
      return (row ? (row.value as T) : null) ?? null;
    },
    async set(key, value, opts) {
      if (opts?.nx && alive(key)) return null;
      data.set(key, {
        value,
        exp: opts?.ex != null ? now() + opts.ex * 1000 : undefined,
      });
      return 'OK';
    },
    async del(...keys) {
      let n = 0;
      for (const k of keys) {
        if (data.delete(k)) n += 1;
      }
      return n;
    },
    async getdel<T = unknown>(key: string): Promise<T | null> {
      const row = alive(key);
      if (!row) return null;
      data.delete(key);
      return row.value as T;
    },
    dump() {
      const out = new Map<string, unknown>();
      for (const [k, v] of data) {
        if (alive(k)) out.set(k, v.value);
      }
      return out;
    },
  };
}
