/**
 * Post-purchase account surface.
 *
 * Identity after checkout is an account token (`dqla_…`), not the raw
 * `dqlk_…` verify key. The token is shown once on reveal; only its hash
 * is stored. Account token is never accepted as `X-DQL-Key`. It does
 * authorize `POST /dql/verify` via `X-DQL-Account` / Bearer `dqla_…`.
 *
 * Merge ≠ flag-on ≠ self-serve product. These routes do not enable
 * `DQL_CHECKOUT_ENABLED`.
 */

import { randomBytes } from 'node:crypto';

import { fingerprintAccountToken, fingerprintKey, sha256Hex } from './key-hash.js';
import {
  newStoredKeyRecord,
  storedToAuthRecord,
  type KeyStore,
  type StoredKeyRecord,
} from './key-store.js';
import { generateAccountToken, generateApiKey } from './checkout.js';
import { normalizeCheckoutEmail } from './packs.js';
import { stripeFormRequest } from './stripe-http.js';
import { PRICE_USD_PER_CALL } from '../pricing.js';
import type { AuthDecision } from './keys.js';

export const ACCOUNT_HEADER = 'X-DQL-Account';

type HeaderMap = Record<string, unknown>;

function firstString(v: unknown): string | null {
  if (typeof v === 'string') return v;
  if (Array.isArray(v) && typeof v[0] === 'string') return v[0];
  return null;
}

/** `X-DQL-Account` or `Authorization: Bearer dqla_…`. Never accepts `dqlk_…`. */
export function extractAccountToken(headers: HeaderMap): string | null {
  const direct = firstString(headers['x-dql-account'] ?? headers['X-DQL-Account']);
  if (direct && direct.trim().startsWith('dqla_')) return direct.trim();
  const auth = firstString(headers.authorization ?? headers.Authorization);
  if (auth) {
    const m = /^Bearer\s+(\S+)\s*$/i.exec(auth.trim());
    if (m?.[1]?.startsWith('dqla_')) return m[1];
  }
  return null;
}

export function maskEmail(email: string | undefined): string {
  const raw = (email ?? '').trim().toLowerCase();
  const at = raw.indexOf('@');
  if (at < 1 || at === raw.length - 1) return '';
  const local = raw.slice(0, at);
  const domain = raw.slice(at + 1);
  const keep = local.slice(0, 1);
  return `${keep}***@${domain}`;
}

export type AccountAuth =
  | { kind: 'ok'; token: string; record: StoredKeyRecord }
  | { kind: 'unauthorized' };

export async function authorizeAccount(opts: {
  headers: HeaderMap;
  store: KeyStore;
}): Promise<AccountAuth> {
  const token = extractAccountToken(opts.headers);
  if (!token) return { kind: 'unauthorized' };
  const record = await opts.store.lookupByAccountToken(token);
  if (!record) return { kind: 'unauthorized' };
  return { kind: 'ok', token, record };
}

const ACCOUNT_UNAUTHORIZED: AuthDecision = {
  kind: 'deny',
  status: 401,
  payload: {
    error: 'Valid account token required (X-DQL-Account or Authorization: Bearer dqla_…).',
    code: 'ACCOUNT_UNAUTHORIZED',
  },
};

/**
 * Authorize `POST /dql/verify` with the post-purchase account token.
 * Identity only: valid `dqla_…` + live (non-revoked) key hash.
 * Does not consume credits or increment daily-cap — that is
 * `reserveVerifyWithAccount` (admission) before `runVerification()`.
 * Missing/invalid/revoked → 401. Never returns `dqlk_…`.
 */
export async function authorizeVerifyWithAccount(opts: {
  headers: HeaderMap;
  store: KeyStore;
}): Promise<AuthDecision> {
  const token = extractAccountToken(opts.headers);
  if (!token) return ACCOUNT_UNAUTHORIZED;

  const stored = await opts.store.lookupByAccountToken(token);
  if (!stored || stored.revoked === true) return ACCOUNT_UNAUTHORIZED;

  return {
    kind: 'allow',
    key: stored.hash,
    record: storedToAuthRecord(stored),
    via: 'account',
  };
}

export type AccountReserveDecision =
  | {
      kind: 'execute';
      key: string;
      record: import('./keys.js').ApiKeyRecord;
      billing: import('./keys.js').AllowBilling;
      reservation: import('./key-store.js').VerifyReservation;
    }
  | {
      kind: 'replay';
      key: string;
      record: import('./keys.js').ApiKeyRecord;
      billing: import('./keys.js').AllowBilling;
      reservation: import('./key-store.js').VerifyReservation;
      result: unknown;
    }
  | {
      kind: 'meter_pending';
      key: string;
      record: import('./keys.js').ApiKeyRecord;
      billing: import('./keys.js').AllowBilling;
      reservation: import('./key-store.js').VerifyReservation;
      result: unknown;
    }
  | { kind: 'deny'; status: number; payload: Record<string, unknown> };

/**
 * Atomic pre-execution reservation of prepaid credit (or confirmed PAYG)
 * and daily-cap (one Redis EVAL). Namespaced per account key hash + requestId
 * + payload digest. Call before `runVerification()`.
 *   execute        — new hold; caller may run the engine
 *   replay         — committed; return stored result; do not run
 *   meter_pending  — engine already done; retry meter only
 *   deny 409       — in-progress (same account+payload) or payload mismatch
 *   deny 403       — same namespaced key bound to another hash (defense in depth)
 *   deny 402/429/503 — empty / quota / store error
 */
export async function reserveVerifyWithAccount(opts: {
  requestId: string;
  keyHash: string;
  payloadDigest: string;
  record: import('./keys.js').ApiKeyRecord;
  store: KeyStore;
  now?: Date;
}): Promise<AccountReserveDecision> {
  const result = await opts.store.reserveVerify({
    requestId: opts.requestId,
    keyHash: opts.keyHash,
    payloadDigest: opts.payloadDigest,
    dailyCap: opts.record.daily_cap,
    paygOptIn: opts.record.payg_opt_in === true,
    now: opts.now,
  });
  if (result.kind === 'ok') {
    return {
      kind: 'execute',
      key: opts.keyHash,
      record: opts.record,
      billing: result.reservation.billing,
      reservation: result.reservation,
    };
  }
  if (result.kind === 'replay') {
    return {
      kind: 'replay',
      key: opts.keyHash,
      record: opts.record,
      billing: result.reservation.billing,
      reservation: result.reservation,
      result: result.reservation.result,
    };
  }
  if (result.kind === 'meter_pending') {
    return {
      kind: 'meter_pending',
      key: opts.keyHash,
      record: opts.record,
      billing: result.reservation.billing,
      reservation: result.reservation,
      result: result.reservation.result,
    };
  }
  if (result.kind === 'in_progress') {
    return {
      kind: 'deny',
      status: 409,
      payload: {
        error: 'A verify with this Idempotency-Key is already in progress.',
        code: 'IDEMPOTENCY_IN_PROGRESS',
      },
    };
  }
  if (result.kind === 'conflict') {
    if (result.reason === 'account') {
      return {
        kind: 'deny',
        status: 403,
        payload: {
          error: 'This Idempotency-Key is bound to another account.',
          code: 'IDEMPOTENCY_KEY_BOUND',
        },
      };
    }
    return {
      kind: 'deny',
      status: 409,
      payload: {
        error: 'Idempotency-Key was used with a different verify payload.',
        code: 'IDEMPOTENCY_PAYLOAD_MISMATCH',
      },
    };
  }
  if (result.kind === 'quota') {
    return {
      kind: 'deny',
      status: 429,
      payload: {
        error: `Daily cap of ${opts.record.daily_cap} calls exceeded for this key.`,
        code: 'QUOTA_EXCEEDED',
        retry_after: 'next UTC day',
      },
    };
  }
  if (result.kind === 'error') {
    return {
      kind: 'deny',
      status: 503,
      payload: {
        error: 'Credit ledger unavailable.',
        code: 'CREDITS_UNAVAILABLE',
        no_freemium: true,
      },
    };
  }
  return {
    kind: 'deny',
    status: 402,
    payload: {
      error: 'Prepaid credits exhausted. Opt in to pay-as-you-go or buy a credit pack.',
      code: 'CREDITS_EXHAUSTED',
      price_usd_per_call: PRICE_USD_PER_CALL,
      no_freemium: true,
    },
  };
}

export async function commitVerifyReservation(opts: {
  requestId: string;
  keyHash: string;
  fence: number;
  store: KeyStore;
  result?: unknown;
  meter?: import('./key-store.js').VerifyReservation['meter'];
}): Promise<import('./key-store.js').CommitReservationAck> {
  return opts.store.commitVerifyReservation({
    requestId: opts.requestId,
    keyHash: opts.keyHash,
    fence: opts.fence,
    result: opts.result,
    meter: opts.meter,
  });
}

export async function persistMeterPending(opts: {
  requestId: string;
  keyHash: string;
  fence: number;
  store: KeyStore;
  result: unknown;
}): Promise<import('./key-store.js').PersistPendingAck> {
  return opts.store.persistMeterPending({
    requestId: opts.requestId,
    keyHash: opts.keyHash,
    fence: opts.fence,
    result: opts.result,
  });
}

export async function releaseVerifyReservation(opts: {
  requestId: string;
  keyHash: string;
  fence: number;
  store: KeyStore;
}): Promise<import('./key-store.js').ReleaseReservationAck> {
  return opts.store.releaseVerifyReservation({
    requestId: opts.requestId,
    keyHash: opts.keyHash,
    fence: opts.fence,
  });
}

export interface AccountSnapshot {
  key_prefix: string;
  credits: number;
  trial: boolean;
  payg_opt_in: boolean;
  usage_today: number;
  daily_cap: number;
  email_masked: string;
  /** Full email for the authenticated owner only (top-up / portal UX). */
  email?: string;
  revoked: boolean;
}

export async function getAccountSnapshot(opts: {
  record: StoredKeyRecord;
  store: KeyStore;
  now?: Date;
}): Promise<AccountSnapshot> {
  const [credits, usage_today] = await Promise.all([
    opts.store.creditBalance(opts.record.hash),
    opts.store.usageToday(opts.record.hash, opts.now),
  ]);
  const email = (opts.record.email_normalized ?? '').trim().toLowerCase();
  return {
    key_prefix: opts.record.prefix,
    credits,
    trial: opts.record.trial === true,
    payg_opt_in: opts.record.payg_opt_in === true,
    usage_today,
    daily_cap: opts.record.daily_cap,
    email_masked: maskEmail(email),
    // Authenticated account session — owner may see their own address for top-up.
    email: email || undefined,
    revoked: opts.record.revoked === true,
  };
}

export type PortalResult =
  | { kind: 'ok'; url: string }
  | { kind: 'unconfigured'; reason: string }
  | { kind: 'error'; reason: string };

export async function createBillingPortalSession(opts: {
  record: StoredKeyRecord;
  secretKey: string;
  returnUrl: string;
  configuration?: string;
  fetchImpl?: typeof fetch;
}): Promise<PortalResult> {
  if (!opts.secretKey) return { kind: 'unconfigured', reason: 'missing_stripe_secret' };
  if (!opts.record.stripe_customer_id.startsWith('cus_')) {
    return { kind: 'unconfigured', reason: 'missing_customer' };
  }

  const params: Record<string, string> = {
    customer: opts.record.stripe_customer_id,
    return_url: opts.returnUrl,
  };
  if (opts.configuration) params.configuration = opts.configuration;

  const session = await stripeFormRequest<{ url?: string }>({
    secretKey: opts.secretKey,
    method: 'POST',
    path: '/billing_portal/sessions',
    params,
    fetchImpl: opts.fetchImpl,
  });
  if (session.kind === 'error') {
    // Stripe rejects this when Customer Portal is not activated in Dashboard.
    return { kind: 'unconfigured', reason: session.reason };
  }
  if (!session.body.url) return { kind: 'error', reason: 'no_portal_url' };
  return { kind: 'ok', url: session.body.url };
}

export type RotateResult =
  | { kind: 'ok'; api_key: string; key_prefix: string; shown_once: true }
  | { kind: 'in_progress' }
  | { kind: 'error'; reason: string };

export async function rotateAccountKey(opts: {
  record: StoredKeyRecord;
  store: KeyStore;
  token: string;
}): Promise<RotateResult> {
  const lockId = `acct-rotate:${opts.record.stripe_customer_id}`;
  const locked = await opts.store.acquireMintLock(lockId);
  if (!locked) return { kind: 'in_progress' };

  const live = await opts.store.lookupByAccountToken(opts.token);
  if (!live) return { kind: 'error', reason: 'missing_record' };

  const plaintext = generateApiKey();
  const next = newStoredKeyRecord({
    plaintextKey: plaintext,
    owner: live.owner,
    stripeCustomerId: live.stripe_customer_id,
    dailyCap: live.daily_cap,
    paygOptIn: live.payg_opt_in,
    trial: live.trial,
    emailNormalized: live.email_normalized,
    accountTokenHash: live.account_token_hash ?? sha256Hex(opts.token),
  });

  await opts.store.putKey(next);
  await opts.store.moveCredits(live.hash, next.hash);
  await opts.store.moveCreditLedger(live.hash, next.hash);
  await opts.store.putCustomerKey(live.stripe_customer_id, next.hash);
  if (next.account_token_hash) {
    await opts.store.putAccountIndex(next.account_token_hash, next.hash);
  }
  if (next.email_normalized) {
    await opts.store.putEmailIndex(next.email_normalized, next.hash);
  }
  await opts.store.revokeByHash(live.hash);

  console.log(
    JSON.stringify({
      type: 'dql_key_rotate',
      owner: live.owner,
      customer_fingerprint: live.stripe_customer_id.startsWith('cus_')
        ? sha256Hex(live.stripe_customer_id).slice(0, 12)
        : undefined,
      key_fingerprint: fingerprintKey(plaintext),
      account_fingerprint: fingerprintAccountToken(opts.token),
      prefix: next.prefix,
      ts: new Date().toISOString(),
    }),
  );

  return { kind: 'ok', api_key: plaintext, key_prefix: next.prefix, shown_once: true };
}

export type RevokeResult = { kind: 'ok'; key_prefix: string; revoked: true } | { kind: 'error'; reason: string };

export async function revokeAccountKey(opts: {
  record: StoredKeyRecord;
  store: KeyStore;
}): Promise<RevokeResult> {
  const ok = await opts.store.revokeByHash(opts.record.hash);
  if (!ok) return { kind: 'error', reason: 'missing_record' };
  console.log(
    JSON.stringify({
      type: 'dql_key_revoke',
      owner: opts.record.owner,
      prefix: opts.record.prefix,
      ts: new Date().toISOString(),
    }),
  );
  return { kind: 'ok', key_prefix: opts.record.prefix, revoked: true };
}

// ── Email magic-link login (public account recovery) ───────────────────────

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const LOGIN_TOKEN_PREFIX = 'dqll_';

export function generateLoginToken(): string {
  return `${LOGIN_TOKEN_PREFIX}${randomBytes(32).toString('hex')}`;
}

export type ResolveAccountByEmailResult =
  | { kind: 'ok'; record: StoredKeyRecord }
  | { kind: 'not_found' }
  | { kind: 'error'; reason: string };

/** Prefer Redis email index; fall back to Stripe customer → cus-key. */
export async function resolveAccountByEmail(opts: {
  email: string;
  store: KeyStore;
  secretKey?: string;
  fetchImpl?: typeof fetch;
}): Promise<ResolveAccountByEmailResult> {
  const email = normalizeCheckoutEmail(opts.email);
  if (!EMAIL_RE.test(email)) return { kind: 'not_found' };

  const indexed = await opts.store.lookupByEmail(email);
  if (indexed && indexed.revoked !== true) return { kind: 'ok', record: indexed };

  const secretKey = (opts.secretKey ?? '').trim();
  if (!secretKey) return { kind: 'not_found' };

  const existing = await stripeFormRequest<{ data?: Array<{ id?: string }> }>({
    secretKey,
    method: 'GET',
    path: '/customers',
    params: { email, limit: '1' },
    fetchImpl: opts.fetchImpl,
  });
  if (existing.kind === 'error') return { kind: 'error', reason: existing.reason };
  const customerId = existing.body.data?.[0]?.id;
  if (!customerId?.startsWith('cus_')) return { kind: 'not_found' };

  const keyHash = await opts.store.getKeyHashByCustomer(customerId);
  if (!keyHash) return { kind: 'not_found' };
  const rec = await opts.store.getRecordByHash(keyHash);
  if (!rec || rec.revoked === true) return { kind: 'not_found' };

  // Heal indexes for next login.
  await opts.store.putEmailIndex(email, rec.hash);
  if (!rec.email_normalized) {
    const next = { ...rec, email_normalized: email };
    await opts.store.putKey(next);
    return { kind: 'ok', record: next };
  }
  return { kind: 'ok', record: rec };
}

export type RequestLoginResult =
  | { kind: 'sent'; email_masked: string }
  | { kind: 'accepted' } // no account / no enumeration
  | { kind: 'invalid_email' }
  | { kind: 'unconfigured'; reason: string }
  | { kind: 'error'; reason: string };

export async function requestAccountLogin(opts: {
  email: string;
  store: KeyStore;
  secretKey?: string;
  resendApiKey?: string;
  fromEmail?: string;
  appBaseUrl: string;
  fetchImpl?: typeof fetch;
}): Promise<RequestLoginResult> {
  const email = normalizeCheckoutEmail(opts.email);
  if (!EMAIL_RE.test(email)) return { kind: 'invalid_email' };

  const resolved = await resolveAccountByEmail({
    email,
    store: opts.store,
    secretKey: opts.secretKey,
    fetchImpl: opts.fetchImpl,
  });

  // Always return accepted for unknown emails (no enumeration).
  if (resolved.kind === 'not_found') return { kind: 'accepted' };
  if (resolved.kind === 'error') return { kind: 'error', reason: resolved.reason };

  const resendKey = (opts.resendApiKey ?? '').trim();
  if (!resendKey) return { kind: 'unconfigured', reason: 'missing_resend' };

  const loginToken = generateLoginToken();
  const tokenHash = sha256Hex(loginToken);
  await opts.store.putLoginToken(tokenHash, {
    key_hash: resolved.record.hash,
    email_normalized: email,
    created_at: new Date().toISOString(),
  });

  const base = opts.appBaseUrl.replace(/\/$/, '');
  const link = `${base}/account?login=${encodeURIComponent(loginToken)}`;
  const from =
    (opts.fromEmail ?? '').trim() || 'ThoughtProof <noreply@thoughtproof.ai>';

  const sent = await sendLoginEmail({
    apiKey: resendKey,
    from,
    to: email,
    link,
    fetchImpl: opts.fetchImpl,
  });
  if (sent.kind !== 'ok') return { kind: 'error', reason: sent.reason };

  console.log(
    JSON.stringify({
      type: 'dql_account_login_sent',
      email_masked: maskEmail(email),
      owner: resolved.record.owner,
      prefix: resolved.record.prefix,
      ts: new Date().toISOString(),
    }),
  );

  return { kind: 'sent', email_masked: maskEmail(email) };
}

export type ConsumeLoginResult =
  | { kind: 'ok'; account_token: string; shown_once: true; key_prefix: string; credits: number }
  | { kind: 'invalid' }
  | { kind: 'error'; reason: string };

/** Exchange one-time login token for a fresh `dqla_…` session handle. */
export async function consumeAccountLogin(opts: {
  loginToken: string;
  store: KeyStore;
}): Promise<ConsumeLoginResult> {
  const raw = (opts.loginToken ?? '').trim();
  if (!raw.startsWith(LOGIN_TOKEN_PREFIX) || raw.length < 20) return { kind: 'invalid' };

  const payload = await opts.store.consumeLoginToken(sha256Hex(raw));
  if (!payload) return { kind: 'invalid' };

  const rec = await opts.store.getRecordByHash(payload.key_hash);
  if (!rec || rec.revoked === true) return { kind: 'invalid' };

  const accountToken = generateAccountToken();
  const accountHash = sha256Hex(accountToken);
  const prevAccountHash = rec.account_token_hash;
  const next: StoredKeyRecord = {
    ...rec,
    account_token_hash: accountHash,
    email_normalized: rec.email_normalized || payload.email_normalized,
  };
  await opts.store.putKey(next);
  // Invalidate previous browser sessions on fresh login.
  if (prevAccountHash && prevAccountHash !== accountHash) {
    await opts.store.clearAccountIndex(prevAccountHash);
  }
  await opts.store.putAccountIndex(accountHash, next.hash);
  await opts.store.putEmailIndex(next.email_normalized || payload.email_normalized, next.hash);

  const credits = await opts.store.creditBalance(next.hash);

  console.log(
    JSON.stringify({
      type: 'dql_account_login_consumed',
      email_masked: maskEmail(payload.email_normalized),
      owner: next.owner,
      prefix: next.prefix,
      account_fingerprint: fingerprintAccountToken(accountToken),
      ts: new Date().toISOString(),
    }),
  );

  return {
    kind: 'ok',
    account_token: accountToken,
    shown_once: true,
    key_prefix: next.prefix,
    credits,
  };
}

async function sendLoginEmail(opts: {
  apiKey: string;
  from: string;
  to: string;
  link: string;
  fetchImpl?: typeof fetch;
}): Promise<{ kind: 'ok' } | { kind: 'error'; reason: string }> {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12_000);
  try {
    const res = await fetchImpl('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${opts.apiKey}`,
        'Content-Type': 'application/json',
      },
      signal: controller.signal,
      body: JSON.stringify({
        from: opts.from,
        to: [opts.to],
        subject: 'Sign in to your ThoughtProof DQL account',
        text: [
          'Sign in to manage your DQL credits and API key.',
          '',
          opts.link,
          '',
          'This link expires in 15 minutes and can be used once.',
          'If you did not request this, ignore the email.',
        ].join('\n'),
        html: `<p>Sign in to manage your DQL credits and API key.</p>
<p><a href="${opts.link}">Open your DQL account</a></p>
<p style="color:#666;font-size:13px">This link expires in 15 minutes and can be used once. If you did not request this, ignore the email.</p>`,
      }),
    });
    if (!res.ok) {
      return { kind: 'error', reason: `resend_http_${res.status}` };
    }
    return { kind: 'ok' };
  } catch (err) {
    const reason =
      err instanceof Error && /aborted|timeout|AbortError/i.test(err.message)
        ? 'timeout'
        : 'resend_failed';
    return { kind: 'error', reason };
  } finally {
    clearTimeout(timer);
  }
}
