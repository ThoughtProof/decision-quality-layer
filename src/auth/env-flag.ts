/** Shared env-flag parser (same tokens as Stripe meter / x402). */
export function truthy(v: string | undefined): boolean {
  return ['true', '1', 'on', 'yes'].includes((v ?? '').trim().toLowerCase());
}
