/**
 * Canonical digest of every request field that can change the verify verdict.
 * Same Idempotency-Key + different digest → 409, no replay, no second debit.
 * Does not include secrets.
 */

import canonicalize from 'canonicalize';

import { sha256Hex } from './key-hash.js';

export function verifyPayloadDigest(req: {
  mandate: string;
  proposed_action: string;
  reasoning: string;
  axes: readonly string[];
  sandbox?: boolean;
  context?: string;
  structured_context?: unknown;
  gate_mode?: 'shadow' | 'enforce';
}): string {
  const structured =
    req.structured_context === undefined
      ? ''
      : (canonicalize(req.structured_context) ?? JSON.stringify(req.structured_context));
  return sha256Hex(
    JSON.stringify({
      mandate: req.mandate,
      proposed_action: req.proposed_action,
      reasoning: req.reasoning,
      axes: [...req.axes],
      sandbox: req.sandbox === true,
      context: req.context ?? '',
      structured_context: structured,
      gate_mode: req.gate_mode ?? 'shadow',
    }),
  );
}
