/**
 * Atomic verify reservation (account-token admission).
 *
 * Production: one Redis EVAL (Lua) per reserve / commit / release.
 * Tests: the same state machine on a synchronous Kv (Redis single-thread
 * equivalent). No read-modify-write across separate round-trips.
 *
 * Lua and JS must stay in lockstep. Script ids: DQL_RESERVE_V1 / COMMIT / RELEASE.
 */

import type { ReserveVerifyResult, VerifyReservation } from './key-store.js';
import { usageCounterKeyFromHash } from './usage.js';

export const LUA_RESERVE = `
-- DQL_RESERVE_V1
-- KEYS[1]=reserve KEYS[2]=credits KEYS[3]=usage
-- ARGV[1]=requestId ARGV[2]=keyHash ARGV[3]=dayUtc ARGV[4]=dailyCap ARGV[5]=payg ARGV[6]=ttl
local function decode(raw)
  if not raw then return nil end
  if type(raw) == 'table' then return raw end
  local ok, obj = pcall(cjson.decode, raw)
  if ok and type(obj) == 'table' then return obj end
  return nil
end

local existing = decode(redis.call('GET', KEYS[1]))
if existing and (existing.status == 'held' or existing.status == 'committed') then
  return cjson.encode({kind='ok', reservation=existing})
end

local n = redis.call('DECR', KEYS[2])
local creditHeld = false
if n >= 0 then
  creditHeld = true
else
  redis.call('INCR', KEYS[2])
  if ARGV[5] ~= '1' then
    return cjson.encode({kind='empty'})
  end
end

local count = redis.call('INCR', KEYS[3])
local cap = tonumber(ARGV[4])
if not cap or count > cap then
  redis.call('DECR', KEYS[3])
  if creditHeld then
    redis.call('INCR', KEYS[2])
  end
  return cjson.encode({kind='quota'})
end

local reservation = {
  requestId = ARGV[1],
  keyHash = ARGV[2],
  dayUtc = ARGV[3],
  creditHeld = creditHeld,
  capHeld = true,
  billing = creditHeld and 'credit' or 'payg',
  status = 'held'
}
redis.call('SET', KEYS[1], cjson.encode(reservation), 'EX', tonumber(ARGV[6]))
return cjson.encode({kind='ok', reservation=reservation})
`;

export const LUA_COMMIT = `
-- DQL_COMMIT_V1
-- KEYS[1]=reserve ARGV[1]=ttl
local raw = redis.call('GET', KEYS[1])
if not raw then return 'noop' end
local ok, res = pcall(cjson.decode, raw)
if not ok or type(res) ~= 'table' or res.status ~= 'held' then return 'noop' end
res.status = 'committed'
redis.call('SET', KEYS[1], cjson.encode(res), 'EX', tonumber(ARGV[1]))
return 'committed'
`;

export const LUA_RELEASE = `
-- DQL_RELEASE_V1
-- KEYS[1]=reserve ARGV[1]=ttl
-- credits/usage keys are derived from the reservation (hash only).
local raw = redis.call('GET', KEYS[1])
if not raw then return 'noop' end
local ok, res = pcall(cjson.decode, raw)
if not ok or type(res) ~= 'table' or res.status ~= 'held' then return 'noop' end
if res.creditHeld and type(res.keyHash) == 'string' and res.keyHash ~= '' then
  redis.call('INCR', 'dql:credits:' .. res.keyHash)
end
if res.capHeld and type(res.keyHash) == 'string' and type(res.dayUtc) == 'string' then
  local usageKey = 'dql:usage:' .. string.sub(res.keyHash, 1, 24) .. ':' .. res.dayUtc
  local nxt = redis.call('DECR', usageKey)
  if nxt < 0 then
    redis.call('INCR', usageKey)
  end
end
res.status = 'released'
res.creditHeld = false
res.capHeld = false
redis.call('SET', KEYS[1], cjson.encode(res), 'EX', tonumber(ARGV[1]))
return 'released'
`;

export interface SyncKv {
  get(key: string): unknown;
  set(key: string, value: unknown, exSec?: number): void;
  incrby(key: string, n: number): number;
}

function asInt(v: unknown): number {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.floor(v);
  if (typeof v === 'string' && /^-?\d+$/.test(v.trim())) return parseInt(v, 10);
  return 0;
}

export function parseReservation(v: unknown): VerifyReservation | null {
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
  if (typeof r.requestId !== 'string' || typeof r.keyHash !== 'string') return null;
  if (typeof r.dayUtc !== 'string') return null;
  const status = r.status;
  if (status !== 'held' && status !== 'committed' && status !== 'released') return null;
  const billing = r.billing === 'payg' ? 'payg' : r.billing === 'credit' ? 'credit' : null;
  if (!billing) return null;
  return {
    requestId: r.requestId,
    keyHash: r.keyHash,
    dayUtc: r.dayUtc,
    creditHeld: r.creditHeld === true,
    capHeld: r.capHeld === true,
    billing,
    status,
  };
}

export function parseReserveEval(raw: unknown): ReserveVerifyResult {
  let obj: unknown = raw;
  if (typeof raw === 'string') {
    try {
      obj = JSON.parse(raw);
    } catch {
      return { kind: 'error' };
    }
  }
  if (typeof obj !== 'object' || obj === null) return { kind: 'error' };
  const kind = (obj as { kind?: unknown }).kind;
  if (kind === 'empty' || kind === 'quota' || kind === 'error') return { kind };
  if (kind === 'ok') {
    const reservation = parseReservation((obj as { reservation?: unknown }).reservation);
    if (!reservation) return { kind: 'error' };
    return { kind: 'ok', reservation };
  }
  return { kind: 'error' };
}

/** Synchronous reserve — memory-store equivalent of LUA_RESERVE. */
export function reserveVerifySync(
  kv: SyncKv,
  opts: {
    requestId: string;
    keyHash: string;
    dailyCap: number;
    paygOptIn: boolean;
    dayUtc: string;
    ttlSec: number;
    reserveKey: string;
    creditsKey: string;
    usageKey: string;
  },
): ReserveVerifyResult {
  const existing = parseReservation(kv.get(opts.reserveKey));
  if (existing && (existing.status === 'held' || existing.status === 'committed')) {
    return { kind: 'ok', reservation: existing };
  }

  const n = kv.incrby(opts.creditsKey, -1);
  let creditHeld = false;
  if (n >= 0) {
    creditHeld = true;
  } else {
    kv.incrby(opts.creditsKey, 1);
    if (!opts.paygOptIn) return { kind: 'empty' };
  }

  const count = kv.incrby(opts.usageKey, 1);
  if (count > opts.dailyCap) {
    kv.incrby(opts.usageKey, -1);
    if (creditHeld) kv.incrby(opts.creditsKey, 1);
    return { kind: 'quota' };
  }

  const reservation: VerifyReservation = {
    requestId: opts.requestId,
    keyHash: opts.keyHash,
    dayUtc: opts.dayUtc,
    creditHeld,
    capHeld: true,
    billing: creditHeld ? 'credit' : 'payg',
    status: 'held',
  };
  kv.set(opts.reserveKey, reservation, opts.ttlSec);
  return { kind: 'ok', reservation };
}

export function commitVerifySync(kv: SyncKv, reserveKey: string, ttlSec: number): string {
  const existing = parseReservation(kv.get(reserveKey));
  if (!existing || existing.status !== 'held') return 'noop';
  existing.status = 'committed';
  kv.set(reserveKey, existing, ttlSec);
  return 'committed';
}

export function releaseVerifySync(kv: SyncKv, reserveKey: string, ttlSec: number): string {
  const existing = parseReservation(kv.get(reserveKey));
  if (!existing || existing.status !== 'held') return 'noop';
  if (existing.creditHeld && existing.keyHash) {
    kv.incrby(`dql:credits:${existing.keyHash}`, 1);
  }
  if (existing.capHeld && existing.keyHash && existing.dayUtc) {
    const usageKey = usageCounterKeyFromHash(existing.keyHash, existing.dayUtc);
    const next = kv.incrby(usageKey, -1);
    if (next < 0) kv.incrby(usageKey, 1);
  }
  existing.status = 'released';
  existing.creditHeld = false;
  existing.capHeld = false;
  kv.set(reserveKey, existing, ttlSec);
  return 'released';
}

export function dispatchMemoryEval(
  kv: SyncKv,
  script: string,
  keys: string[],
  args: string[],
): unknown {
  if (script.includes('DQL_RESERVE_V1')) {
    const result = reserveVerifySync(kv, {
      reserveKey: keys[0] ?? '',
      creditsKey: keys[1] ?? '',
      usageKey: keys[2] ?? '',
      requestId: args[0] ?? '',
      keyHash: args[1] ?? '',
      dayUtc: args[2] ?? '',
      dailyCap: asInt(args[3]),
      paygOptIn: args[4] === '1',
      ttlSec: asInt(args[5]),
    });
    return JSON.stringify(result);
  }
  if (script.includes('DQL_COMMIT_V1')) {
    return commitVerifySync(kv, keys[0] ?? '', asInt(args[0]));
  }
  if (script.includes('DQL_RELEASE_V1')) {
    return releaseVerifySync(kv, keys[0] ?? '', asInt(args[0]));
  }
  throw new Error('unknown reservation script');
}
