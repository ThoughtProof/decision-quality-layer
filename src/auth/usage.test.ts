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
});
