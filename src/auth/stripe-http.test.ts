import { createHmac } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { describe, it, expect } from 'vitest';
import { readRawBody, verifyStripeSignature } from './stripe-http.js';

function sign(payload: string, secret: string, t: number): string {
  const hex = createHmac('sha256', secret).update(`${t}.${payload}`, 'utf8').digest('hex');
  return `t=${t},v1=${hex}`;
}

describe('verifyStripeSignature', () => {
  const secret = 'whsec_' + 'a'.repeat(24);
  const payload = '{"type":"checkout.session.completed"}';
  const t = 1_700_000_000;

  it('accepts a valid v1 signature', () => {
    const r = verifyStripeSignature({
      payload,
      header: sign(payload, secret, t),
      secret,
      nowSec: t,
    });
    expect(r.ok).toBe(true);
  });

  it('rejects missing header, bad secret, and wrong hmac', () => {
    expect(verifyStripeSignature({ payload, header: undefined, secret, nowSec: t }).ok).toBe(false);
    expect(
      verifyStripeSignature({ payload, header: sign(payload, secret, t), secret: 'sk_not_whsec', nowSec: t })
        .ok,
    ).toBe(false);
    expect(
      verifyStripeSignature({
        payload,
        header: `t=${t},v1=${'ab'.repeat(32)}`,
        secret,
        nowSec: t,
      }).ok,
    ).toBe(false);
  });

  it('rejects stale timestamps', () => {
    const r = verifyStripeSignature({
      payload,
      header: sign(payload, secret, t),
      secret,
      nowSec: t + 400,
      toleranceSec: 300,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('timestamp_out_of_tolerance');
  });
});

describe('readRawBody', () => {
  it('prefers Node stream bytes over a parsed req.body object (exact Stripe payload)', async () => {
    // Whitespace / key order that JSON.stringify(parsed) would not reproduce.
    const raw = '{ "type": "checkout.session.completed", "b": 2, "a": 1 }';
    const req = new EventEmitter() as EventEmitter & { body?: unknown };
    req.body = JSON.parse(raw);
    expect(JSON.stringify(req.body)).not.toBe(raw);

    queueMicrotask(() => {
      req.emit('data', Buffer.from(raw, 'utf8'));
      req.emit('end');
    });

    await expect(readRawBody(req)).resolves.toBe(raw);
  });

  it('falls back to string or Buffer body when no stream is available', async () => {
    await expect(readRawBody({ body: '{"ok":true}' })).resolves.toBe('{"ok":true}');
    await expect(readRawBody({ body: Buffer.from('{"ok":true}', 'utf8') })).resolves.toBe('{"ok":true}');
  });

  it('fails closed on a parsed object with no stream (never re-serializes for HMAC)', async () => {
    await expect(readRawBody({ body: { type: 'checkout.session.completed' } })).rejects.toThrow(
      'raw_body_unavailable',
    );
  });
});
