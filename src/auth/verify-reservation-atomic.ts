/**
 * Atomic verify reservation (account-token admission).
 *
 * Bound to stored key hash + idempotency id + payload digest.
 * Production: one Redis EVAL per reserve / commit / release / recover.
 * Tests: the same state machine on a synchronous Kv.
 *
 * Invariant: a `held` debit is never left unrecoverable. The reservation
 * record outlives the 15-minute execution lease (7-day TTL) so a later
 * reserve/recover/sweep can refund credit + cap after a crash. Key expiry
 * is not used as the refund mechanism.
 *
 * Script ids: DQL_RESERVE_V2 / COMMIT / RELEASE / RECOVER / SWEEP.
 */

import type { ReserveVerifyResult, VerifyReservation } from './key-store.js';
import { usageCounterKeyFromHash } from './usage.js';

export const RESERVE_LEASE_SEC = 15 * 60;
export const RESERVE_RECORD_TTL_SEC = 7 * 24 * 3600;
export const HELD_INDEX_KEY = 'dql:reserve-held';

export const LUA_RESERVE = `
-- DQL_RESERVE_V2
-- KEYS[1]=reserve KEYS[2]=credits KEYS[3]=usage KEYS[4]=heldIndex
-- ARGV: requestId keyHash payloadDigest dayUtc dailyCap payg recordTtl leaseSec nowMs
local function decode(raw)
  if not raw then return nil end
  if type(raw) == 'table' then return raw end
  local ok, obj = pcall(cjson.decode, raw)
  if ok and type(obj) == 'table' then return obj end
  return nil
end

local function refund(res)
  if res.creditHeld and type(res.keyHash) == 'string' and res.keyHash ~= '' then
    redis.call('INCR', 'dql:credits:' .. res.keyHash)
  end
  if res.capHeld and type(res.keyHash) == 'string' and type(res.dayUtc) == 'string' then
    local usageKey = 'dql:usage:' .. string.sub(res.keyHash, 1, 24) .. ':' .. res.dayUtc
    local nxt = redis.call('DECR', usageKey)
    if nxt < 0 then redis.call('INCR', usageKey) end
  end
  res.creditHeld = false
  res.capHeld = false
end

local requestId = ARGV[1]
local keyHash = ARGV[2]
local payloadDigest = ARGV[3]
local dayUtc = ARGV[4]
local dailyCap = tonumber(ARGV[5])
local payg = ARGV[6] == '1'
local recordTtl = tonumber(ARGV[7])
local leaseSec = tonumber(ARGV[8])
local nowMs = tonumber(ARGV[9])
local existing = decode(redis.call('GET', KEYS[1]))

if existing and existing.status == 'held' then
  local exp = tonumber(existing.leaseExpiresAt)
  if exp and nowMs and nowMs >= exp then
    refund(existing)
    existing.status = 'released'
    redis.call('SET', KEYS[1], cjson.encode(existing), 'EX', recordTtl)
    redis.call('ZREM', KEYS[4], existing.requestId or requestId)
  end
end

if existing and (existing.status == 'held' or existing.status == 'committed' or existing.status == 'released') then
  if existing.keyHash ~= keyHash then
    return cjson.encode({kind='conflict', reason='account'})
  end
  if existing.status ~= 'released' and existing.payloadDigest ~= payloadDigest then
    return cjson.encode({kind='conflict', reason='payload'})
  end
  if existing.status == 'held' then
    return cjson.encode({kind='in_progress', reservation=existing})
  end
  if existing.status == 'committed' then
    return cjson.encode({kind='replay', reservation=existing})
  end
end

local n = redis.call('DECR', KEYS[2])
local creditHeld = false
if n >= 0 then
  creditHeld = true
else
  redis.call('INCR', KEYS[2])
  if not payg then
    return cjson.encode({kind='empty'})
  end
end

local count = redis.call('INCR', KEYS[3])
if not dailyCap or count > dailyCap then
  redis.call('DECR', KEYS[3])
  if creditHeld then redis.call('INCR', KEYS[2]) end
  return cjson.encode({kind='quota'})
end

local leaseExpiresAt = nowMs + (leaseSec * 1000)
local reservation = {
  requestId = requestId,
  keyHash = keyHash,
  payloadDigest = payloadDigest,
  dayUtc = dayUtc,
  creditHeld = creditHeld,
  capHeld = true,
  billing = creditHeld and 'credit' or 'payg',
  status = 'held',
  leaseExpiresAt = leaseExpiresAt
}
redis.call('SET', KEYS[1], cjson.encode(reservation), 'EX', recordTtl)
redis.call('ZADD', KEYS[4], leaseExpiresAt, requestId)
return cjson.encode({kind='ok', reservation=reservation})
`;

export const LUA_COMMIT = `
-- DQL_COMMIT_V2
-- KEYS[1]=reserve KEYS[2]=heldIndex
-- ARGV[1]=recordTtl ARGV[2]=resultJson ARGV[3]=meter
local raw = redis.call('GET', KEYS[1])
if not raw then return 'noop' end
local ok, res = pcall(cjson.decode, raw)
if not ok or type(res) ~= 'table' or res.status ~= 'held' then return 'noop' end
res.status = 'committed'
local rok, parsed = pcall(cjson.decode, ARGV[2])
if rok then res.result = parsed else res.result = ARGV[2] end
res.meter = ARGV[3]
redis.call('SET', KEYS[1], cjson.encode(res), 'EX', tonumber(ARGV[1]))
redis.call('ZREM', KEYS[2], res.requestId)
return 'committed'
`;

export const LUA_RELEASE = `
-- DQL_RELEASE_V2
-- KEYS[1]=reserve KEYS[2]=heldIndex ARGV[1]=recordTtl
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
  if nxt < 0 then redis.call('INCR', usageKey) end
end
res.status = 'released'
res.creditHeld = false
res.capHeld = false
res.result = nil
redis.call('SET', KEYS[1], cjson.encode(res), 'EX', tonumber(ARGV[1]))
redis.call('ZREM', KEYS[2], res.requestId)
return 'released'
`;

export const LUA_RECOVER = `
-- DQL_RECOVER_V2
-- KEYS[1]=reserve KEYS[2]=heldIndex ARGV[1]=recordTtl ARGV[2]=nowMs
local raw = redis.call('GET', KEYS[1])
if not raw then return 'noop' end
local ok, res = pcall(cjson.decode, raw)
if not ok or type(res) ~= 'table' or res.status ~= 'held' then return 'noop' end
local exp = tonumber(res.leaseExpiresAt)
local nowMs = tonumber(ARGV[2])
if not exp or not nowMs or nowMs < exp then return 'noop' end
if res.creditHeld and type(res.keyHash) == 'string' and res.keyHash ~= '' then
  redis.call('INCR', 'dql:credits:' .. res.keyHash)
end
if res.capHeld and type(res.keyHash) == 'string' and type(res.dayUtc) == 'string' then
  local usageKey = 'dql:usage:' .. string.sub(res.keyHash, 1, 24) .. ':' .. res.dayUtc
  local nxt = redis.call('DECR', usageKey)
  if nxt < 0 then redis.call('INCR', usageKey) end
end
res.status = 'released'
res.creditHeld = false
res.capHeld = false
res.result = nil
redis.call('SET', KEYS[1], cjson.encode(res), 'EX', tonumber(ARGV[1]))
redis.call('ZREM', KEYS[2], res.requestId)
return 'released'
`;

export const LUA_SWEEP = `
-- DQL_SWEEP_V2
-- KEYS[1]=heldIndex ARGV[1]=recordTtl ARGV[2]=nowMs
local nowMs = tonumber(ARGV[2])
local ids = redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', nowMs)
local n = 0
for _, id in ipairs(ids) do
  local reserveKey = 'dql:reserve:' .. id
  local raw = redis.call('GET', reserveKey)
  if raw then
    local ok, res = pcall(cjson.decode, raw)
    if ok and type(res) == 'table' and res.status == 'held' then
      local exp = tonumber(res.leaseExpiresAt)
      if exp and nowMs >= exp then
        if res.creditHeld and type(res.keyHash) == 'string' and res.keyHash ~= '' then
          redis.call('INCR', 'dql:credits:' .. res.keyHash)
        end
        if res.capHeld and type(res.keyHash) == 'string' and type(res.dayUtc) == 'string' then
          local usageKey = 'dql:usage:' .. string.sub(res.keyHash, 1, 24) .. ':' .. res.dayUtc
          local nxt = redis.call('DECR', usageKey)
          if nxt < 0 then redis.call('INCR', usageKey) end
        end
        res.status = 'released'
        res.creditHeld = false
        res.capHeld = false
        res.result = nil
        redis.call('SET', reserveKey, cjson.encode(res), 'EX', tonumber(ARGV[1]))
        n = n + 1
      end
    end
  end
  redis.call('ZREM', KEYS[1], id)
end
return n
`;

export interface SyncKv {
  get(key: string): unknown;
  set(key: string, value: unknown, exSec?: number): void;
  incrby(key: string, n: number): number;
  zadd(key: string, score: number, member: string): void;
  zrem(key: string, member: string): void;
  zrangebyscore(key: string, min: number, max: number): string[];
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
  const payloadDigest = typeof r.payloadDigest === 'string' ? r.payloadDigest : '';
  const leaseExpiresAt =
    typeof r.leaseExpiresAt === 'number' && Number.isFinite(r.leaseExpiresAt)
      ? r.leaseExpiresAt
      : asInt(r.leaseExpiresAt);
  const meter =
    r.meter === 'ok' || r.meter === 'error' || r.meter === 'skipped' || r.meter === 'n/a'
      ? r.meter
      : undefined;
  return {
    requestId: r.requestId,
    keyHash: r.keyHash,
    payloadDigest,
    dayUtc: r.dayUtc,
    creditHeld: r.creditHeld === true,
    capHeld: r.capHeld === true,
    billing,
    status,
    leaseExpiresAt,
    result: r.result,
    meter,
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
  if (kind === 'conflict') {
    const reason = (obj as { reason?: unknown }).reason;
    return { kind: 'conflict', reason: reason === 'payload' ? 'payload' : 'account' };
  }
  if (kind === 'ok' || kind === 'in_progress' || kind === 'replay') {
    const reservation = parseReservation((obj as { reservation?: unknown }).reservation);
    if (!reservation) return { kind: 'error' };
    return { kind, reservation };
  }
  return { kind: 'error' };
}

function refundSync(kv: SyncKv, existing: VerifyReservation): void {
  if (existing.creditHeld && existing.keyHash) {
    kv.incrby(`dql:credits:${existing.keyHash}`, 1);
  }
  if (existing.capHeld && existing.keyHash && existing.dayUtc) {
    const usageKey = usageCounterKeyFromHash(existing.keyHash, existing.dayUtc);
    const next = kv.incrby(usageKey, -1);
    if (next < 0) kv.incrby(usageKey, 1);
  }
  existing.creditHeld = false;
  existing.capHeld = false;
}

export function reserveVerifySync(
  kv: SyncKv,
  opts: {
    requestId: string;
    keyHash: string;
    payloadDigest: string;
    dailyCap: number;
    paygOptIn: boolean;
    dayUtc: string;
    recordTtlSec: number;
    leaseSec: number;
    nowMs: number;
    reserveKey: string;
    creditsKey: string;
    usageKey: string;
    heldIndexKey: string;
  },
): ReserveVerifyResult {
  let existing = parseReservation(kv.get(opts.reserveKey));
  if (existing && existing.status === 'held' && opts.nowMs >= existing.leaseExpiresAt) {
    refundSync(kv, existing);
    existing.status = 'released';
    existing.result = undefined;
    kv.set(opts.reserveKey, existing, opts.recordTtlSec);
    kv.zrem(opts.heldIndexKey, existing.requestId);
  }

  if (existing && (existing.status === 'held' || existing.status === 'committed' || existing.status === 'released')) {
    if (existing.keyHash !== opts.keyHash) return { kind: 'conflict', reason: 'account' };
    if (existing.status !== 'released' && existing.payloadDigest !== opts.payloadDigest) {
      return { kind: 'conflict', reason: 'payload' };
    }
    if (existing.status === 'held') return { kind: 'in_progress', reservation: existing };
    if (existing.status === 'committed') return { kind: 'replay', reservation: existing };
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
    payloadDigest: opts.payloadDigest,
    dayUtc: opts.dayUtc,
    creditHeld,
    capHeld: true,
    billing: creditHeld ? 'credit' : 'payg',
    status: 'held',
    leaseExpiresAt: opts.nowMs + opts.leaseSec * 1000,
  };
  kv.set(opts.reserveKey, reservation, opts.recordTtlSec);
  kv.zadd(opts.heldIndexKey, reservation.leaseExpiresAt, opts.requestId);
  return { kind: 'ok', reservation };
}

export function commitVerifySync(
  kv: SyncKv,
  reserveKey: string,
  heldIndexKey: string,
  recordTtlSec: number,
  result: unknown,
  meter: string,
): string {
  const existing = parseReservation(kv.get(reserveKey));
  if (!existing || existing.status !== 'held') return 'noop';
  existing.status = 'committed';
  existing.result = result;
  existing.meter =
    meter === 'ok' || meter === 'error' || meter === 'skipped' || meter === 'n/a' ? meter : 'n/a';
  kv.set(reserveKey, existing, recordTtlSec);
  kv.zrem(heldIndexKey, existing.requestId);
  return 'committed';
}

export function releaseVerifySync(
  kv: SyncKv,
  reserveKey: string,
  heldIndexKey: string,
  recordTtlSec: number,
): string {
  const existing = parseReservation(kv.get(reserveKey));
  if (!existing || existing.status !== 'held') return 'noop';
  refundSync(kv, existing);
  existing.status = 'released';
  existing.result = undefined;
  kv.set(reserveKey, existing, recordTtlSec);
  kv.zrem(heldIndexKey, existing.requestId);
  return 'released';
}

export function recoverVerifySync(
  kv: SyncKv,
  reserveKey: string,
  heldIndexKey: string,
  recordTtlSec: number,
  nowMs: number,
): string {
  const existing = parseReservation(kv.get(reserveKey));
  if (!existing || existing.status !== 'held') return 'noop';
  if (nowMs < existing.leaseExpiresAt) return 'noop';
  refundSync(kv, existing);
  existing.status = 'released';
  existing.result = undefined;
  kv.set(reserveKey, existing, recordTtlSec);
  kv.zrem(heldIndexKey, existing.requestId);
  return 'released';
}

export function sweepExpiredSync(kv: SyncKv, heldIndexKey: string, recordTtlSec: number, nowMs: number): number {
  const ids = kv.zrangebyscore(heldIndexKey, Number.NEGATIVE_INFINITY, nowMs);
  let n = 0;
  for (const id of ids) {
    const reserveKey = `dql:reserve:${id}`;
    if (recoverVerifySync(kv, reserveKey, heldIndexKey, recordTtlSec, nowMs) === 'released') n += 1;
    else kv.zrem(heldIndexKey, id);
  }
  return n;
}

export function dispatchMemoryEval(
  kv: SyncKv,
  script: string,
  keys: string[],
  args: string[],
): unknown {
  if (script.includes('DQL_RESERVE_V2')) {
    const result = reserveVerifySync(kv, {
      reserveKey: keys[0] ?? '',
      creditsKey: keys[1] ?? '',
      usageKey: keys[2] ?? '',
      heldIndexKey: keys[3] ?? HELD_INDEX_KEY,
      requestId: args[0] ?? '',
      keyHash: args[1] ?? '',
      payloadDigest: args[2] ?? '',
      dayUtc: args[3] ?? '',
      dailyCap: asInt(args[4]),
      paygOptIn: args[5] === '1',
      recordTtlSec: asInt(args[6]),
      leaseSec: asInt(args[7]),
      nowMs: asInt(args[8]),
    });
    return JSON.stringify(result);
  }
  if (script.includes('DQL_COMMIT_V2')) {
    let parsed: unknown = args[1] ?? null;
    if (typeof args[1] === 'string') {
      try {
        parsed = JSON.parse(args[1]);
      } catch {
        parsed = args[1];
      }
    }
    return commitVerifySync(kv, keys[0] ?? '', keys[1] ?? HELD_INDEX_KEY, asInt(args[0]), parsed, args[2] ?? 'n/a');
  }
  if (script.includes('DQL_RELEASE_V2')) {
    return releaseVerifySync(kv, keys[0] ?? '', keys[1] ?? HELD_INDEX_KEY, asInt(args[0]));
  }
  if (script.includes('DQL_RECOVER_V2')) {
    return recoverVerifySync(
      kv,
      keys[0] ?? '',
      keys[1] ?? HELD_INDEX_KEY,
      asInt(args[0]),
      asInt(args[1]),
    );
  }
  if (script.includes('DQL_SWEEP_V2')) {
    return sweepExpiredSync(kv, keys[0] ?? HELD_INDEX_KEY, asInt(args[0]), asInt(args[1]));
  }
  throw new Error('unknown reservation script');
}
