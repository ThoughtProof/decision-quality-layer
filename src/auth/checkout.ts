/**
 * Self-serve Stripe Checkout → billable `dqlk_…` mint.
 *
 * Default OFF (`DQL_CHECKOUT_ENABLED`). Merge does not turn on public billing.
 * Sandbox stays free/keyless. Minted keys are always `dev_access: false`.
 *
 * Flow:
 *   POST /dql/checkout { email } → Customer + Checkout Session URL
 *   Stripe webhook `checkout.session.completed` (signed) → mint (idempotent)
 *   GET  /dql/checkout?session_id=cs_… → reveal plaintext ONCE
 *
 * Plaintext is never logged and lives only in a short-TTL reveal token
 * (`dql:reveal:<token>`), consumed with GETDEL. Success URL carries the
 * Checkout session id, not the API key.
 */

import { randomBytes } from 'node:crypto';

import { DEFAULT_DAILY_CAP } from './keys.js';
import { truthy } from './env-flag.js';
import { fingerprintCustomer, fingerprintKey, keyDisplayPrefix } from './key-hash.js';
import {
  newStoredKeyRecord,
  selfServeOwner,
  type CheckoutMintState,
  type KeyStore,
} from './key-store.js';
import { stripeFormRequest, verifyStripeSignature } from './stripe-http.js';

export const CHECKOUT_FLAG = 'DQL_CHECKOUT_ENABLED';
export const REVEAL_TTL_SEC = 15 * 60;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function isCheckoutEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return truthy(env[CHECKOUT_FLAG]);
}

export function publicBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = (env.DQL_PUBLIC_BASE_URL ?? '').trim();
  if (explicit) return explicit.replace(/\/$/, '');
  const vercel = (env.VERCEL_URL ?? '').trim();
  if (vercel) {
    const host = vercel.replace(/^https?:\/\//, '');
    return `https://${host}`;
  }
  return 'https://dql.thoughtproof.ai';
}

export function generateApiKey(): string {
  return `dqlk_${randomBytes(32).toString('hex')}`;
}

export function generateRevealToken(): string {
  return randomBytes(24).toString('hex');
}

export interface CheckoutConfig {
  enabled: boolean;
  secretKey: string;
  webhookSecret: string;
  priceId: string;
  publicBase: string;
  cancelUrl: string;
}

export function loadCheckoutConfig(env: NodeJS.ProcessEnv = process.env): CheckoutConfig {
  const secretKey = (env.STRIPE_SECRET_KEY ?? '').trim();
  const webhookSecret = (env.STRIPE_WEBHOOK_SECRET ?? '').trim();
  const priceId = (env.DQL_STRIPE_PRICE_ID ?? '').trim();
  const publicBase = publicBaseUrl(env);
  const cancelUrl = (env.DQL_CHECKOUT_CANCEL_URL ?? '').trim() || `${publicBase}/`;
  return {
    enabled: isCheckoutEnabled(env) && secretKey.length > 0,
    secretKey,
    webhookSecret,
    priceId,
    publicBase,
    cancelUrl,
  };
}

export type CreateCheckoutResult =
  | { kind: 'ok'; url: string; session_id: string; customer_id: string }
  | { kind: 'disabled' }
  | { kind: 'unconfigured'; reason: string }
  | { kind: 'invalid'; reason: string }
  | { kind: 'error'; reason: string };

export interface StripeCustomer {
  id: string;
  email?: string;
}

export interface StripeCheckoutSession {
  id: string;
  status?: string;
  customer?: string | { id?: string } | null;
  metadata?: Record<string, string> | null;
  url?: string | null;
  mode?: string;
}

function customerIdOf(session: StripeCheckoutSession): string | undefined {
  const c = session.customer;
  if (typeof c === 'string' && c.startsWith('cus_')) return c;
  if (c && typeof c === 'object' && typeof c.id === 'string' && c.id.startsWith('cus_')) return c.id;
  return undefined;
}

function isDqlCheckoutSession(session: StripeCheckoutSession): boolean {
  return session.metadata?.dql_checkout === '1';
}

export async function createCheckoutSession(opts: {
  email: string;
  store: KeyStore;
  config: CheckoutConfig;
  fetchImpl?: typeof fetch;
}): Promise<CreateCheckoutResult> {
  if (!opts.config.enabled) return { kind: 'disabled' };
  if (!opts.config.secretKey) return { kind: 'unconfigured', reason: 'missing_stripe_secret' };

  const email = opts.email.trim().toLowerCase();
  if (!EMAIL_RE.test(email)) return { kind: 'invalid', reason: 'invalid_email' };

  const existing = await stripeFormRequest<{ data?: StripeCustomer[] }>({
    secretKey: opts.config.secretKey,
    method: 'GET',
    path: '/customers',
    params: { email, limit: '1' },
    fetchImpl: opts.fetchImpl,
  });
  if (existing.kind === 'error') return { kind: 'error', reason: existing.reason };

  let customerId = existing.body.data?.[0]?.id;
  if (!customerId?.startsWith('cus_')) {
    const created = await stripeFormRequest<StripeCustomer>({
      secretKey: opts.config.secretKey,
      method: 'POST',
      path: '/customers',
      params: {
        email,
        'metadata[dql]': 'self_serve',
      },
      fetchImpl: opts.fetchImpl,
    });
    if (created.kind === 'error') return { kind: 'error', reason: created.reason };
    customerId = created.body.id;
  }
  if (!customerId?.startsWith('cus_')) return { kind: 'error', reason: 'no_customer' };

  const owner = selfServeOwner(customerId);
  await opts.store.putCustomerMap(owner, customerId);

  const successUrl = `${opts.config.publicBase}/dql/checkout?session_id={CHECKOUT_SESSION_ID}`;
  const params: Record<string, string> = {
    mode: opts.config.priceId ? 'subscription' : 'setup',
    customer: customerId,
    success_url: successUrl,
    cancel_url: opts.config.cancelUrl,
    client_reference_id: owner,
    'metadata[dql_checkout]': '1',
    'metadata[owner]': owner,
    'payment_method_types[0]': 'card',
  };
  if (opts.config.priceId) {
    params['line_items[0][price]'] = opts.config.priceId;
    // Metered prices require quantity omitted; Stripe rejects quantity on metered.
  }

  const session = await stripeFormRequest<StripeCheckoutSession>({
    secretKey: opts.config.secretKey,
    method: 'POST',
    path: '/checkout/sessions',
    params,
    fetchImpl: opts.fetchImpl,
  });
  if (session.kind === 'error') return { kind: 'error', reason: session.reason };
  if (!session.body.id || !session.body.url) return { kind: 'error', reason: 'no_session_url' };

  const pending: CheckoutMintState = {
    session_id: session.body.id,
    customer_id: customerId,
    owner,
    status: 'pending',
  };
  await opts.store.putCheckout(pending);

  console.log(
    JSON.stringify({
      type: 'dql_checkout_session',
      session_id: session.body.id,
      owner,
      customer_fingerprint: fingerprintCustomer(customerId),
      mode: params.mode,
      ts: new Date().toISOString(),
    }),
  );

  return {
    kind: 'ok',
    url: session.body.url,
    session_id: session.body.id,
    customer_id: customerId,
  };
}

export type MintResult =
  | {
      kind: 'minted';
      plaintext: string;
      revealToken: string;
      prefix: string;
      owner: string;
      customerId: string;
    }
  | {
      kind: 'already_minted';
      prefix?: string;
      owner: string;
      customerId: string;
      revealToken?: string;
    }
  | { kind: 'in_progress' }
  | { kind: 'error'; reason: string };

export async function finalizeCheckoutMint(opts: {
  sessionId: string;
  customerId: string;
  owner: string;
  store: KeyStore;
  dailyCap?: number;
}): Promise<MintResult> {
  const existing = await opts.store.getCheckout(opts.sessionId);
  if (existing?.key_hash) {
    return {
      kind: 'already_minted',
      prefix: existing.prefix,
      owner: existing.owner,
      customerId: existing.customer_id,
      revealToken: existing.reveal_token,
    };
  }

  const locked = await opts.store.acquireMintLock(opts.sessionId);
  if (!locked) {
    const again = await opts.store.getCheckout(opts.sessionId);
    if (again?.key_hash) {
      return {
        kind: 'already_minted',
        prefix: again.prefix,
        owner: again.owner,
        customerId: again.customer_id,
        revealToken: again.reveal_token,
      };
    }
    return { kind: 'in_progress' };
  }

  const again = await opts.store.getCheckout(opts.sessionId);
  if (again?.key_hash) {
    return {
      kind: 'already_minted',
      prefix: again.prefix,
      owner: again.owner,
      customerId: again.customer_id,
      revealToken: again.reveal_token,
    };
  }

  const plaintext = generateApiKey();
  const record = newStoredKeyRecord({
    plaintextKey: plaintext,
    owner: opts.owner,
    stripeCustomerId: opts.customerId,
    dailyCap: opts.dailyCap ?? DEFAULT_DAILY_CAP,
  });
  const revealToken = generateRevealToken();

  await opts.store.putKey(record);
  await opts.store.putCustomerMap(opts.owner, opts.customerId);
  await opts.store.putReveal(revealToken, plaintext, REVEAL_TTL_SEC);
  await opts.store.putCheckout({
    session_id: opts.sessionId,
    customer_id: opts.customerId,
    owner: opts.owner,
    status: 'minted',
    key_hash: record.hash,
    prefix: record.prefix,
    reveal_token: revealToken,
    minted_at: record.created,
  });

  console.log(
    JSON.stringify({
      type: 'dql_key_mint',
      session_id: opts.sessionId,
      owner: opts.owner,
      customer_fingerprint: fingerprintCustomer(opts.customerId),
      key_fingerprint: fingerprintKey(plaintext),
      prefix: record.prefix,
      ts: new Date().toISOString(),
    }),
  );

  return {
    kind: 'minted',
    plaintext,
    revealToken,
    prefix: record.prefix,
    owner: opts.owner,
    customerId: opts.customerId,
  };
}

export type RevealResult =
  | { kind: 'ok'; api_key: string; prefix: string; owner: string; shown_once: true }
  | { kind: 'pending' }
  | { kind: 'in_progress' }
  | { kind: 'already_delivered'; prefix?: string; owner?: string }
  | { kind: 'invalid'; reason: string }
  | { kind: 'error'; reason: string };

export async function revealCheckoutKey(opts: {
  sessionId: string;
  store: KeyStore;
  config: CheckoutConfig;
  fetchImpl?: typeof fetch;
}): Promise<RevealResult> {
  if (!opts.sessionId.startsWith('cs_')) return { kind: 'invalid', reason: 'bad_session_id' };
  if (!opts.config.secretKey) return { kind: 'error', reason: 'missing_stripe_secret' };

  const retrieved = await stripeFormRequest<StripeCheckoutSession>({
    secretKey: opts.config.secretKey,
    method: 'GET',
    path: `/checkout/sessions/${encodeURIComponent(opts.sessionId)}`,
    fetchImpl: opts.fetchImpl,
  });
  if (retrieved.kind === 'error') {
    if (retrieved.status === 404) return { kind: 'invalid', reason: 'unknown_session' };
    return { kind: 'error', reason: retrieved.reason };
  }

  const session = retrieved.body;
  if (!isDqlCheckoutSession(session)) return { kind: 'invalid', reason: 'not_dql_checkout' };
  if (session.status !== 'complete') return { kind: 'pending' };

  const customerId = customerIdOf(session);
  const owner = session.metadata?.owner || (customerId ? selfServeOwner(customerId) : '');
  if (!customerId || !owner) return { kind: 'error', reason: 'no_customer' };

  const minted = await finalizeCheckoutMint({
    sessionId: session.id,
    customerId,
    owner,
    store: opts.store,
  });

  if (minted.kind === 'in_progress') return { kind: 'in_progress' };
  if (minted.kind === 'error') return { kind: 'error', reason: minted.reason };

  if (minted.kind === 'minted') {
    // Consume the reveal we just wrote so a second GET cannot replay.
    if (minted.revealToken) await opts.store.consumeReveal(minted.revealToken);
    const checkout = await opts.store.getCheckout(session.id);
    if (checkout) {
      delete checkout.reveal_token;
      await opts.store.putCheckout(checkout);
    }
    return {
      kind: 'ok',
      api_key: minted.plaintext,
      prefix: minted.prefix,
      owner: minted.owner,
      shown_once: true,
    };
  }

  // already_minted — consume leftover reveal if webhook won the race.
  if (minted.revealToken) {
    const leftover = await opts.store.consumeReveal(minted.revealToken);
    const checkout = await opts.store.getCheckout(session.id);
    if (checkout) {
      delete checkout.reveal_token;
      await opts.store.putCheckout(checkout);
    }
    if (leftover) {
      return {
        kind: 'ok',
        api_key: leftover,
        prefix: minted.prefix ?? keyDisplayPrefix(leftover),
        owner: minted.owner,
        shown_once: true,
      };
    }
  }

  return {
    kind: 'already_delivered',
    prefix: minted.prefix,
    owner: minted.owner,
  };
}

export type WebhookHandleResult =
  | { kind: 'ignored'; reason: string }
  | { kind: 'minted'; session_id: string }
  | { kind: 'already_minted'; session_id: string }
  | { kind: 'in_progress'; session_id: string }
  | { kind: 'error'; reason: string }
  | { kind: 'unauthorized'; reason: string };

export function handleStripeWebhookEvent(opts: {
  rawBody: string;
  signatureHeader: string | undefined;
  webhookSecret: string;
  store: KeyStore;
  nowSec?: number;
}): Promise<WebhookHandleResult> {
  const sig = verifyStripeSignature({
    payload: opts.rawBody,
    header: opts.signatureHeader,
    secret: opts.webhookSecret,
    nowSec: opts.nowSec,
  });
  if (!sig.ok) return Promise.resolve({ kind: 'unauthorized', reason: sig.reason });

  let event: { type?: string; data?: { object?: StripeCheckoutSession } };
  try {
    event = JSON.parse(opts.rawBody) as typeof event;
  } catch {
    return Promise.resolve({ kind: 'error', reason: 'invalid_json' });
  }

  if (event.type !== 'checkout.session.completed') {
    return Promise.resolve({ kind: 'ignored', reason: 'unhandled_event' });
  }

  const session = event.data?.object;
  if (!session?.id) return Promise.resolve({ kind: 'error', reason: 'no_session' });
  if (!isDqlCheckoutSession(session)) {
    return Promise.resolve({ kind: 'ignored', reason: 'not_dql_checkout' });
  }

  const customerId = customerIdOf(session);
  const owner = session.metadata?.owner || (customerId ? selfServeOwner(customerId) : '');
  if (!customerId || !owner) return Promise.resolve({ kind: 'error', reason: 'no_customer' });

  return finalizeCheckoutMint({
    sessionId: session.id,
    customerId,
    owner,
    store: opts.store,
  }).then((minted) => {
    if (minted.kind === 'minted') return { kind: 'minted' as const, session_id: session.id };
    if (minted.kind === 'already_minted') {
      return { kind: 'already_minted' as const, session_id: session.id };
    }
    if (minted.kind === 'in_progress') return { kind: 'in_progress' as const, session_id: session.id };
    return { kind: 'error' as const, reason: minted.reason };
  });
}
