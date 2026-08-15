/**
 * Usage accounting for the DQL API-key gate.
 *
 * Storage: Upstash Redis over REST (serverless-friendly, no sockets).
 * Counter key: `dql:usage:<sha256(key)[:24]>:<yyyy-mm-dd>` — INCR per call,
 * 48h TTL on first touch. Raw API keys are NEVER stored in Redis (multi-
 * instance safe + secret hygiene).
 *
 * Multi-instance: INCR is atomic on Redis; concurrent Vercel instances share
 * the same counter. Cap check uses the post-INCR value (count <= cap).
 *
 * Graceful degradation: if UPSTASH_REDIS_REST_URL / _TOKEN are unset, the
 * gate is a no-op (allow everything, warn once per cold start). Key
 * VALIDATION is env ∪ store and unaffected — only the daily-cap brake and
 * the structured usage record depend on this counter. Rationale: a Redis
 * outage should degrade the abuse brake, not take down paying traffic; the
 * env key list still rejects strangers. Store-minted keys cannot be
 * validated if Redis is down (fail closed on lookup, not here).
 */

import { Redis } from '@upstash/redis';
import type { UsageGate } from './keys.js';
import { fingerprintKey, usageRedisKeyId } from './key-hash.js';

export { fingerprintKey, usageRedisKeyId } from './key-hash.js';

export class NoopUsageGate implements UsageGate {
  async checkAndRecord(_key: string, _cap: number): Promise<boolean> {
    return true;
  }
}

/** Daily-cap counter from a stored key hash (sha256 hex of the plaintext). */
export function usageCounterKeyFromHash(keyHash: string, dayUtc: string): string {
  return `dql:usage:${keyHash.slice(0, 24)}:${dayUtc}`;
}

export function usageCounterKey(apiKey: string, dayUtc: string): string {
  return usageCounterKeyFromHash(usageRedisKeyId(apiKey), dayUtc);
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
    const redisKey = usageCounterKey(key, day);
    try {
      const count = await this.redis.incr(redisKey);
      if (count === 1) {
        // First call of the day — set TTL so keys self-clean. Best-effort.
        await this.redis.expire(redisKey, 48 * 3600).catch(() => 0);
      }
      return count <= cap;
    } catch {
      // Redis failure must not take down paying traffic. The brake degrades,
      // the gate holds (key validation is env ∪ store).
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
 * Structured usage line for Vercel logs — the billing record until / alongside
 * Stripe/x402 meter rails (docs/PAYMENT.md Phase 2). One JSON line per
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
  billingRail?: 'dev-access' | 'stripe' | 'x402' | 'metered-log-only' | 'sandbox' | 'credit';
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
      billing_rail: opts.billingRail,
      ts: new Date().toISOString(),
    }),
  );
}
