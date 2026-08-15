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
 *   dql:cus-key:<cus_…>           → key hash (one live key per customer)
 *   dql:checkout:<session_id>     → CheckoutMintState
 *   dql:reveal:<token>            → { key, account_token }  (short TTL; legacy one-shot)
 *   dql:session-reveal:<cs_…>     → { key, account_token }  (short TTL; re-readable)
 *   dql:mint-lock:<session_id>    → "1" (short TTL, mint race)
 *   dql:credits:<sha256hex>       → integer balance (atomic DECR)
 *   dql:credit-ledger:<sha256hex> → { grants: CreditGrant[] }
 *   dql:trial-email:<sha256(email)> → claim marker
 *   dql:trial-fp:<card_fingerprint> → claim marker
 *   dql:account:<sha256(dqla_…)>    → live key hash (account session; hash only)
 *   dql:reserve:<keyHash>:<requestId> → VerifyReservation (per-account idempotency namespace)
 *   dql:reserve-held                  → ZSET score=leaseExpiresAt member=<keyHash>:<requestId>
 *   dql:reserve-fence                 → INCR fencing token (commit/release must match)
 *
 * Usage counters stay on `dql:usage:<sha256[:24]>:<day>` (src/auth/usage.ts).
 * Credits and daily-cap are both enforced; namespaces do not collide.
 * Account tokens (`dqla_…`) are never stored in plaintext — hash only.
 */

import { Redis } from '@upstash/redis';

import { DEFAULT_DAILY_CAP, type ApiKeyRecord } from './keys.js';
import { keyDisplayPrefix, sha256Hex } from './key-hash.js';
import type { CheckoutPack } from './packs.js';
import { usageCounterKeyFromHash } from './usage.js';
import {
  FENCE_KEY,
  HELD_INDEX_KEY,
  LUA_COMMIT,
  LUA_PENDING,
  LUA_RECOVER,
  LUA_RELEASE,
  LUA_RESERVE,
  LUA_SWEEP,
  RESERVE_LEASE_SEC,
  RESERVE_RECORD_TTL_SEC,
  dispatchMemoryEval,
  parseReserveEval,
  reservationRedisKey,
} from './verify-reservation-atomic.js';

export const KEY_RECORD_PREFIX = 'dql:key:';
export const OWNER_CUS_PREFIX = 'dql:owner-cus:';
export const CUS_KEY_PREFIX = 'dql:cus-key:';
export const CHECKOUT_PREFIX = 'dql:checkout:';
export const REVEAL_PREFIX = 'dql:reveal:';
export const SESSION_REVEAL_PREFIX = 'dql:session-reveal:';
export const MINT_LOCK_PREFIX = 'dql:mint-lock:';
export const CREDITS_PREFIX = 'dql:credits:';
export const CREDIT_LEDGER_PREFIX = 'dql:credit-ledger:';
export const TRIAL_EMAIL_PREFIX = 'dql:trial-email:';
export const TRIAL_FP_PREFIX = 'dql:trial-fp:';
export const ACCOUNT_PREFIX = 'dql:account:';
export const RESERVE_PREFIX = 'dql:reserve:';

export const REVEAL_TTL_SEC = 15 * 60;
export const MINT_LOCK_TTL_SEC = 60;
export const RESERVE_TTL_SEC = RESERVE_LEASE_SEC;

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
  /** PAYG meter is opt-in. Zero credits + false → hard-stop. */
  payg_opt_in: boolean;
  /** True if this key ever received a trial grant (distinct from paid packs). */
  trial: boolean;
  email_normalized?: string;
  /** sha256 of the one-time-issued `dqla_…` account session. Never plaintext. */
  account_token_hash?: string;
}

export type CheckoutFulfillStatus =
  | 'pending'
  | 'minted'
  | 'credits_added'
  | 'payg_enabled'
  | 'trial_used'
  | 'trial_no_card'
  | 'rejected';

export interface CheckoutMintState {
  session_id: string;
  customer_id: string;
  owner: string;
  status: CheckoutFulfillStatus;
  pack?: CheckoutPack;
  key_hash?: string;
  prefix?: string;
  reveal_token?: string;
  minted_at?: string;
  credits_added?: number;
  trial?: boolean;
  reason?: string;
}

export interface CreditGrant {
  pack: CheckoutPack;
  credits: number;
  trial: boolean;
  session_id: string;
  at: string;
}

export interface CreditLedgerRecord {
  grants: CreditGrant[];
}

export interface RevealPayload {
  key: string;
  /** Plaintext `dqla_…` — only inside the short-TTL reveal slot, consumed once. */
  account_token?: string;
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
  incrby(key: string, n: number): Promise<number>;
  decr(key: string): Promise<number>;
  /** Atomic script. Memory store runs the JS equivalent synchronously. */
  eval(script: string, keys: string[], args: string[]): Promise<unknown>;
}

export type ConsumeCreditResult = 'consumed' | 'empty' | 'error';
export type TrialClaimResult = 'ok' | 'already_used';

export type VerifyReservationStatus = 'held' | 'committed' | 'released' | 'meter_pending';

export interface VerifyReservation {
  requestId: string;
  keyHash: string;
  payloadDigest: string;
  dayUtc: string;
  creditHeld: boolean;
  capHeld: boolean;
  billing: 'credit' | 'payg';
  status: VerifyReservationStatus;
  /** Monotonic token for this hold. Commit/release no-op if it does not match. */
  fence: number;
  /** Unix ms. After this, a held reservation is stale and must be refunded. */
  leaseExpiresAt: number;
  /** Stored verify result after commit or meter_pending. Never contains dqlk_/dqla_. */
  result?: unknown;
  meter?: 'ok' | 'error' | 'skipped' | 'n/a';
}

export type ReserveVerifyResult =
  | { kind: 'ok'; reservation: VerifyReservation }
  | { kind: 'in_progress'; reservation: VerifyReservation }
  | { kind: 'replay'; reservation: VerifyReservation }
  | { kind: 'meter_pending'; reservation: VerifyReservation }
  | { kind: 'conflict'; reason: 'account' | 'payload' }
  | { kind: 'empty' }
  | { kind: 'quota' }
  | { kind: 'error' };

export type CommitReservationAck = 'committed' | 'noop' | 'error';
export type PersistPendingAck = 'pending' | 'noop' | 'error';
export type ReleaseReservationAck = 'released' | 'noop';

export interface KeyStore {
  lookup(plaintextKey: string): Promise<ApiKeyRecord | undefined>;
  getRecordByHash(hash: string): Promise<StoredKeyRecord | null>;
  putKey(record: StoredKeyRecord): Promise<void>;
  revokeByHash(hash: string): Promise<boolean>;
  getCustomerByOwner(owner: string): Promise<string | undefined>;
  putCustomerMap(owner: string, customerId: string): Promise<void>;
  getKeyHashByCustomer(customerId: string): Promise<string | undefined>;
  putCustomerKey(customerId: string, keyHash: string): Promise<void>;
  getCheckout(sessionId: string): Promise<CheckoutMintState | null>;
  putCheckout(state: CheckoutMintState): Promise<void>;
  putReveal(token: string, payload: RevealPayload, ttlSec?: number): Promise<void>;
  consumeReveal(token: string): Promise<RevealPayload | null>;
  /** Session-scoped reveal: re-readable until TTL (survives double-fetch / remount). */
  putSessionReveal(sessionId: string, payload: RevealPayload, ttlSec?: number): Promise<void>;
  getSessionReveal(sessionId: string): Promise<RevealPayload | null>;
  clearSessionReveal(sessionId: string): Promise<void>;
  acquireMintLock(sessionId: string): Promise<boolean>;
  consumeCredit(keyHash: string): Promise<ConsumeCreditResult>;
  addCredits(keyHash: string, amount: number): Promise<number>;
  creditBalance(keyHash: string): Promise<number>;
  setCreditBalance(keyHash: string, amount: number): Promise<void>;
  moveCredits(fromHash: string, toHash: string): Promise<number>;
  moveCreditLedger(fromHash: string, toHash: string): Promise<void>;
  recordCreditGrant(keyHash: string, grant: CreditGrant): Promise<void>;
  getCreditLedger(keyHash: string): Promise<CreditLedgerRecord | null>;
  claimTrial(emailNormalized: string, cardFingerprint: string): Promise<TrialClaimResult>;
  putAccountIndex(accountTokenHash: string, keyHash: string): Promise<void>;
  lookupByAccountToken(plaintextToken: string): Promise<StoredKeyRecord | null>;
  usageToday(keyHash: string, now?: Date): Promise<number>;
  reserveVerify(opts: {
    requestId: string;
    keyHash: string;
    payloadDigest: string;
    dailyCap: number;
    paygOptIn: boolean;
    now?: Date;
  }): Promise<ReserveVerifyResult>;
  commitVerifyReservation(opts: {
    requestId: string;
    keyHash: string;
    fence: number;
    result?: unknown;
    meter?: VerifyReservation['meter'];
  }): Promise<CommitReservationAck>;
  persistMeterPending(opts: {
    requestId: string;
    keyHash: string;
    fence: number;
    result: unknown;
  }): Promise<PersistPendingAck>;
  releaseVerifyReservation(opts: {
    requestId: string;
    keyHash: string;
    fence: number;
  }): Promise<ReleaseReservationAck>;
  recoverExpiredVerifyReservation(opts: {
    requestId: string;
    keyHash: string;
    now?: Date;
  }): Promise<'released' | 'noop'>;
  recoverExpiredHeldReservations(now?: Date): Promise<number>;
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
    payg_opt_in: r.payg_opt_in === true,
    trial: r.trial === true,
    email_normalized: typeof r.email_normalized === 'string' ? r.email_normalized : undefined,
    account_token_hash: typeof r.account_token_hash === 'string' ? r.account_token_hash : undefined,
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
  const status = parseCheckoutStatus(r.status);
  return {
    session_id: r.session_id,
    customer_id: r.customer_id,
    owner: r.owner,
    status,
    pack: isPackSlug(r.pack) ? r.pack : undefined,
    key_hash: typeof r.key_hash === 'string' ? r.key_hash : undefined,
    prefix: typeof r.prefix === 'string' ? r.prefix : undefined,
    reveal_token: typeof r.reveal_token === 'string' ? r.reveal_token : undefined,
    minted_at: typeof r.minted_at === 'string' ? r.minted_at : undefined,
    credits_added: typeof r.credits_added === 'number' ? r.credits_added : undefined,
    trial: r.trial === true ? true : undefined,
    reason: typeof r.reason === 'string' ? r.reason : undefined,
  };
}

const CHECKOUT_STATUSES: CheckoutFulfillStatus[] = [
  'pending',
  'minted',
  'credits_added',
  'payg_enabled',
  'trial_used',
  'trial_no_card',
  'rejected',
];

function parseCheckoutStatus(v: unknown): CheckoutFulfillStatus {
  return typeof v === 'string' && (CHECKOUT_STATUSES as string[]).includes(v)
    ? (v as CheckoutFulfillStatus)
    : 'pending';
}

function isPackSlug(v: unknown): v is CheckoutPack {
  return v === 'trial' || v === 'starter' || v === 'plus' || v === 'payg';
}

function asInt(v: unknown): number {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.floor(v);
  if (typeof v === 'string' && /^-?\d+$/.test(v.trim())) return parseInt(v, 10);
  return 0;
}

function asLedger(v: unknown): CreditLedgerRecord | null {
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
  const grantsRaw = (obj as { grants?: unknown }).grants;
  if (!Array.isArray(grantsRaw)) return { grants: [] };
  const grants: CreditGrant[] = [];
  for (const g of grantsRaw) {
    if (typeof g !== 'object' || g === null) continue;
    const row = g as Record<string, unknown>;
    if (!isPackSlug(row.pack)) continue;
    if (typeof row.credits !== 'number' || typeof row.session_id !== 'string') continue;
    grants.push({
      pack: row.pack,
      credits: Math.floor(row.credits),
      trial: row.trial === true,
      session_id: row.session_id,
      at: typeof row.at === 'string' ? row.at : new Date().toISOString(),
    });
  }
  return { grants };
}

function asReveal(v: unknown): RevealPayload | null {
  if (v == null) return null;
  if (typeof v === 'string') {
    if (v.startsWith('dqlk_')) return { key: v };
    try {
      return asReveal(JSON.parse(v) as unknown);
    } catch {
      return null;
    }
  }
  if (typeof v !== 'object') return null;
  const key = (v as RevealPayload).key;
  if (typeof key !== 'string' || !key.startsWith('dqlk_')) return null;
  const token = (v as RevealPayload).account_token;
  return {
    key,
    account_token: typeof token === 'string' && token.startsWith('dqla_') ? token : undefined,
  };
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

  async putReveal(token: string, payload: RevealPayload, ttlSec: number = REVEAL_TTL_SEC): Promise<void> {
    await this.kv.set(`${REVEAL_PREFIX}${token}`, payload, { ex: ttlSec });
  }

  async consumeReveal(token: string): Promise<RevealPayload | null> {
    const redisKey = `${REVEAL_PREFIX}${token}`;
    if (this.kv.getdel) {
      return asReveal(await this.kv.getdel(redisKey));
    }
    const v = asReveal(await this.kv.get(redisKey));
    if (v != null) await this.kv.del(redisKey);
    return v;
  }

  async putSessionReveal(
    sessionId: string,
    payload: RevealPayload,
    ttlSec: number = REVEAL_TTL_SEC,
  ): Promise<void> {
    if (!sessionId.startsWith('cs_')) return;
    await this.kv.set(`${SESSION_REVEAL_PREFIX}${sessionId}`, payload, { ex: ttlSec });
  }

  async getSessionReveal(sessionId: string): Promise<RevealPayload | null> {
    if (!sessionId.startsWith('cs_')) return null;
    return asReveal(await this.kv.get(`${SESSION_REVEAL_PREFIX}${sessionId}`));
  }

  async clearSessionReveal(sessionId: string): Promise<void> {
    if (!sessionId.startsWith('cs_')) return;
    await this.kv.del(`${SESSION_REVEAL_PREFIX}${sessionId}`);
  }

  async acquireMintLock(sessionId: string): Promise<boolean> {
    const res = await this.kv.set(`${MINT_LOCK_PREFIX}${sessionId}`, '1', {
      nx: true,
      ex: MINT_LOCK_TTL_SEC,
    });
    return res === 'OK' || res === 'ok' || res === true;
  }

  async getKeyHashByCustomer(customerId: string): Promise<string | undefined> {
    if (!customerId.startsWith('cus_')) return undefined;
    try {
      const v = await this.kv.get(`${CUS_KEY_PREFIX}${customerId}`);
      return typeof v === 'string' && v.length > 0 ? v : undefined;
    } catch {
      return undefined;
    }
  }

  async putCustomerKey(customerId: string, keyHash: string): Promise<void> {
    if (!customerId.startsWith('cus_') || !keyHash) return;
    await this.kv.set(`${CUS_KEY_PREFIX}${customerId}`, keyHash);
  }

  async consumeCredit(keyHash: string): Promise<ConsumeCreditResult> {
    if (!keyHash) return 'error';
    const redisKey = `${CREDITS_PREFIX}${keyHash}`;
    try {
      const n = await this.kv.decr(redisKey);
      if (n >= 0) return 'consumed';
      await this.kv.incrby(redisKey, 1);
      return 'empty';
    } catch {
      return 'error';
    }
  }

  async addCredits(keyHash: string, amount: number): Promise<number> {
    const n = Math.floor(amount);
    if (!keyHash || n <= 0) return this.creditBalance(keyHash);
    return this.kv.incrby(`${CREDITS_PREFIX}${keyHash}`, n);
  }

  async creditBalance(keyHash: string): Promise<number> {
    if (!keyHash) return 0;
    try {
      return Math.max(0, asInt(await this.kv.get(`${CREDITS_PREFIX}${keyHash}`)));
    } catch {
      return 0;
    }
  }

  async setCreditBalance(keyHash: string, amount: number): Promise<void> {
    if (!keyHash) return;
    await this.kv.set(`${CREDITS_PREFIX}${keyHash}`, Math.max(0, Math.floor(amount)));
  }

  async moveCredits(fromHash: string, toHash: string): Promise<number> {
    const bal = await this.creditBalance(fromHash);
    if (fromHash && fromHash !== toHash) await this.setCreditBalance(fromHash, 0);
    if (bal > 0 && toHash) return this.addCredits(toHash, bal);
    return this.creditBalance(toHash);
  }

  async moveCreditLedger(fromHash: string, toHash: string): Promise<void> {
    if (!fromHash || !toHash || fromHash === toHash) return;
    const ledger = await this.getCreditLedger(fromHash);
    if (!ledger) return;
    const destKey = `${CREDIT_LEDGER_PREFIX}${toHash}`;
    const existing = asLedger(await this.kv.get(destKey)) ?? { grants: [] };
    existing.grants.push(...ledger.grants);
    await this.kv.set(destKey, existing);
    await this.kv.del(`${CREDIT_LEDGER_PREFIX}${fromHash}`);
  }

  async putAccountIndex(accountTokenHash: string, keyHash: string): Promise<void> {
    if (!accountTokenHash || !keyHash) return;
    await this.kv.set(`${ACCOUNT_PREFIX}${accountTokenHash}`, keyHash);
  }

  async lookupByAccountToken(plaintextToken: string): Promise<StoredKeyRecord | null> {
    if (!plaintextToken.startsWith('dqla_')) return null;
    try {
      const v = await this.kv.get(`${ACCOUNT_PREFIX}${sha256Hex(plaintextToken)}`);
      const keyHash = typeof v === 'string' && v.length > 0 ? v : undefined;
      if (!keyHash) return null;
      return this.getRecordByHash(keyHash);
    } catch {
      return null;
    }
  }

  async usageToday(keyHash: string, now: Date = new Date()): Promise<number> {
    if (!keyHash) return 0;
    try {
      const day = now.toISOString().slice(0, 10);
      return Math.max(0, asInt(await this.kv.get(usageCounterKeyFromHash(keyHash, day))));
    } catch {
      return 0;
    }
  }

  async reserveVerify(opts: {
    requestId: string;
    keyHash: string;
    payloadDigest: string;
    dailyCap: number;
    paygOptIn: boolean;
    now?: Date;
  }): Promise<ReserveVerifyResult> {
    if (!opts.requestId || !opts.keyHash || !opts.payloadDigest) return { kind: 'error' };
    const now = opts.now ?? new Date();
    const dayUtc = now.toISOString().slice(0, 10);
    try {
      const raw = await this.kv.eval(
        LUA_RESERVE,
        [
          reservationRedisKey(opts.keyHash, opts.requestId),
          `${CREDITS_PREFIX}${opts.keyHash}`,
          usageCounterKeyFromHash(opts.keyHash, dayUtc),
          HELD_INDEX_KEY,
          FENCE_KEY,
        ],
        [
          opts.requestId,
          opts.keyHash,
          opts.payloadDigest,
          dayUtc,
          String(opts.dailyCap),
          opts.paygOptIn ? '1' : '0',
          String(RESERVE_RECORD_TTL_SEC),
          String(RESERVE_LEASE_SEC),
          String(now.getTime()),
        ],
      );
      return parseReserveEval(raw);
    } catch {
      return { kind: 'error' };
    }
  }

  async commitVerifyReservation(opts: {
    requestId: string;
    keyHash: string;
    fence: number;
    result?: unknown;
    meter?: VerifyReservation['meter'];
  }): Promise<CommitReservationAck> {
    if (!opts.requestId || !opts.keyHash) return 'error';
    try {
      const raw = await this.kv.eval(
        LUA_COMMIT,
        [reservationRedisKey(opts.keyHash, opts.requestId), HELD_INDEX_KEY],
        [
          String(RESERVE_RECORD_TTL_SEC),
          JSON.stringify(opts.result ?? null),
          opts.meter ?? 'n/a',
          String(opts.fence),
        ],
      );
      return raw === 'committed' ? 'committed' : 'noop';
    } catch {
      return 'error';
    }
  }

  async persistMeterPending(opts: {
    requestId: string;
    keyHash: string;
    fence: number;
    result: unknown;
  }): Promise<PersistPendingAck> {
    if (!opts.requestId || !opts.keyHash) return 'error';
    try {
      const raw = await this.kv.eval(
        LUA_PENDING,
        [reservationRedisKey(opts.keyHash, opts.requestId), HELD_INDEX_KEY],
        [String(RESERVE_RECORD_TTL_SEC), JSON.stringify(opts.result ?? null), String(opts.fence)],
      );
      return raw === 'pending' ? 'pending' : 'noop';
    } catch {
      return 'error';
    }
  }

  async releaseVerifyReservation(opts: {
    requestId: string;
    keyHash: string;
    fence: number;
  }): Promise<ReleaseReservationAck> {
    if (!opts.requestId || !opts.keyHash) return 'noop';
    try {
      const raw = await this.kv.eval(
        LUA_RELEASE,
        [reservationRedisKey(opts.keyHash, opts.requestId), HELD_INDEX_KEY],
        [String(RESERVE_RECORD_TTL_SEC), String(opts.fence)],
      );
      return raw === 'released' ? 'released' : 'noop';
    } catch {
      return 'noop';
    }
  }

  async recoverExpiredVerifyReservation(opts: {
    requestId: string;
    keyHash: string;
    now?: Date;
  }): Promise<'released' | 'noop'> {
    if (!opts.requestId || !opts.keyHash) return 'noop';
    const now = opts.now ?? new Date();
    try {
      const raw = await this.kv.eval(
        LUA_RECOVER,
        [reservationRedisKey(opts.keyHash, opts.requestId), HELD_INDEX_KEY],
        [String(RESERVE_RECORD_TTL_SEC), String(now.getTime())],
      );
      return raw === 'released' ? 'released' : 'noop';
    } catch {
      return 'noop';
    }
  }

  async recoverExpiredHeldReservations(now: Date = new Date()): Promise<number> {
    try {
      const raw = await this.kv.eval(LUA_SWEEP, [HELD_INDEX_KEY], [
        String(RESERVE_RECORD_TTL_SEC),
        String(now.getTime()),
      ]);
      if (typeof raw === 'number' && Number.isFinite(raw)) return Math.max(0, Math.floor(raw));
      if (typeof raw === 'string' && /^-?\d+$/.test(raw)) return Math.max(0, parseInt(raw, 10));
      return 0;
    } catch {
      return 0;
    }
  }

  async recordCreditGrant(keyHash: string, grant: CreditGrant): Promise<void> {
    const redisKey = `${CREDIT_LEDGER_PREFIX}${keyHash}`;
    const existing = asLedger(await this.kv.get(redisKey)) ?? { grants: [] };
    existing.grants.push(grant);
    await this.kv.set(redisKey, existing);
  }

  async getCreditLedger(keyHash: string): Promise<CreditLedgerRecord | null> {
    try {
      return asLedger(await this.kv.get(`${CREDIT_LEDGER_PREFIX}${keyHash}`));
    } catch {
      return null;
    }
  }

  async claimTrial(emailNormalized: string, cardFingerprint: string): Promise<TrialClaimResult> {
    const email = emailNormalized.trim().toLowerCase();
    const fp = cardFingerprint.trim();
    if (!email || !fp) return 'already_used';
    const emailKey = `${TRIAL_EMAIL_PREFIX}${sha256Hex(email)}`;
    const fpKey = `${TRIAL_FP_PREFIX}${fp}`;
    const marker = { at: new Date().toISOString() };
    const emailOk = await this.kv.set(emailKey, marker, { nx: true });
    if (!nxOk(emailOk)) return 'already_used';
    const fpOk = await this.kv.set(fpKey, marker, { nx: true });
    if (!nxOk(fpOk)) return 'already_used';
    return 'ok';
  }
}

function nxOk(res: 'OK' | string | boolean | null): boolean {
  return res === 'OK' || res === 'ok' || res === true;
}

export function storedToAuthRecord(rec: StoredKeyRecord): ApiKeyRecord {
  return {
    owner: rec.owner,
    dev_access: false,
    daily_cap: rec.daily_cap,
    stripe_customer_id: rec.stripe_customer_id,
    revoked: rec.revoked,
    source: 'store',
    payg_opt_in: rec.payg_opt_in === true,
    trial: rec.trial === true,
  };
}

export function newStoredKeyRecord(opts: {
  plaintextKey: string;
  owner: string;
  stripeCustomerId: string;
  dailyCap?: number;
  now?: () => Date;
  paygOptIn?: boolean;
  trial?: boolean;
  emailNormalized?: string;
  accountTokenHash?: string;
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
    payg_opt_in: opts.paygOptIn === true,
    trial: opts.trial === true,
    email_normalized: opts.emailNormalized,
    account_token_hash: opts.accountTokenHash,
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
    incrby: (key, n) => redis.incrby(key, n),
    decr: (key) => redis.decr(key),
    eval: (script, keys, args) => redis.eval(script, keys, args),
  };
  return new UpstashKeyStore(kv);
}

/** In-memory KvStore for unit tests. */
export function createMemoryKv(): KvStore & { dump(): Map<string, unknown> } {
  const data = new Map<string, { value: unknown; exp?: number }>();
  const zsets = new Map<string, Map<string, number>>();
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
    async incrby(key, n) {
      const row = alive(key);
      const next = asInt(row?.value) + n;
      data.set(key, { value: next, exp: row?.exp });
      return next;
    },
    async decr(key) {
      const row = alive(key);
      const next = asInt(row?.value) - 1;
      data.set(key, { value: next, exp: row?.exp });
      return next;
    },
    eval(script, keys, args) {
      // Fully synchronous: equivalent to Redis EVAL (no interleaving).
      const sync = {
        get(key: string): unknown {
          const row = alive(key);
          return row ? row.value : null;
        },
        set(key: string, value: unknown, exSec?: number) {
          data.set(key, {
            value,
            exp: exSec != null ? now() + exSec * 1000 : undefined,
          });
        },
        incrby(key: string, n: number) {
          const row = alive(key);
          const next = asInt(row?.value) + n;
          data.set(key, { value: next, exp: row?.exp });
          return next;
        },
        zadd(key: string, score: number, member: string) {
          const z = zsets.get(key) ?? new Map<string, number>();
          z.set(member, score);
          zsets.set(key, z);
        },
        zrem(key: string, member: string) {
          zsets.get(key)?.delete(member);
        },
        zrangebyscore(key: string, min: number, max: number) {
          const z = zsets.get(key);
          if (!z) return [];
          return [...z.entries()]
            .filter(([, score]) => score >= min && score <= max)
            .sort((a, b) => a[1] - b[1])
            .map(([member]) => member);
        },
      };
      return Promise.resolve(dispatchMemoryEval(sync, script, keys, args));
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
