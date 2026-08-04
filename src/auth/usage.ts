/**
 * Usage accounting for the DQL API-key gate.
 *
 * Storage: Upstash Redis over REST (serverless-friendly, no sockets).
 * Counter key: `dql:usage:<apiKey>:<yyyy-mm-dd>` — INCR per call, 48h TTL
 * set on first touch. Read-before-write is unnecessary: INCR returns the
 * new value, so the cap check is atomic.
 *
 * Graceful degradation: if UPSTASH_REDIS_REST_URL / _TOKEN are unset, the
 * gate is a no-op (allow everything, warn once per cold start). Key
 * VALIDATION is env-based and unaffected — only the daily-cap brake and the
 * structured usage record depend on Redis. Rationale: a Redis outage should
 * degrade the abuse brake, not take down paying traffic; the env key list
 * still rejects strangers.
 */

import { createHash } from 'node:crypto';

import { Redis } from '@upstash/redis';
import type { UsageGate } from './keys.js';

export class NoopUsageGate implements UsageGate {
  async checkAndRecord(_key: string, _cap: number): Promise<boolean> {
    return true;
  }
}

export class UpstashUsageGate implements UsageGate {
  constructor(
    private readonly redis: {
      incr: (key: string) => Promise<number>;
      expire: (key: string, seconds: number) => Promise<number>;
    },
    private readonly now: () => Date = () => new Date(),
  ) {}

  async checkAndRecord(key: string, cap: number): Promise<boolean> {
    const day = this.now().toISOString().slice(0, 10); // UTC day
    const redisKey = `dql:usage:${key}:${day}`;
    try {
      const count = await this.redis.incr(redisKey);
      if (count === 1) {
        // First call of the day — set TTL so keys self-clean. Best-effort.
        await this.redis.expire(redisKey, 48 * 3600).catch(() => 0);
      }
      return count <= cap;
    } catch {
      // Redis failure must not take down paying traffic. The brake degrades,
      // the gate holds (key validation is env-based).
      return true;
    }
  }
}

export function createUsageGate(env: NodeJS.ProcessEnv): UsageGate {
  const url = env.UPSTASH_REDIS_REST_URL;
  const token = env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) {
    console.warn(
      '[dql-auth] UPSTASH_REDIS_REST_URL/TOKEN unset — daily-cap brake disabled (key validation still enforced).',
    );
    return new NoopUsageGate();
  }
  return new UpstashUsageGate(new Redis({ url, token }));
}

/**
 * Structured usage line for Vercel logs — the billing record until the
 * Stripe/x402 meter rails land (docs/PAYMENT.md Phase 2). One JSON line per
 * allowed non-sandbox call; grepable as `dql_usage`.
 *
 * Issue #24 hardening: never log the raw API key. Vercel log access can be
 * broader than the key-holder set, and the full secret in plaintext on every
 * call is avoidable exposure surface for a "billing record". Instead we log
 * `key_fingerprint`, a truncated sha256 hash (first 12 hex chars) plus the
 * last 4 characters of the key — enough to correlate/deduplicate a specific
 * key across log lines for ops purposes, without ever reconstructing it.
 */
export function emitUsageLine(opts: {
  requestId: string;
  key: string;
  owner: string;
  devAccess: boolean;
  priceUsd: number;
  verdict?: string;
}): void {
  console.log(
    JSON.stringify({
      type: 'dql_usage',
      request_id: opts.requestId,
      key_fingerprint: fingerprintKey(opts.key),
      owner: opts.owner,
      dev_access: opts.devAccess,
      price_usd: opts.priceUsd,
      verdict: opts.verdict,
      ts: new Date().toISOString(),
    }),
  );
}

/**
 * Derive a non-reversible, log-safe identifier for an API key: the first 12
 * hex characters of its sha256 hash, plus the literal last 4 characters of
 * the key (e.g. `a1b2c3d4e5f6…af42`). The hash prefix lets ops correlate the
 * SAME key across log lines without storing/searching the raw secret; the
 * last-4 gives a human-recognizable suffix matching common billing-UI
 * conventions (like card-number masking), without materially increasing
 * brute-force risk for a high-entropy `dqlk_<hex>` key.
 */
function fingerprintKey(key: string): string {
  const hashPrefix = createHash('sha256').update(key, 'utf8').digest('hex').slice(0, 12);
  const last4 = key.slice(-4);
  return `${hashPrefix}…${last4}`;
}
