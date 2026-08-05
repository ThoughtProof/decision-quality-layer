import { createHash } from 'node:crypto';

import { describe, it, expect, vi } from 'vitest';
import { NoopUsageGate, UpstashUsageGate, createUsageGate, emitUsageLine } from './usage.js';

describe('NoopUsageGate', () => {
  it('always allows', async () => {
    const gate = new NoopUsageGate();
    expect(await gate.checkAndRecord('k', 1)).toBe(true);
  });
});

describe('UpstashUsageGate', () => {
  function fakeRedis() {
    const store = new Map<string, number>();
    return {
      store,
      incr: vi.fn(async (k: string) => {
        const n = (store.get(k) ?? 0) + 1;
        store.set(k, n);
        return n;
      }),
      expire: vi.fn(async (_k: string, _s: number) => 1),
    };
  }

  it('allows within cap, blocks beyond, TTL set once per day-key', async () => {
    const redis = fakeRedis();
    const gate = new UpstashUsageGate(redis, () => new Date('2026-07-20T12:00:00Z'));
    expect(await gate.checkAndRecord('dqlk_a', 2)).toBe(true); // 1
    expect(await gate.checkAndRecord('dqlk_a', 2)).toBe(true); // 2
    expect(await gate.checkAndRecord('dqlk_a', 2)).toBe(false); // 3 > cap
    expect(redis.expire).toHaveBeenCalledTimes(1); // only on first incr
    expect(redis.incr.mock.calls[0]![0]).toBe('dql:usage:dqlk_a:2026-07-20');
  });

  it('separates counters per UTC day', async () => {
    const redis = fakeRedis();
    const day1 = new UpstashUsageGate(redis, () => new Date('2026-07-20T23:59:00Z'));
    const day2 = new UpstashUsageGate(redis, () => new Date('2026-07-21T00:01:00Z'));
    expect(await day1.checkAndRecord('dqlk_a', 1)).toBe(true);
    expect(await day1.checkAndRecord('dqlk_a', 1)).toBe(false);
    expect(await day2.checkAndRecord('dqlk_a', 1)).toBe(true); // fresh day
  });

  it('Redis failure degrades the brake, never the gate', async () => {
    const gate = new UpstashUsageGate({
      incr: async () => {
        throw new Error('redis down');
      },
      expire: async () => 1,
    });
    expect(await gate.checkAndRecord('dqlk_a', 1)).toBe(true);
  });
});

describe('createUsageGate', () => {
  it('returns noop without Upstash env', () => {
    const gate = createUsageGate({} as NodeJS.ProcessEnv);
    expect(gate).toBeInstanceOf(NoopUsageGate);
  });
});

describe('emitUsageLine', () => {
  it('emits one grep-able JSON line', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    emitUsageLine({
      requestId: 'dql_x',
      key: 'dqlk_a',
      owner: 'raul',
      devAccess: true,
      priceUsd: 0,
      verdict: 'allow',
    });
    expect(spy).toHaveBeenCalledTimes(1);
    const line = JSON.parse(spy.mock.calls[0]![0] as string);
    expect(line.type).toBe('dql_usage');
    expect(line.owner).toBe('raul');
    spy.mockRestore();
  });

  // Issue #24 hardening: the raw key must never appear in the emitted line.
  it('never logs the raw API key value', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const rawKey = 'dqlk_super-secret-do-not-leak-1234';
    emitUsageLine({
      requestId: 'dql_y',
      key: rawKey,
      owner: 'acme',
      devAccess: false,
      priceUsd: 0.05,
      verdict: 'allow',
    });
    const raw = spy.mock.calls[0]![0] as string;
    expect(raw).not.toContain(rawKey);
    const line = JSON.parse(raw);
    expect(line.key).toBeUndefined();
    spy.mockRestore();
  });

  it('logs a key_fingerprint of sha256-prefix + last 4 chars, not reversible', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const rawKey = 'dqlk_abcdefabcdefabcdefabcdef1234';
    emitUsageLine({
      requestId: 'dql_z',
      key: rawKey,
      owner: 'acme',
      devAccess: false,
      priceUsd: 0.05,
    });
    const line = JSON.parse(spy.mock.calls[0]![0] as string);
    const expectedHashPrefix = createHash('sha256').update(rawKey, 'utf8').digest('hex').slice(0, 12);
    expect(line.key_fingerprint).toContain(expectedHashPrefix);
    expect(line.key_fingerprint).toContain(rawKey.slice(-4));
    spy.mockRestore();
  });

  it('different keys produce different fingerprints', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    emitUsageLine({ requestId: 'r1', key: 'dqlk_keyone11111111', owner: 'a', devAccess: false, priceUsd: 0 });
    emitUsageLine({ requestId: 'r2', key: 'dqlk_keytwo22222222', owner: 'a', devAccess: false, priceUsd: 0 });
    const line1 = JSON.parse(spy.mock.calls[0]![0] as string);
    const line2 = JSON.parse(spy.mock.calls[1]![0] as string);
    expect(line1.key_fingerprint).not.toBe(line2.key_fingerprint);
    spy.mockRestore();
  });
});
