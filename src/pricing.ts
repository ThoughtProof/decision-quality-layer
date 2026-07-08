/**
 * DQL Pricing — single source of truth.
 *
 * Pay-as-you-go, no freemium. Standard tier only (nano → swift cascade —
 * see src/types.ts for why checkpoint/nano-solo is not exposed).
 *
 * Payment paths:
 *   - Stripe (metered, $0.05/call, for API-key holders — the fiat path)
 *   - x402 (pay-per-call at settlement, for crypto-native agents)
 *
 * Developer access is granted manually via API keys flagged with
 * `dev_access: true` (no charge). Sandbox mode (`sandbox: true` in the
 * request) is free for anyone and returns a deterministic mock — used for
 * integration testing without incurring cost.
 */

export const PRICE_USD_PER_CALL = 0.05;

/**
 * Sandbox calls do not incur charges.
 */
export const SANDBOX_PRICE_USD = 0;

/**
 * Dev-access API keys do not incur charges. Granted manually.
 */
export const DEV_ACCESS_PRICE_USD = 0;

export interface PricingContext {
  sandbox: boolean;
  dev_access: boolean;
}

/**
 * Resolve the effective price for a call based on request + key context.
 */
export function priceForCall(ctx: PricingContext): number {
  if (ctx.sandbox) return SANDBOX_PRICE_USD;
  if (ctx.dev_access) return DEV_ACCESS_PRICE_USD;
  return PRICE_USD_PER_CALL;
}
