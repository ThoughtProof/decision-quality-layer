/**
 * Prepaid checkout packs — source of truth for slugs and credit amounts.
 *
 * Stripe Price ids come from env (never hardcoded). Metadata may echo
 * credits; this module is the only amount authority.
 *
 * `no_freemium = true`. The 5-check trial is card+email gated, once per
 * email ∪ card fingerprint, then hard-stop. It is not a plan.
 */

export const NO_FREEMIUM = true as const;

export const CHECKOUT_PACKS = ['trial', 'starter', 'plus', 'payg'] as const;
export type CheckoutPack = (typeof CHECKOUT_PACKS)[number];

export const TRIAL_CREDITS = 5;
export const STARTER_CREDITS = 200;
export const PLUS_CREDITS = 1000;
export const STARTER_PRICE_USD = 8;
export const PLUS_PRICE_USD = 35;
export const PAYG_USD_PER_VERIFY = 0.05;

export const PRICE_ENV = {
  starter: 'DQL_STRIPE_PRICE_STARTER',
  plus: 'DQL_STRIPE_PRICE_PLUS',
  payg: 'DQL_STRIPE_PRICE_ID',
} as const;

export type PackMode = 'payment' | 'setup' | 'subscription';

export interface PackDefinition {
  slug: CheckoutPack;
  /** Prepaid credits granted on paid/fulfillment. 0 for PAYG. */
  credits: number;
  /** Consumer list price (documentation / echo). Not billed from this number. */
  list_price_usd: number;
  trial: boolean;
  payg_opt_in: boolean;
  /** Stripe Checkout mode. PAYG uses subscription when a metered price is set. */
  mode: PackMode;
  price_env?: (typeof PRICE_ENV)[keyof typeof PRICE_ENV];
}

export const PACKS: Record<CheckoutPack, PackDefinition> = {
  trial: {
    slug: 'trial',
    credits: TRIAL_CREDITS,
    list_price_usd: 0,
    trial: true,
    payg_opt_in: false,
    mode: 'setup',
  },
  starter: {
    slug: 'starter',
    credits: STARTER_CREDITS,
    list_price_usd: STARTER_PRICE_USD,
    trial: false,
    payg_opt_in: false,
    mode: 'payment',
    price_env: PRICE_ENV.starter,
  },
  plus: {
    slug: 'plus',
    credits: PLUS_CREDITS,
    list_price_usd: PLUS_PRICE_USD,
    trial: false,
    payg_opt_in: false,
    mode: 'payment',
    price_env: PRICE_ENV.plus,
  },
  payg: {
    slug: 'payg',
    credits: 0,
    list_price_usd: PAYG_USD_PER_VERIFY,
    trial: false,
    payg_opt_in: true,
    mode: 'subscription',
    price_env: PRICE_ENV.payg,
  },
};

export function isCheckoutPack(value: unknown): value is CheckoutPack {
  return typeof value === 'string' && (CHECKOUT_PACKS as readonly string[]).includes(value);
}

export function parseCheckoutPack(value: unknown): CheckoutPack | undefined {
  if (typeof value !== 'string') return undefined;
  const slug = value.trim().toLowerCase();
  return isCheckoutPack(slug) ? slug : undefined;
}

export function normalizeCheckoutEmail(email: string): string {
  return email.trim().toLowerCase();
}
