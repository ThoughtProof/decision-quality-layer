/**
 * Canonical digest of the billable verify payload.
 * Binds an idempotency key to mandate / proposed_action / reasoning / axes / sandbox.
 * Does not include secrets. Context is omitted (not part of the admission contract).
 */

import { sha256Hex } from './key-hash.js';

export function verifyPayloadDigest(req: {
  mandate: string;
  proposed_action: string;
  reasoning: string;
  axes: readonly string[];
  sandbox?: boolean;
}): string {
  return sha256Hex(
    JSON.stringify({
      mandate: req.mandate,
      proposed_action: req.proposed_action,
      reasoning: req.reasoning,
      axes: [...req.axes],
      sandbox: req.sandbox === true,
    }),
  );
}
