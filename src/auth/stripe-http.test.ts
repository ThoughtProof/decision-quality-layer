import { createHmac } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { verifyStripeSignature } from './stripe-http.js';

function sign(payload: string, secret: string, t: number): string {
  const hex = createHmac('sha256', secret).update(`${t}.${payload}`, 'utf8').digest('hex');
  return `t=${t},v1=${hex}`;
}

describe('verifyStripeSignature', () => {
  const secret = 'whsec_testsecret_aaaaaaaaaaaaaaaa';
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
