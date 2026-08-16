/**
 * Self-serve Stripe Checkout → billable `dqlk_…` mint + prepaid ledger.
 *
 * Default OFF (`DQL_CHECKOUT_ENABLED`). Merge does not turn on public billing.
 * Sandbox stays free/keyless. Minted keys are always `dev_access: false`.
 *
 * POST /dql/checkout { email, pack: trial|starter|plus|payg }
 *   starter / plus → mode=payment (one-time). Webhook mints or adds credits.
 *   payg           → card-on-file / metered subscription. Sets payg_opt_in.
 *   trial          → setup-mode card bind. 5 checks once per email ∪ fingerprint.
 *
 * Signed webhook `checkout.session.completed` (`metadata.dql_checkout=1`).
 * GET  /dql/checkout?session_id=cs_… → reveal plaintext key + account token ONCE.
 *
 * Plaintext key / `dqla_…` token are never logged. `no_freemium = true` —
 * trial is not a plan. Account token is not a verify key.
 */

import { randomBytes } from 'node:crypto';

import { DEFAULT_DAILY_CAP } from './keys.js';
import { truthy } from './env-flag.js';
import {
  fingerprintAccountToken,
  fingerprintCustomer,
  fingerprintKey,
  keyDisplayPrefix,
  sha256Hex,
} from './key-hash.js';
import {
  newStoredKeyRecord,
  selfServeOwner,
  type CheckoutMintState,
  type CreditGrant,
  type KeyStore,
  type StoredKeyRecord,
} from './key-store.js';
import {
  NO_FREEMIUM,
  PACKS,
  parseCheckoutPack,
  normalizeCheckoutEmail,
  type CheckoutPack,
} from './packs.js';
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

/** Opaque post-purchase session. Not a verify key. Store the hash only. */
export function generateAccountToken(): string {
  return `dqla_${randomBytes(32).toString('hex')}`;
}

export function generateRevealToken(): string {
  return randomBytes(24).toString('hex');
}

/** App origin for Stripe redirects. Unset → keep DQL reveal URL (fail-safe). */
export function publicAppUrl(env: NodeJS.ProcessEnv = process.env): string {
  return (env.DQL_PUBLIC_APP_URL ?? '').trim().replace(/\/$/, '');
}

export function checkoutRedirectUrls(env: NodeJS.ProcessEnv = process.env): {
  successUrl: string;
  cancelUrl: string;
  publicApp: string;
} {
  const publicBase = publicBaseUrl(env);
  const publicApp = publicAppUrl(env);
  const cancelOverride = (env.DQL_CHECKOUT_CANCEL_URL ?? '').trim();
  if (publicApp) {
    return {
      successUrl: `${publicApp}/keys?session_id={CHECKOUT_SESSION_ID}`,
      cancelUrl: cancelOverride || `${publicApp}/pricing?canceled=1`,
      publicApp,
    };
  }
  return {
    successUrl: `${publicBase}/dql/checkout?session_id={CHECKOUT_SESSION_ID}`,
    cancelUrl: cancelOverride || `${publicBase}/`,
    publicApp: '',
  };
}

export interface CheckoutConfig {
  enabled: boolean;
  secretKey: string;
  webhookSecret: string;
  /** Metered PAYG price (`DQL_STRIPE_PRICE_ID`). */
  priceId: string;
  priceStarter: string;
  pricePlus: string;
  publicBase: string;
  publicApp: string;
  successUrl: string;
  cancelUrl: string;
  portalReturnUrl: string;
  portalConfiguration: string;
}

export function loadCheckoutConfig(env: NodeJS.ProcessEnv = process.env): CheckoutConfig {
  const secretKey = (env.STRIPE_SECRET_KEY ?? '').trim();
  const webhookSecret = (env.STRIPE_WEBHOOK_SECRET ?? '').trim();
  const priceId = (env.DQL_STRIPE_PRICE_ID ?? '').trim();
  const priceStarter = (env.DQL_STRIPE_PRICE_STARTER ?? '').trim();
  const pricePlus = (env.DQL_STRIPE_PRICE_PLUS ?? '').trim();
  const publicBase = publicBaseUrl(env);
  const redirects = checkoutRedirectUrls(env);
  const portalReturn =
    (env.DQL_BILLING_PORTAL_RETURN_URL ?? '').trim() ||
    (redirects.publicApp ? `${redirects.publicApp}/keys` : `${publicBase}/`);
  return {
    enabled: isCheckoutEnabled(env) && secretKey.length > 0,
    secretKey,
    webhookSecret,
    priceId,
    priceStarter,
    pricePlus,
    publicBase,
    publicApp: redirects.publicApp,
    successUrl: redirects.successUrl,
    cancelUrl: redirects.cancelUrl,
    portalReturnUrl: portalReturn,
    portalConfiguration: (env.DQL_STRIPE_PORTAL_CONFIGURATION ?? '').trim(),
  };
}

export function packPriceId(pack: CheckoutPack, config: CheckoutConfig): string {
  if (pack === 'starter') return config.priceStarter;
  if (pack === 'plus') return config.pricePlus;
  if (pack === 'payg') return config.priceId;
  return '';
}

export type CreateCheckoutResult =
  | { kind: 'ok'; url: string; session_id: string; customer_id: string; pack: CheckoutPack }
  | { kind: 'disabled' }
  | { kind: 'unconfigured'; reason: string }
  | { kind: 'invalid'; reason: string }
  | { kind: 'error'; reason: string };

export interface StripeCustomer {
  id: string;
  email?: string;
}

export interface StripeCardRef {
  fingerprint?: string;
}

export interface StripePaymentMethodRef {
  id?: string;
  card?: StripeCardRef;
}

export interface StripeCheckoutSession {
  id: string;
  status?: string;
  payment_status?: string;
  customer?: string | { id?: string; email?: string } | null;
  metadata?: Record<string, string> | null;
  url?: string | null;
  mode?: string;
  setup_intent?: string | { id?: string; payment_method?: string | StripePaymentMethodRef } | null;
  payment_intent?: string | { id?: string; payment_method?: string | StripePaymentMethodRef } | null;
  customer_email?: string | null;
  customer_details?: { email?: string | null } | null;
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

function packOfSession(session: StripeCheckoutSession): CheckoutPack | undefined {
  return parseCheckoutPack(session.metadata?.pack);
}

function emailOfSession(session: StripeCheckoutSession): string {
  const fromMeta = session.metadata?.email;
  if (fromMeta) return normalizeCheckoutEmail(fromMeta);
  const details = session.customer_details?.email;
  if (details) return normalizeCheckoutEmail(details);
  if (session.customer_email) return normalizeCheckoutEmail(session.customer_email);
  const c = session.customer;
  if (c && typeof c === 'object' && typeof c.email === 'string') {
    return normalizeCheckoutEmail(c.email);
  }
  return '';
}

function paymentMethodId(ref: string | StripePaymentMethodRef | null | undefined): string | undefined {
  if (typeof ref === 'string' && ref.startsWith('pm_')) return ref;
  if (ref && typeof ref === 'object' && typeof ref.id === 'string' && ref.id.startsWith('pm_')) {
    return ref.id;
  }
  return undefined;
}

function fingerprintOfPm(ref: string | StripePaymentMethodRef | null | undefined): string | undefined {
  if (ref && typeof ref === 'object' && typeof ref.card?.fingerprint === 'string') {
    const fp = ref.card.fingerprint.trim();
    return fp || undefined;
  }
  return undefined;
}

export async function resolveCardFingerprint(opts: {
  session: StripeCheckoutSession;
  secretKey: string;
  fetchImpl?: typeof fetch;
}): Promise<string | undefined> {
  const fromExpanded =
    fingerprintOfPm(
      typeof opts.session.setup_intent === 'object' ? opts.session.setup_intent?.payment_method : undefined,
    ) ??
    fingerprintOfPm(
      typeof opts.session.payment_intent === 'object'
        ? opts.session.payment_intent?.payment_method
        : undefined,
    );
  if (fromExpanded) return fromExpanded;

  const setiId =
    typeof opts.session.setup_intent === 'string'
      ? opts.session.setup_intent
      : opts.session.setup_intent?.id;
  if (setiId) {
    const si = await stripeFormRequest<{
      payment_method?: string | StripePaymentMethodRef;
    }>({
      secretKey: opts.secretKey,
      method: 'GET',
      path: `/setup_intents/${encodeURIComponent(setiId)}`,
      params: { 'expand[0]': 'payment_method' },
      fetchImpl: opts.fetchImpl,
    });
    if (si.kind === 'ok') {
      const fp = fingerprintOfPm(si.body.payment_method);
      if (fp) return fp;
      const pmId = paymentMethodId(si.body.payment_method);
      if (pmId) {
        const pm = await stripeFormRequest<StripePaymentMethodRef>({
          secretKey: opts.secretKey,
          method: 'GET',
          path: `/payment_methods/${encodeURIComponent(pmId)}`,
          fetchImpl: opts.fetchImpl,
        });
        if (pm.kind === 'ok') return fingerprintOfPm(pm.body);
      }
    }
  }

  const piId =
    typeof opts.session.payment_intent === 'string'
      ? opts.session.payment_intent
      : opts.session.payment_intent?.id;
  if (piId) {
    const pi = await stripeFormRequest<{
      payment_method?: string | StripePaymentMethodRef;
    }>({
      secretKey: opts.secretKey,
      method: 'GET',
      path: `/payment_intents/${encodeURIComponent(piId)}`,
      params: { 'expand[0]': 'payment_method' },
      fetchImpl: opts.fetchImpl,
    });
    if (pi.kind === 'ok') {
      const fp = fingerprintOfPm(pi.body.payment_method);
      if (fp) return fp;
    }
  }

  return undefined;
}

export async function createCheckoutSession(opts: {
  email: string;
  pack: unknown;
  store: KeyStore;
  config: CheckoutConfig;
  fetchImpl?: typeof fetch;
}): Promise<CreateCheckoutResult> {
  if (!opts.config.enabled) return { kind: 'disabled' };
  if (!opts.config.secretKey) return { kind: 'unconfigured', reason: 'missing_stripe_secret' };

  const pack = parseCheckoutPack(opts.pack);
  if (!pack) return { kind: 'invalid', reason: 'invalid_pack' };

  const email = normalizeCheckoutEmail(opts.email);
  if (!EMAIL_RE.test(email)) return { kind: 'invalid', reason: 'invalid_email' };

  const def = PACKS[pack];
  const priceId = packPriceId(pack, opts.config);
  if ((pack === 'starter' || pack === 'plus') && !priceId) {
    return { kind: 'unconfigured', reason: 'missing_pack_price' };
  }

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

  const successUrl = opts.config.successUrl;
  let mode: 'payment' | 'setup' | 'subscription';
  if (pack === 'starter' || pack === 'plus') {
    mode = 'payment';
  } else if (pack === 'trial') {
    mode = 'setup';
  } else {
    mode = priceId ? 'subscription' : 'setup';
  }

  const params: Record<string, string> = {
    mode,
    customer: customerId,
    success_url: successUrl,
    cancel_url: opts.config.cancelUrl,
    client_reference_id: owner,
    'metadata[dql_checkout]': '1',
    'metadata[owner]': owner,
    'metadata[pack]': pack,
    'metadata[email]': email,
    'metadata[credits]': String(def.credits),
    'metadata[trial]': def.trial ? '1' : '0',
    'metadata[no_freemium]': NO_FREEMIUM ? '1' : '0',
    'payment_method_types[0]': 'card',
  };
  if (mode === 'payment' && priceId) {
    params['line_items[0][price]'] = priceId;
    params['line_items[0][quantity]'] = '1';
  } else if (mode === 'subscription' && priceId) {
    params['line_items[0][price]'] = priceId;
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
    pack,
  };
  await opts.store.putCheckout(pending);

  console.log(
    JSON.stringify({
      type: 'dql_checkout_session',
      session_id: session.body.id,
      owner,
      pack,
      customer_fingerprint: fingerprintCustomer(customerId),
      mode,
      ts: new Date().toISOString(),
    }),
  );

  return {
    kind: 'ok',
    url: session.body.url,
    session_id: session.body.id,
    customer_id: customerId,
    pack,
  };
}

export type MintResult =
  | {
      kind: 'minted';
      plaintext: string;
      accountToken: string;
      revealToken: string;
      prefix: string;
      owner: string;
      customerId: string;
      pack: CheckoutPack;
      credits_added: number;
      trial: boolean;
      payg_opt_in: boolean;
    }
  | {
      kind: 'already_minted';
      prefix?: string;
      owner: string;
      customerId: string;
      revealToken?: string;
      pack?: CheckoutPack;
    }
  | {
      kind: 'credits_added';
      prefix?: string;
      owner: string;
      customerId: string;
      pack: CheckoutPack;
      credits_added: number;
      balance: number;
      trial: boolean;
    }
  | {
      kind: 'payg_enabled';
      prefix?: string;
      owner: string;
      customerId: string;
    }
  | { kind: 'trial_used' }
  | { kind: 'trial_no_card' }
  | { kind: 'rejected'; reason: string }
  | { kind: 'in_progress' }
  | { kind: 'error'; reason: string };

function resultFromState(state: CheckoutMintState): MintResult | undefined {
  if (state.status === 'pending') return undefined;
  if (state.status === 'trial_used') return { kind: 'trial_used' };
  if (state.status === 'trial_no_card') return { kind: 'trial_no_card' };
  if (state.status === 'rejected') return { kind: 'rejected', reason: state.reason ?? 'rejected' };
  if (state.status === 'credits_added') {
    return {
      kind: 'credits_added',
      prefix: state.prefix,
      owner: state.owner,
      customerId: state.customer_id,
      pack: state.pack ?? 'starter',
      credits_added: state.credits_added ?? 0,
      balance: state.credits_added ?? 0,
      trial: state.trial === true,
    };
  }
  if (state.status === 'payg_enabled') {
    return {
      kind: 'payg_enabled',
      prefix: state.prefix,
      owner: state.owner,
      customerId: state.customer_id,
    };
  }
  if (state.key_hash) {
    return {
      kind: 'already_minted',
      prefix: state.prefix,
      owner: state.owner,
      customerId: state.customer_id,
      revealToken: state.reveal_token,
      pack: state.pack,
    };
  }
  return undefined;
}

async function applyToExistingKey(opts: {
  rec: StoredKeyRecord;
  pack: CheckoutPack;
  sessionId: string;
  customerId: string;
  owner: string;
  store: KeyStore;
  emailNormalized?: string;
}): Promise<MintResult> {
  const def = PACKS[opts.pack];
  if (def.payg_opt_in && !opts.rec.payg_opt_in) {
    opts.rec.payg_opt_in = true;
    await opts.store.putKey(opts.rec);
  }
  if (def.trial && !opts.rec.trial) {
    opts.rec.trial = true;
    await opts.store.putKey(opts.rec);
  }
  if (opts.emailNormalized && !opts.rec.email_normalized) {
    opts.rec.email_normalized = opts.emailNormalized;
    await opts.store.putKey(opts.rec);
  }
  if (opts.emailNormalized || opts.rec.email_normalized) {
    await opts.store.putEmailIndex(
      opts.emailNormalized || opts.rec.email_normalized || '',
      opts.rec.hash,
    );
  }

  if (def.credits > 0) {
    const grant: CreditGrant = {
      pack: opts.pack,
      credits: def.credits,
      trial: def.trial,
      session_id: opts.sessionId,
      at: new Date().toISOString(),
    };
    const balance = await opts.store.addCredits(opts.rec.hash, def.credits);
    await opts.store.recordCreditGrant(opts.rec.hash, grant);
    await opts.store.putCheckout({
      session_id: opts.sessionId,
      customer_id: opts.customerId,
      owner: opts.owner,
      status: 'credits_added',
      pack: opts.pack,
      key_hash: opts.rec.hash,
      prefix: opts.rec.prefix,
      credits_added: def.credits,
      trial: def.trial,
    });
    return {
      kind: 'credits_added',
      prefix: opts.rec.prefix,
      owner: opts.owner,
      customerId: opts.customerId,
      pack: opts.pack,
      credits_added: def.credits,
      balance,
      trial: def.trial,
    };
  }

  await opts.store.putCheckout({
    session_id: opts.sessionId,
    customer_id: opts.customerId,
    owner: opts.owner,
    status: 'payg_enabled',
    pack: opts.pack,
    key_hash: opts.rec.hash,
    prefix: opts.rec.prefix,
  });
  return {
    kind: 'payg_enabled',
    prefix: opts.rec.prefix,
    owner: opts.owner,
    customerId: opts.customerId,
  };
}

export async function finalizeCheckoutMint(opts: {
  sessionId: string;
  customerId: string;
  owner: string;
  store: KeyStore;
  pack: CheckoutPack;
  emailNormalized?: string;
  cardFingerprint?: string;
  paymentStatus?: string;
  dailyCap?: number;
}): Promise<MintResult> {
  const existing = await opts.store.getCheckout(opts.sessionId);
  const prior = existing ? resultFromState(existing) : undefined;
  if (prior) return prior;

  const locked = await opts.store.acquireMintLock(opts.sessionId);
  if (!locked) {
    const again = await opts.store.getCheckout(opts.sessionId);
    const fromAgain = again ? resultFromState(again) : undefined;
    if (fromAgain) return fromAgain;
    return { kind: 'in_progress' };
  }

  const again = await opts.store.getCheckout(opts.sessionId);
  const fromAgain = again ? resultFromState(again) : undefined;
  if (fromAgain) return fromAgain;

  const def = PACKS[opts.pack];
  if ((opts.pack === 'starter' || opts.pack === 'plus') && opts.paymentStatus && opts.paymentStatus !== 'paid') {
    await opts.store.putCheckout({
      session_id: opts.sessionId,
      customer_id: opts.customerId,
      owner: opts.owner,
      status: 'rejected',
      pack: opts.pack,
      reason: 'not_paid',
    });
    return { kind: 'rejected', reason: 'not_paid' };
  }

  if (def.trial) {
    const fp = (opts.cardFingerprint ?? '').trim();
    const email = (opts.emailNormalized ?? '').trim();
    if (!fp) {
      await opts.store.putCheckout({
        session_id: opts.sessionId,
        customer_id: opts.customerId,
        owner: opts.owner,
        status: 'trial_no_card',
        pack: 'trial',
        reason: 'missing_card_fingerprint',
      });
      return { kind: 'trial_no_card' };
    }
    if (!email) {
      await opts.store.putCheckout({
        session_id: opts.sessionId,
        customer_id: opts.customerId,
        owner: opts.owner,
        status: 'rejected',
        pack: 'trial',
        reason: 'missing_email',
      });
      return { kind: 'rejected', reason: 'missing_email' };
    }
    const claimed = await opts.store.claimTrial(email, fp);
    if (claimed === 'already_used') {
      await opts.store.putCheckout({
        session_id: opts.sessionId,
        customer_id: opts.customerId,
        owner: opts.owner,
        status: 'trial_used',
        pack: 'trial',
        reason: 'trial_already_used',
      });
      return { kind: 'trial_used' };
    }
  }

  const cusLocked = await opts.store.acquireMintLock(`cus:${opts.customerId}`);
  if (!cusLocked) {
    const hash = await opts.store.getKeyHashByCustomer(opts.customerId);
    if (hash) {
      const rec = await opts.store.getRecordByHash(hash);
      if (rec) {
        return applyToExistingKey({
          rec,
          pack: opts.pack,
          sessionId: opts.sessionId,
          customerId: opts.customerId,
          owner: opts.owner,
          store: opts.store,
          emailNormalized: opts.emailNormalized,
        });
      }
    }
    return { kind: 'in_progress' };
  }

  const existingHash = await opts.store.getKeyHashByCustomer(opts.customerId);
  if (existingHash) {
    const rec = await opts.store.getRecordByHash(existingHash);
    if (!rec) return { kind: 'error', reason: 'missing_key_record' };
    return applyToExistingKey({
      rec,
      pack: opts.pack,
      sessionId: opts.sessionId,
      customerId: opts.customerId,
      owner: opts.owner,
      store: opts.store,
      emailNormalized: opts.emailNormalized,
    });
  }

  const plaintext = generateApiKey();
  const accountToken = generateAccountToken();
  const record = newStoredKeyRecord({
    plaintextKey: plaintext,
    owner: opts.owner,
    stripeCustomerId: opts.customerId,
    dailyCap: opts.dailyCap ?? DEFAULT_DAILY_CAP,
    paygOptIn: def.payg_opt_in,
    trial: def.trial,
    emailNormalized: opts.emailNormalized,
    accountTokenHash: sha256Hex(accountToken),
  });
  const revealToken = generateRevealToken();

  await opts.store.putKey(record);
  await opts.store.putCustomerKey(opts.customerId, record.hash);
  await opts.store.putCustomerMap(opts.owner, opts.customerId);
  await opts.store.putAccountIndex(record.account_token_hash!, record.hash);
  if (opts.emailNormalized) {
    await opts.store.putEmailIndex(opts.emailNormalized, record.hash);
  }

  if (def.credits > 0) {
    await opts.store.addCredits(record.hash, def.credits);
    await opts.store.recordCreditGrant(record.hash, {
      pack: opts.pack,
      credits: def.credits,
      trial: def.trial,
      session_id: opts.sessionId,
      at: record.created,
    });
  }

  const revealPayload = { key: plaintext, account_token: accountToken };
  await opts.store.putReveal(revealToken, revealPayload, REVEAL_TTL_SEC);
  // Session-scoped copy survives double-fetch / remount within TTL.
  await opts.store.putSessionReveal(opts.sessionId, revealPayload, REVEAL_TTL_SEC);
  await opts.store.putCheckout({
    session_id: opts.sessionId,
    customer_id: opts.customerId,
    owner: opts.owner,
    status: 'minted',
    pack: opts.pack,
    key_hash: record.hash,
    prefix: record.prefix,
    reveal_token: revealToken,
    minted_at: record.created,
    credits_added: def.credits,
    trial: def.trial,
  });

  console.log(
    JSON.stringify({
      type: 'dql_key_mint',
      session_id: opts.sessionId,
      owner: opts.owner,
      pack: opts.pack,
      credits_added: def.credits,
      trial: def.trial,
      payg_opt_in: def.payg_opt_in,
      customer_fingerprint: fingerprintCustomer(opts.customerId),
      key_fingerprint: fingerprintKey(plaintext),
      account_fingerprint: fingerprintAccountToken(accountToken),
      prefix: record.prefix,
      ts: new Date().toISOString(),
    }),
  );

  return {
    kind: 'minted',
    plaintext,
    accountToken,
    revealToken,
    prefix: record.prefix,
    owner: opts.owner,
    customerId: opts.customerId,
    pack: opts.pack,
    credits_added: def.credits,
    trial: def.trial,
    payg_opt_in: def.payg_opt_in,
  };
}

export type RevealResult =
  | {
      kind: 'ok';
      api_key: string;
      account_token: string;
      prefix: string;
      key_prefix: string;
      owner: string;
      shown_once: true;
      pack?: CheckoutPack;
      credits: number;
      trial: boolean;
      payg_opt_in: boolean;
    }
  | {
      kind: 'ok_existing';
      owner: string;
      prefix?: string;
      pack: CheckoutPack;
      credits_added?: number;
      balance?: number;
      payg_opt_in?: boolean;
    }
  | { kind: 'pending' }
  | { kind: 'in_progress' }
  | {
      kind: 'already_delivered';
      prefix?: string;
      owner?: string;
      /** Fresh handle so the buyer can open /account and rotate if reveal was lost. */
      account_token?: string;
      credits?: number;
      pack?: CheckoutPack;
    }
  | { kind: 'trial_used' }
  | { kind: 'trial_no_card' }
  | { kind: 'invalid'; reason: string }
  | { kind: 'error'; reason: string };

async function fulfillFromSession(opts: {
  session: StripeCheckoutSession;
  store: KeyStore;
  config: CheckoutConfig;
  fetchImpl?: typeof fetch;
}): Promise<MintResult> {
  const session = opts.session;
  const customerId = customerIdOf(session);
  const owner = session.metadata?.owner || (customerId ? selfServeOwner(customerId) : '');
  if (!customerId || !owner) return { kind: 'error', reason: 'no_customer' };

  const pack = packOfSession(session);
  if (!pack) return { kind: 'error', reason: 'invalid_pack' };

  let fingerprint: string | undefined;
  if (pack === 'trial') {
    fingerprint = await resolveCardFingerprint({
      session,
      secretKey: opts.config.secretKey,
      fetchImpl: opts.fetchImpl,
    });
  }

  return finalizeCheckoutMint({
    sessionId: session.id,
    customerId,
    owner,
    store: opts.store,
    pack,
    emailNormalized: emailOfSession(session) || undefined,
    cardFingerprint: fingerprint,
    paymentStatus: session.payment_status,
  });
}

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
    params: {
      'expand[0]': 'setup_intent.payment_method',
      'expand[1]': 'payment_intent.payment_method',
    },
    fetchImpl: opts.fetchImpl,
  });
  if (retrieved.kind === 'error') {
    if (retrieved.status === 404) return { kind: 'invalid', reason: 'unknown_session' };
    return { kind: 'error', reason: retrieved.reason };
  }

  const session = retrieved.body;
  if (!isDqlCheckoutSession(session)) return { kind: 'invalid', reason: 'not_dql_checkout' };
  if (session.status !== 'complete') return { kind: 'pending' };

  const minted = await fulfillFromSession({
    session,
    store: opts.store,
    config: opts.config,
    fetchImpl: opts.fetchImpl,
  });

  if (minted.kind === 'in_progress') return { kind: 'in_progress' };
  if (minted.kind === 'error') return { kind: 'error', reason: minted.reason };
  if (minted.kind === 'trial_used') return { kind: 'trial_used' };
  if (minted.kind === 'trial_no_card') return { kind: 'trial_no_card' };
  if (minted.kind === 'rejected') return { kind: 'error', reason: minted.reason };
  if (minted.kind === 'credits_added') {
    return {
      kind: 'ok_existing',
      owner: minted.owner,
      prefix: minted.prefix,
      pack: minted.pack,
      credits_added: minted.credits_added,
      balance: minted.balance,
    };
  }
  if (minted.kind === 'payg_enabled') {
    return {
      kind: 'ok_existing',
      owner: minted.owner,
      prefix: minted.prefix,
      pack: 'payg',
      payg_opt_in: true,
    };
  }

  // Prefer session-scoped reveal (re-readable within TTL) over one-shot token.
  const sessionReveal = await opts.store.getSessionReveal(session.id);
  if (sessionReveal?.key && sessionReveal.account_token) {
    // Drop legacy one-shot token so expiry of session-reveal is authoritative.
    if (minted.kind === 'already_minted' && minted.revealToken) {
      await opts.store.consumeReveal(minted.revealToken);
      const checkout = await opts.store.getCheckout(session.id);
      if (checkout?.reveal_token) {
        delete checkout.reveal_token;
        await opts.store.putCheckout(checkout);
      }
    } else if (minted.kind === 'minted' && minted.revealToken) {
      await opts.store.consumeReveal(minted.revealToken);
      const checkout = await opts.store.getCheckout(session.id);
      if (checkout?.reveal_token) {
        delete checkout.reveal_token;
        await opts.store.putCheckout(checkout);
      }
    }
    const rec = await opts.store.getRecordByHash(sha256Hex(sessionReveal.key));
    const credits = rec ? await opts.store.creditBalance(rec.hash) : 0;
    return {
      kind: 'ok',
      api_key: sessionReveal.key,
      account_token: sessionReveal.account_token,
      prefix: rec?.prefix ?? keyDisplayPrefix(sessionReveal.key),
      key_prefix: rec?.prefix ?? keyDisplayPrefix(sessionReveal.key),
      owner: rec?.owner ?? (minted.kind === 'minted' || minted.kind === 'already_minted' ? minted.owner : ''),
      shown_once: true,
      pack:
        minted.kind === 'minted' || minted.kind === 'already_minted'
          ? minted.pack
          : rec?.trial
            ? 'trial'
            : undefined,
      credits,
      trial: rec?.trial === true,
      payg_opt_in: rec?.payg_opt_in === true,
    };
  }

  if (minted.kind === 'minted') {
    // Keep session reveal for remounts; drop one-shot token only.
    if (minted.revealToken) await opts.store.consumeReveal(minted.revealToken);
    await opts.store.putSessionReveal(
      session.id,
      { key: minted.plaintext, account_token: minted.accountToken },
      REVEAL_TTL_SEC,
    );
    const checkout = await opts.store.getCheckout(session.id);
    if (checkout) {
      delete checkout.reveal_token;
      await opts.store.putCheckout(checkout);
    }
    const credits = await opts.store.creditBalance(sha256Hex(minted.plaintext));
    return {
      kind: 'ok',
      api_key: minted.plaintext,
      account_token: minted.accountToken,
      prefix: minted.prefix,
      key_prefix: minted.prefix,
      owner: minted.owner,
      shown_once: true,
      pack: minted.pack,
      credits,
      trial: minted.trial,
      payg_opt_in: minted.payg_opt_in,
    };
  }

  // already_minted — lift leftover one-shot token into session reveal (re-readable).
  if (minted.kind === 'already_minted' && minted.revealToken) {
    const leftover = await opts.store.consumeReveal(minted.revealToken);
    const checkout = await opts.store.getCheckout(session.id);
    if (checkout) {
      delete checkout.reveal_token;
      await opts.store.putCheckout(checkout);
    }
    if (leftover?.key && leftover.account_token) {
      await opts.store.putSessionReveal(session.id, leftover, REVEAL_TTL_SEC);
      const rec = await opts.store.getRecordByHash(sha256Hex(leftover.key));
      const credits = rec ? await opts.store.creditBalance(rec.hash) : 0;
      return {
        kind: 'ok',
        api_key: leftover.key,
        account_token: leftover.account_token,
        prefix: minted.prefix ?? keyDisplayPrefix(leftover.key),
        key_prefix: minted.prefix ?? keyDisplayPrefix(leftover.key),
        owner: minted.owner,
        shown_once: true,
        pack: minted.pack,
        credits,
        trial: rec?.trial === true,
        payg_opt_in: rec?.payg_opt_in === true,
      };
    }
  }

  // Reveal already consumed (double-fetch / lost tab). Re-issue account handle
  // so the buyer can open /account and rotate — never leave them with nothing.
  if (minted.kind === 'already_minted') {
    const checkout = await opts.store.getCheckout(session.id);
    const keyHash = checkout?.key_hash;
    const rec = keyHash ? await opts.store.getRecordByHash(keyHash) : null;
    if (rec && rec.revoked !== true) {
      const accountToken = generateAccountToken();
      const accountHash = sha256Hex(accountToken);
      const next: typeof rec = { ...rec, account_token_hash: accountHash };
      await opts.store.putKey(next);
      await opts.store.putAccountIndex(accountHash, next.hash);
      if (next.email_normalized) {
        await opts.store.putEmailIndex(next.email_normalized, next.hash);
      }
      const credits = await opts.store.creditBalance(next.hash);
      return {
        kind: 'already_delivered',
        prefix: next.prefix,
        owner: next.owner,
        account_token: accountToken,
        credits,
        pack: minted.pack ?? checkout?.pack,
      };
    }
    return {
      kind: 'already_delivered',
      prefix: minted.prefix,
      owner: minted.owner,
      pack: minted.pack,
    };
  }

  return {
    kind: 'already_delivered',
    prefix: undefined,
    owner: undefined,
  };
}

export type WebhookHandleResult =
  | { kind: 'ignored'; reason: string }
  | { kind: 'minted'; session_id: string }
  | { kind: 'already_minted'; session_id: string }
  | { kind: 'credits_added'; session_id: string }
  | { kind: 'payg_enabled'; session_id: string }
  | { kind: 'trial_used'; session_id: string }
  | { kind: 'trial_no_card'; session_id: string }
  | { kind: 'in_progress'; session_id: string }
  | { kind: 'error'; reason: string }
  | { kind: 'unauthorized'; reason: string };

export function handleStripeWebhookEvent(opts: {
  rawBody: string;
  signatureHeader: string | undefined;
  webhookSecret: string;
  store: KeyStore;
  secretKey?: string;
  fetchImpl?: typeof fetch;
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
  if (!packOfSession(session)) {
    return Promise.resolve({ kind: 'ignored', reason: 'invalid_pack' });
  }

  const config: CheckoutConfig = {
    enabled: true,
    secretKey: opts.secretKey ?? '',
    webhookSecret: opts.webhookSecret,
    priceId: '',
    priceStarter: '',
    pricePlus: '',
    publicBase: '',
    publicApp: '',
    successUrl: '',
    cancelUrl: '',
    portalReturnUrl: '',
    portalConfiguration: '',
  };

  return fulfillFromSession({
    session,
    store: opts.store,
    config,
    fetchImpl: opts.fetchImpl,
  }).then((minted) => {
    if (minted.kind === 'minted') return { kind: 'minted' as const, session_id: session.id };
    if (minted.kind === 'already_minted') {
      return { kind: 'already_minted' as const, session_id: session.id };
    }
    if (minted.kind === 'credits_added') {
      return { kind: 'credits_added' as const, session_id: session.id };
    }
    if (minted.kind === 'payg_enabled') {
      return { kind: 'payg_enabled' as const, session_id: session.id };
    }
    if (minted.kind === 'trial_used') return { kind: 'trial_used' as const, session_id: session.id };
    if (minted.kind === 'trial_no_card') {
      return { kind: 'trial_no_card' as const, session_id: session.id };
    }
    if (minted.kind === 'in_progress') return { kind: 'in_progress' as const, session_id: session.id };
    if (minted.kind === 'rejected') return { kind: 'error' as const, reason: minted.reason };
    return { kind: 'error' as const, reason: minted.reason };
  });
}
