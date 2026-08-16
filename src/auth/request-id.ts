/**
 * Client-controlled verify idempotency / correlation id.
 *
 * Prefer `Idempotency-Key`, then a validated `X-Request-Id`. Strict charset
 * and length; values that look like secrets (`dqlk_`, `dqla_`, Stripe keys)
 * are rejected. Invalid Idempotency-Key is a client error. Invalid
 * X-Request-Id is ignored (proxies inject free-form ids).
 */

export const VERIFY_REQUEST_ID_MIN = 8;
export const VERIFY_REQUEST_ID_MAX = 128;
const REQUEST_ID_RE = /^[A-Za-z0-9._:-]{8,128}$/;
const SECRET_PREFIX_RE = /^(dqlk_|dqla_|sk_live_|sk_test_|rk_live_|rk_test_|whsec_)/i;

export type RequestIdSource = 'idempotency-key' | 'x-request-id' | 'generated';

export type ResolveVerifyRequestId =
  | { kind: 'ok'; id: string; source: RequestIdSource }
  | { kind: 'invalid'; header: 'Idempotency-Key' };

type HeaderMap = Record<string, unknown>;

function firstString(v: unknown): string | null {
  if (typeof v === 'string') return v;
  if (Array.isArray(v) && typeof v[0] === 'string') return v[0];
  return null;
}

function headerValue(headers: HeaderMap, names: string[]): string | null {
  for (const name of names) {
    const raw = firstString(headers[name] ?? headers[name.toLowerCase()]);
    if (raw != null) {
      const trimmed = raw.trim();
      if (trimmed) return trimmed;
    }
  }
  return null;
}

export function isValidVerifyRequestId(id: string): boolean {
  return REQUEST_ID_RE.test(id) && !SECRET_PREFIX_RE.test(id);
}

export function generateVerifyRequestId(): string {
  return `dql_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function resolveVerifyRequestId(headers: HeaderMap): ResolveVerifyRequestId {
  const idem = headerValue(headers, ['Idempotency-Key', 'idempotency-key']);
  if (idem) {
    if (!isValidVerifyRequestId(idem)) return { kind: 'invalid', header: 'Idempotency-Key' };
    return { kind: 'ok', id: idem, source: 'idempotency-key' };
  }
  const rid = headerValue(headers, ['X-Request-Id', 'x-request-id']);
  if (rid && isValidVerifyRequestId(rid)) {
    return { kind: 'ok', id: rid, source: 'x-request-id' };
  }
  return { kind: 'ok', id: generateVerifyRequestId(), source: 'generated' };
}
