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
 *
 * Keys live in env `DQL_API_KEYS` as a JSON object — Vercel-native, no DB
 * round-trip at cold start:
 *   {
 *     "dqlk_<hex>": { "owner": "raul",  "dev_access": true,  "daily_cap": 500 },
 *     "dqlk_<hex>": { "owner": "acme",  "dev_access": false, "daily_cap": 2000 }
 *   }
 *
 * `daily_cap` is an operational abuse brake (429), orthogonal to billing.
 * Unknown fields are ignored so the format can grow without a gate change.
 */

import { timingSafeEqual } from 'node:crypto';

import { PRICE_USD_PER_CALL } from '../pricing.js';

export interface ApiKeyRecord {
  owner: string;
  dev_access: boolean;
  daily_cap: number;
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
  code: 'PAYMENT_REQUIRED' | 'QUOTA_EXCEEDED';
  price_usd_per_call?: number;
  access?: string;
  retry_after?: string;
}

export type AuthDecision =
  | { kind: 'free_sandbox' }
  | { kind: 'allow'; key: string; record: ApiKeyRecord }
  | { kind: 'deny'; status: number; payload: AuthErrorPayload };

/** Usage accounting port — implemented by Upstash (src/auth/usage.ts) or a
 * no-op when Redis is not configured. checkAndRecord returns false when the
 * daily cap is exceeded (call must be rejected with 429). */
export interface UsageGate {
  checkAndRecord(key: string, cap: number): Promise<boolean>;
}

export const DEV_ACCESS_CONTACT = 'dev-access keys: raul@thoughtproof.ai';

export async function authorizeCall(opts: {
  headers: HeaderMap;
  sandbox: boolean;
  keys: Map<string, ApiKeyRecord>;
  usage: UsageGate;
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

  const record = lookupKeyConstantTime(opts.keys, key);
  if (!record) {
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

  return { kind: 'allow', key, record };
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
