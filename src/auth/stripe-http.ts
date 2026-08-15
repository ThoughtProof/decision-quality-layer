/**
 * Minimal Stripe REST + webhook signature verify.
 *
 * No Stripe SDK dependency — same fetch + form-urlencoded style as
 * `src/auth/stripe-meter.ts`. Webhook HMAC is required; unsigned events
 * are rejected.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

export const STRIPE_API_BASE = 'https://api.stripe.com/v1';
export const STRIPE_API_VERSION = '2024-11-20.acacia';
export const STRIPE_WEBHOOK_TOLERANCE_SEC = 300;
export const STRIPE_HTTP_TIMEOUT_MS = 15_000;

export type StripeHttpResult<T> =
  | { kind: 'ok'; body: T; status: number }
  | { kind: 'error'; reason: string; status?: number };

export async function stripeFormRequest<T>(opts: {
  secretKey: string;
  method: 'GET' | 'POST';
  path: string;
  params?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  idempotencyKey?: string;
}): Promise<StripeHttpResult<T>> {
  const url = new URL(opts.path.startsWith('http') ? opts.path : `${STRIPE_API_BASE}${opts.path}`);
  const body = new URLSearchParams();
  if (opts.params) {
    for (const [k, v] of Object.entries(opts.params)) {
      if (v != null && v !== '') body.set(k, v);
    }
  }
  if (opts.method === 'GET' && body.toString()) {
    for (const [k, v] of body.entries()) url.searchParams.set(k, v);
  }

  const headers: Record<string, string> = {
    Authorization: `Bearer ${opts.secretKey}`,
    'Stripe-Version': STRIPE_API_VERSION,
  };
  if (opts.idempotencyKey) headers['Idempotency-Key'] = opts.idempotencyKey;

  const init: RequestInit = { method: opts.method, headers };
  if (opts.method === 'POST') {
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
    init.body = body.toString();
  }

  const fetchImpl = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const timeoutMs = opts.timeoutMs ?? STRIPE_HTTP_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetchImpl(url.toString(), { ...init, signal: controller.signal });
    const json = (await resp.json().catch(() => ({}))) as T;
    if (!resp.ok) {
      await Promise.resolve(); // keep body consumed
      return { kind: 'error', reason: `http_${resp.status}`, status: resp.status };
    }
    return { kind: 'ok', body: json, status: resp.status };
  } catch (err) {
    const reason =
      err instanceof Error && /aborted|timeout|AbortError/i.test(err.message)
        ? 'timeout'
        : err instanceof Error && /fetch failed|ECONN|ENOTFOUND|network/i.test(err.message)
          ? 'network'
          : 'fetch_failed';
    return { kind: 'error', reason };
  } finally {
    clearTimeout(timer);
  }
}

export type StripeSignatureResult = { ok: true; timestamp: number } | { ok: false; reason: string };

/**
 * Verify `Stripe-Signature` per
 * https://docs.stripe.com/webhooks/signature
 *
 * signed_payload = `${t}.${rawBody}`
 * expected = HMAC-SHA256(whsec, signed_payload)
 */
export function verifyStripeSignature(opts: {
  payload: string;
  header: string | undefined;
  secret: string;
  toleranceSec?: number;
  nowSec?: number;
}): StripeSignatureResult {
  const header = (opts.header ?? '').trim();
  if (!header) return { ok: false, reason: 'missing_header' };
  if (!opts.secret.startsWith('whsec_')) return { ok: false, reason: 'invalid_secret' };

  const parts = header.split(',').map((p) => p.trim());
  let timestamp: number | undefined;
  const v1: string[] = [];
  for (const part of parts) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const k = part.slice(0, eq);
    const val = part.slice(eq + 1);
    if (k === 't') {
      const n = Number(val);
      if (Number.isFinite(n)) timestamp = n;
    } else if (k === 'v1') {
      v1.push(val);
    }
  }
  if (timestamp == null || v1.length === 0) return { ok: false, reason: 'malformed_header' };

  const now = opts.nowSec ?? Math.floor(Date.now() / 1000);
  const tolerance = opts.toleranceSec ?? STRIPE_WEBHOOK_TOLERANCE_SEC;
  if (Math.abs(now - timestamp) > tolerance) return { ok: false, reason: 'timestamp_out_of_tolerance' };

  const signed = `${timestamp}.${opts.payload}`;
  const expectedHex = createHmac('sha256', opts.secret).update(signed, 'utf8').digest('hex');
  const expectedBuf = Buffer.from(expectedHex, 'hex');

  let match = false;
  for (const sig of v1) {
    try {
      const got = Buffer.from(sig, 'hex');
      if (got.length === expectedBuf.length && timingSafeEqual(got, expectedBuf)) {
        match = true;
      }
    } catch {
      // ignore malformed hex; still scan remaining v1 signatures
    }
  }
  if (!match) return { ok: false, reason: 'bad_signature' };
  return { ok: true, timestamp };
}

export async function readRawBody(req: {
  body?: unknown;
  on?: (event: string, cb: (chunk: Buffer | string) => void) => void;
}): Promise<string> {
  // Vercel may still parse JSON into req.body even with `bodyParser: false`.
  // The Node stream still has the exact bytes Stripe signed — prefer that.
  // Never JSON.stringify a parsed object for HMAC (key order / whitespace diverge).
  if (typeof req.on === 'function') {
    return await new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      req.on!('data', (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
      req.on!('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      req.on!('error', (err) => reject(err));
    });
  }
  if (typeof req.body === 'string') return req.body;
  if (Buffer.isBuffer(req.body)) return req.body.toString('utf8');
  throw new Error('raw_body_unavailable');
}
