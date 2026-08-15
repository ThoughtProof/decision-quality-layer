/**
 * Post-purchase account surface.
 *
 * Identity after checkout is an account token (`dqla_…`), not the raw
 * `dqlk_…` verify key. The token is shown once on reveal; only its hash
 * is stored. Account token is never a verify key.
 *
 * Merge ≠ flag-on ≠ self-serve product. These routes do not enable
 * `DQL_CHECKOUT_ENABLED`.
 */

import { fingerprintAccountToken, fingerprintKey, sha256Hex } from './key-hash.js';
import {
  newStoredKeyRecord,
  type KeyStore,
  type StoredKeyRecord,
} from './key-store.js';
import { generateApiKey } from './checkout.js';
import { stripeFormRequest } from './stripe-http.js';

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

export interface AccountSnapshot {
  key_prefix: string;
  credits: number;
  trial: boolean;
  payg_opt_in: boolean;
  usage_today: number;
  daily_cap: number;
  email_masked: string;
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
  return {
    key_prefix: opts.record.prefix,
    credits,
    trial: opts.record.trial === true,
    payg_opt_in: opts.record.payg_opt_in === true,
    usage_today,
    daily_cap: opts.record.daily_cap,
    email_masked: maskEmail(opts.record.email_normalized),
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
