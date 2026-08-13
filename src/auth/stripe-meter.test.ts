import { describe, it, expect, vi } from 'vitest';
import {
  emitStripeMeterEvent,
  loadStripeMeterConfig,
  parseCustomerMap,
  STRIPE_METER_EVENT_NAME,
} from './stripe-meter.js';

describe('parseCustomerMap', () => {
  it('parses valid cus_ map', () => {
    const m = parseCustomerMap(JSON.stringify({ acme: 'cus_abc', bad: 'not_a_cus' }));
    expect(m.get('acme')).toBe('cus_abc');
    expect(m.has('bad')).toBe(false);
  });

  it('empty on garbage', () => {
    expect(parseCustomerMap('not-json').size).toBe(0);
    expect(parseCustomerMap(undefined).size).toBe(0);
  });
});

describe('loadStripeMeterConfig', () => {
  it('disabled by default', () => {
    const c = loadStripeMeterConfig({});
    expect(c.enabled).toBe(false);
  });

  it('enabled only with flag + secret', () => {
    expect(
      loadStripeMeterConfig({
        DQL_STRIPE_METER_ENABLED: 'true',
        STRIPE_SECRET_KEY: 'sk_test_x',
      }).enabled,
    ).toBe(true);
    expect(
      loadStripeMeterConfig({
        DQL_STRIPE_METER_ENABLED: 'true',
      }).enabled,
    ).toBe(false);
  });
});

describe('emitStripeMeterEvent', () => {
  it('skips when disabled', async () => {
    const r = await emitStripeMeterEvent({
      requestId: 'dql_1',
      owner: 'acme',
      config: {
        enabled: false,
        secretKey: '',
        eventName: STRIPE_METER_EVENT_NAME,
        customerByOwner: new Map(),
      },
    });
    expect(r).toEqual({ kind: 'skipped', reason: 'meter_disabled' });
  });

  it('skips without customer mapping', async () => {
    const r = await emitStripeMeterEvent({
      requestId: 'dql_1',
      owner: 'acme',
      config: {
        enabled: true,
        secretKey: 'sk_test',
        eventName: STRIPE_METER_EVENT_NAME,
        customerByOwner: new Map(),
      },
    });
    expect(r).toEqual({ kind: 'skipped', reason: 'no_customer_mapping' });
  });

  it('posts meter event with idempotency key', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ identifier: 'dql_req' }),
      text: async () => '',
      status: 200,
    }));

    const r = await emitStripeMeterEvent({
      requestId: 'dql_req',
      owner: 'acme',
      priceUsd: 0.05,
      fetchImpl: fetchMock as unknown as typeof fetch,
      nowSec: () => 1_700_000_000,
      config: {
        enabled: true,
        secretKey: 'sk_test_abc',
        eventName: STRIPE_METER_EVENT_NAME,
        customerByOwner: new Map([['acme', 'cus_123']]),
      },
    });

    expect(r.kind).toBe('ok');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const call0 = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const [url, init] = call0;
    expect(url).toContain('billing/meter_events');
    expect((init.headers as Record<string, string>)['Idempotency-Key']).toBe('dql_req');
    expect(String(init.body)).toContain('event_name=dql_verify_call');
    expect(String(init.body)).toContain('cus_123');
  });

  it('never throws on network error', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('network down');
    }) as unknown as typeof fetch;
    const r = await emitStripeMeterEvent({
      requestId: 'dql_x',
      owner: 'acme',
      fetchImpl,
      config: {
        enabled: true,
        secretKey: 'sk',
        eventName: STRIPE_METER_EVENT_NAME,
        customerByOwner: new Map([['acme', 'cus_1']]),
      },
    });
    expect(r.kind).toBe('error');
  });
});
