/**
 * DQL API-key gate — first enforcement slice of the pricing model
 * (docs/PAYMENT.md decision matrix, src/pricing.ts).
 *
 * Matrix implemented here:
 *   sandbox: true                     → free (integration testing, no account)
 *   X-DQL-Key valid + dev_access      → free (manual grant, per relationship)
 *   X-DQL-Key valid + billable        → allowed, usage recorded (Stripe/x402
 *                                       meter rails land separately; the gate
 *                                       already emits the structured usage line)
 *   no key / invalid key              → 402 PAYMENT_REQUIRED (per PAYMENT.md)
 *
 * Key delivery: `X-DQL-Key: dqlk_...` (primary, CORS-allowed) or
 * `Authorization: Bearer dqlk_...` (alias for OpenAI-style clients).
 * Account tokens (`dqla_…`) are not accepted on `X-DQL-Key`. They authorize
 * verify via `X-DQL-Account` / `Authorization: Bearer dqla_…` (see account.ts).
 *
 * Key registry is the union of:
 *   1. Env `DQL_API_KEYS` JSON — bootstrap (canary / guardian-pwa / manual
 *      `dev_access`). Parsed at cold start, no DB round-trip:
 *        {
 *          "dqlk_<hex>": { "owner": "raul",  "dev_access": true,  "daily_cap": 500 },
 *          "dqlk_<hex>": { "owner": "acme",  "dev_access": false, "daily_cap": 2000 }
 *        }
 *   2. Upstash key store (`src/auth/key-store.ts`) — self-serve minted
 *      billable keys (`dev_access: false`), looked up by sha256. Env wins
 *      on collision so the canary cannot be shadowed.
 *
 * `daily_cap` is an operational abuse brake (429), orthogonal to billing.
 * Unknown fields are ignored so the format can grow without a gate change.
 */

import { timingSafeEqual } from 'node:crypto';

import { PRICE_USD_PER_CALL } from '../pricing.js';
import { sha256Hex } from './key-hash.js';

export interface ApiKeyRecord {
  owner: string;
  dev_access: boolean;
  daily_cap: number;
  /** Present on store-minted keys; env keys resolve cus_ via customer map. */
  stripe_customer_id?: string;
  revoked?: boolean;
  source?: 'env' | 'store';
  /** Store keys only. PAYG meter is opt-in; false + 0 credits → hard-stop. */
  payg_opt_in?: boolean;
  /** Store keys only. True when a trial grant is on this key (not a paid pack). */
  trial?: boolean;
}

/** Optional persisted-key lookup (Upstash). Env registry is checked first. */
export interface KeyLookup {
  lookup(plaintextKey: string): Promise<ApiKeyRecord | undefined>;
  /** Atomic prepaid decrement. Store keys only. */
  consumeCredit?(keyHash: string): Promise<'consumed' | 'empty' | 'error'>;
}

export const DEFAULT_DAILY_CAP = 1000;

/** Parse DQL_API_KEYS. Tolerant: bad JSON or bad entries → empty/dropped,
 * never throws (a malformed env must not 500 the whole endpoint). */
export function parseApiKeys(raw: string | undefined): Map<string, ApiKeyRecord> {
  const out = new Map<string, ApiKeyRecord>();
  if (!raw || !raw.trim()) return out;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return out;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return out;
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!key.startsWith('dqlk_') || typeof value !== 'object' || value === null) continue;
    const v = value as Record<string, unknown>;
    out.set(key, {
      owner: typeof v.owner === 'string' && v.owner.length > 0 ? v.owner : 'unknown',
      dev_access: v.dev_access === true,
      daily_cap:
        typeof v.daily_cap === 'number' && Number.isFinite(v.daily_cap) && v.daily_cap > 0
          ? Math.floor(v.daily_cap)
          : DEFAULT_DAILY_CAP,
    });
  }
  return out;
}

type HeaderMap = Record<string, unknown>;

function firstString(v: unknown): string | null {
  if (typeof v === 'string') return v;
  if (Array.isArray(v) && typeof v[0] === 'string') return v[0];
  return null;
}

/** Extract the API key from X-DQL-Key (primary) or Authorization: Bearer (alias). */
export function extractApiKey(headers: HeaderMap): string | null {
  const direct = firstString(headers['x-dql-key']);
  if (direct && direct.trim()) return direct.trim();
  const auth = firstString(headers.authorization ?? headers.Authorization);
  if (auth) {
    const m = /^Bearer\s+(\S+)\s*$/i.exec(auth.trim());
    if (m && m[1]) return m[1];
  }
  return null;
}

export interface AuthErrorPayload {
  error: string;
  code:
    | 'PAYMENT_REQUIRED'
    | 'QUOTA_EXCEEDED'
    | 'CREDITS_EXHAUSTED'
    | 'CREDITS_UNAVAILABLE'
    | 'ACCOUNT_UNAUTHORIZED'
    | 'ACCOUNT_UNAVAILABLE';
  price_usd_per_call?: number;
  access?: string;
  retry_after?: string;
  no_freemium?: true;
}

/** How a store/env key is billed after daily-cap. */
export type AllowBilling = 'dev-access' | 'credit' | 'payg' | 'env-metered';

export type AuthDecision =
  | { kind: 'free_sandbox' }
  | {
      kind: 'allow';
      key: string;
      record: ApiKeyRecord;
      billing: AllowBilling;
      /** `account` = authorized via `dqla_…` (log `key` is the stored hash, never a secret). */
      via?: 'key' | 'account';
    }
  | { kind: 'deny'; status: number; payload: AuthErrorPayload };

/** Usage accounting port — implemented by Upstash (src/auth/usage.ts) or a
 * no-op when Redis is not configured. checkAndRecord returns false when the
 * daily cap is exceeded (call must be rejected with 429). */
export interface UsageGate {
  checkAndRecord(key: string, cap: number): Promise<boolean>;
  /**
   * Same daily-cap counter as `checkAndRecord(plaintext)`, addressed by the
   * stored key hash (sha256 of `dqlk_…`). Needed when the caller holds only
   * `dqla_…` and the plaintext verify key is gone.
   */
  checkAndRecordFromHash?(keyHash: string, cap: number): Promise<boolean>;
}

export const DEV_ACCESS_CONTACT = 'dev-access keys: raul@thoughtproof.ai';

export async function authorizeCall(opts: {
  headers: HeaderMap;
  sandbox: boolean;
  keys: Map<string, ApiKeyRecord>;
  usage: UsageGate;
  /** Self-serve / minted keys. Consulted only after env miss. */
  store?: KeyLookup;
}): Promise<AuthDecision> {
  if (opts.sandbox) return { kind: 'free_sandbox' };

  const key = extractApiKey(opts.headers);
  if (!key) {
    return {
      kind: 'deny',
      status: 402,
      payload: {
        error: 'This endpoint requires a valid API key (X-DQL-Key) or sandbox: true.',
        code: 'PAYMENT_REQUIRED',
        price_usd_per_call: PRICE_USD_PER_CALL,
        access: DEV_ACCESS_CONTACT,
      },
    };
  }

  const envRecord = lookupKeyConstantTime(opts.keys, key);
  const record = envRecord ?? (opts.store ? await opts.store.lookup(key) : undefined);
  if (!record || record.revoked === true) {
    return {
      kind: 'deny',
      status: 402,
      payload: {
        error: 'Invalid API key.',
        code: 'PAYMENT_REQUIRED',
        price_usd_per_call: PRICE_USD_PER_CALL,
        access: DEV_ACCESS_CONTACT,
      },
    };
  }

  const withinCap = await opts.usage.checkAndRecord(key, record.daily_cap);
  if (!withinCap) {
    return {
      kind: 'deny',
      status: 429,
      payload: {
        error: `Daily cap of ${record.daily_cap} calls exceeded for this key.`,
        code: 'QUOTA_EXCEEDED',
        retry_after: 'next UTC day',
      },
    };
  }

  if (record.dev_access) {
    return { kind: 'allow', key, record, billing: 'dev-access' };
  }

  // Prepaid ledger applies to store-minted keys only. Env canary / bootstrap
  // keys keep the existing meter path (env wins; dql-canary unchanged).
  if (record.source === 'store') {
    const consume = opts.store?.consumeCredit;
    if (!consume) {
      return {
        kind: 'deny',
        status: 503,
        payload: {
          error: 'Credit ledger unavailable.',
          code: 'CREDITS_UNAVAILABLE',
          no_freemium: true,
        },
      };
    }
    const spent = await consume.call(opts.store, sha256Hex(key));
    if (spent === 'consumed') {
      return { kind: 'allow', key, record, billing: 'credit' };
    }
    if (spent === 'error') {
      return {
        kind: 'deny',
        status: 503,
        payload: {
          error: 'Credit ledger unavailable.',
          code: 'CREDITS_UNAVAILABLE',
          no_freemium: true,
        },
      };
    }
    if (record.payg_opt_in === true) {
      return { kind: 'allow', key, record, billing: 'payg' };
    }
    return {
      kind: 'deny',
      status: 402,
      payload: {
        error: 'Prepaid credits exhausted. Opt in to pay-as-you-go or buy a credit pack.',
        code: 'CREDITS_EXHAUSTED',
        price_usd_per_call: PRICE_USD_PER_CALL,
        no_freemium: true,
      },
    };
  }

  return { kind: 'allow', key, record, billing: 'env-metered' };
}

/**
 * Constant-time key lookup over the registry Map (issue #24 hardening).
 *
 * Plain `Map.get(key)` short-circuits on the FIRST byte/length mismatch
 * inside V8's string-equality check, which is a theoretical timing side
 * channel: an attacker measuring response latency could infer how many
 * leading bytes of a guess matched a real key. This still uses the Map as
 * the lookup structure (O(1) average iteration order is irrelevant here —
 * registries are small, single-digit-to-low-hundreds of keys), but every
 * candidate is compared with `crypto.timingSafeEqual`, which runs in time
 * proportional only to buffer length, never to the position of the first
 * differing byte.
 *
 * `timingSafeEqual` throws if the two buffers differ in length, so a naive
 * `if (a.length !== b.length) return false` early-exit BEFORE calling it
 * would reintroduce a length-based timing leak. Instead we pad the shorter
 * buffer up to the longer one's length before comparing (the padded
 * comparison can never match, so it safely returns false without leaking
 * which candidate had the matching length via an early return).
 */
function lookupKeyConstantTime(
  keys: Map<string, ApiKeyRecord>,
  candidate: string,
): ApiKeyRecord | undefined {
  const candidateBuf = Buffer.from(candidate, 'utf8');
  let match: ApiKeyRecord | undefined;
  for (const [registeredKey, record] of keys) {
    const registeredBuf = Buffer.from(registeredKey, 'utf8');
    if (constantTimeBufferEqual(candidateBuf, registeredBuf)) {
      match = record;
      // Do not break early: bailing out on first match reintroduces a
      // timing signal correlated with registry iteration order. The
      // registry is small, so scanning the rest is cheap and keeps the
      // total comparison count independent of where the match landed.
    }
  }
  return match;
}

/** Compare two buffers in constant time regardless of length. */
function constantTimeBufferEqual(a: Buffer, b: Buffer): boolean {
  if (a.length === b.length) {
    return timingSafeEqual(a, b);
  }
  // Length differs: timingSafeEqual would throw, so compare same-length
  // buffers (candidate vs. itself, then a zero buffer of the OTHER length
  // vs. that same zero buffer) to keep the work proportional to length and
  // avoid an early-exit branch keyed directly off the length check outcome.
  const longer = Math.max(a.length, b.length);
  const aPadded = Buffer.alloc(longer);
  const bPadded = Buffer.alloc(longer);
  a.copy(aPadded);
  b.copy(bPadded);
  // XOR in a constant that guarantees inequality even if both inputs were
  // all-zero, then run the same timingSafeEqual path as the equal-length
  // case so both branches perform one Buffer alloc + one timingSafeEqual.
  bPadded[longer - 1] = (bPadded[longer - 1] ?? 0) ^ 0xff;
  timingSafeEqual(aPadded, bPadded);
  return false;
}
