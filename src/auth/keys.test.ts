import { describe, it, expect } from 'vitest';
import {
  authorizeCall,
  extractApiKey,
  parseApiKeys,
  DEFAULT_DAILY_CAP,
  type UsageGate,
} from './keys.js';
import { PRICE_USD_PER_CALL } from '../pricing.js';

const allowGate: UsageGate = { checkAndRecord: async () => true };
const denyGate: UsageGate = { checkAndRecord: async () => false };

describe('parseApiKeys', () => {
  it('parses a valid registry with defaults', () => {
    const keys = parseApiKeys(
      JSON.stringify({
        'dqlk_aaa': { owner: 'raul', dev_access: true },
        'dqlk_bbb': { owner: 'acme', dev_access: false, daily_cap: 42 },
      }),
    );
    expect(keys.get('dqlk_aaa')).toEqual({
      owner: 'raul',
      dev_access: true,
      daily_cap: DEFAULT_DAILY_CAP,
    });
    expect(keys.get('dqlk_bbb')).toEqual({
      owner: 'acme',
      dev_access: false,
      daily_cap: 42,
    });
  });

  it('fails closed on malformed input (empty map, never throws)', () => {
    for (const raw of [undefined, '', 'not json', '[]', 'null', '{"x": 1}', '42']) {
      expect(parseApiKeys(raw as string | undefined).size).toBe(0);
    }
  });

  it('drops non-dqlk keys and malformed entries', () => {
    const keys = parseApiKeys(
      JSON.stringify({
        'not_a_key': { owner: 'x', dev_access: true },
        'dqlk_ok': { owner: 'y', dev_access: true },
        'dqlk_bad': 'string-instead-of-object',
      }),
    );
    expect(keys.size).toBe(1);
    expect(keys.has('dqlk_ok')).toBe(true);
  });
});

describe('extractApiKey', () => {
  it('reads X-DQL-Key (primary)', () => {
    expect(extractApiKey({ 'x-dql-key': 'dqlk_1' })).toBe('dqlk_1');
  });
  it('reads Authorization: Bearer (alias)', () => {
    expect(extractApiKey({ authorization: 'Bearer dqlk_2' })).toBe('dqlk_2');
  });
  it('X-DQL-Key wins over Bearer', () => {
    expect(
      extractApiKey({ 'x-dql-key': 'dqlk_a', authorization: 'Bearer dqlk_b' }),
    ).toBe('dqlk_a');
  });
  it('returns null on missing/garbage headers', () => {
    expect(extractApiKey({})).toBeNull();
    expect(extractApiKey({ authorization: 'Basic abc' })).toBeNull();
    expect(extractApiKey({ 'x-dql-key': '   ' })).toBeNull();
  });
});

describe('authorizeCall (PAYMENT.md decision matrix)', () => {
  const keys = parseApiKeys(
    JSON.stringify({
      'dqlk_dev': { owner: 'raul', dev_access: true, daily_cap: 500 },
      'dqlk_metered': { owner: 'acme', dev_access: false, daily_cap: 10 },
    }),
  );

  it('sandbox: true → free, no key needed', async () => {
    const d = await authorizeCall({ headers: {}, sandbox: true, keys, usage: allowGate });
    expect(d.kind).toBe('free_sandbox');
  });

  it('no key, non-sandbox → 402 PAYMENT_REQUIRED with price + access', async () => {
    const d = await authorizeCall({ headers: {}, sandbox: false, keys, usage: allowGate });
    expect(d.kind).toBe('deny');
    if (d.kind !== 'deny') return;
    expect(d.status).toBe(402);
    expect(d.payload.code).toBe('PAYMENT_REQUIRED');
    expect(d.payload.price_usd_per_call).toBe(PRICE_USD_PER_CALL);
    expect(d.payload.access).toBeTruthy();
  });

  it('invalid key → 402', async () => {
    const d = await authorizeCall({
      headers: { 'x-dql-key': 'dqlk_nope' },
      sandbox: false,
      keys,
      usage: allowGate,
    });
    expect(d.kind).toBe('deny');
    if (d.kind !== 'deny') return;
    expect(d.status).toBe(402);
  });

  it('valid dev_access key → allow with record', async () => {
    const d = await authorizeCall({
      headers: { 'x-dql-key': 'dqlk_dev' },
      sandbox: false,
      keys,
      usage: allowGate,
    });
    expect(d.kind).toBe('allow');
    if (d.kind !== 'allow') return;
    expect(d.record.dev_access).toBe(true);
    expect(d.record.owner).toBe('raul');
  });

  it('over daily cap → 429 QUOTA_EXCEEDED', async () => {
    const d = await authorizeCall({
      headers: { 'x-dql-key': 'dqlk_metered' },
      sandbox: false,
      keys,
      usage: denyGate,
    });
    expect(d.kind).toBe('deny');
    if (d.kind !== 'deny') return;
    expect(d.status).toBe(429);
    expect(d.payload.code).toBe('QUOTA_EXCEEDED');
  });

  it('empty registry fails closed: even a presented key 402s', async () => {
    const d = await authorizeCall({
      headers: { 'x-dql-key': 'dqlk_dev' },
      sandbox: false,
      keys: new Map(),
      usage: allowGate,
    });
    expect(d.kind).toBe('deny');
  });
});
