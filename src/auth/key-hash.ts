/**
 * API-key hashing — shared by usage counters, persisted key records, and logs.
 *
 * Never store or log the plaintext key after the create/reveal moment.
 * sha256 is the only identifier used in Redis (`dql:key:<hex>`, `dql:usage:<hex24>:…`).
 */

import { createHash } from 'node:crypto';

/** Full sha256 hex of an API key (or any secret). */
export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** Redis usage-counter id — first 24 hex chars of sha256(apiKey). */
export function usageRedisKeyId(apiKey: string): string {
  return sha256Hex(apiKey).slice(0, 24);
}

/**
 * Log-safe key id: sha256 prefix + last 4 chars (card-mask convention).
 * Not reversible to the secret.
 */
export function fingerprintKey(key: string): string {
  return `${sha256Hex(key).slice(0, 12)}…${key.slice(-4)}`;
}

/** Display prefix stored on the record (never enough to reconstruct the key). */
export function keyDisplayPrefix(key: string): string {
  const last4 = key.slice(-4);
  return `dqlk_…${last4}`;
}

export function fingerprintCustomer(cus: string): string {
  return sha256Hex(cus).slice(0, 12);
}
