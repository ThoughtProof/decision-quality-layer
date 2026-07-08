/**
 * POST /dql/verify
 *
 * 5-axis reasoning verification for AI agents.
 *
 * Request body:  DqlRequest  (see src/types.ts)
 * Response:      DqlResponse (200) | DqlError (4xx/5xx)
 *
 * Phase 0.2 (this file): production cascade (PotCliCascade, nano→swift) is
 * wired behind the DQL_CASCADE env-switch. Default remains the StubCascade
 * so local dev + CI stay hermetic. Sandbox mode still returns deterministic
 * mock verdicts. Payment gates land in Phase 2.
 *
 * Cascade selection:
 *   DQL_CASCADE=stub      → StubCascade (default; all axes UNCERTAIN)
 *   DQL_CASCADE=pot-cli   → PotCliCascade (serv-nano → serv-swift, live LLM)
 *   sandbox: true         → SandboxCascade (regardless of DQL_CASCADE)
 *
 * PotCliCascade requires:
 *   OPENAI_API_KEY  — serv-nano (gpt-4o-mini)
 *   GROQ_API_KEY    — serv-swift (llama-3.1-70b-versatile)
 * See docs/ENV.md for the full list.
 *
 * Pricing (see src/pricing.ts):
 *   - Pay-as-you-go, $0.05/call
 *   - No freemium
 *   - Sandbox calls (`sandbox: true` in body) are free
 *   - Dev-access API keys are granted manually and are also free
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { validateVerifyRequest } from '../../src/validation.js';
import { runVerification } from '../../src/engine/index.js';
import { StubCascade } from '../../src/engine/cascade.js';
import type { Cascade } from '../../src/engine/cascade.js';
import { SandboxCascade } from '../../src/engine/sandbox-cascade.js';
import { PotCliCascade } from '../../src/engine/cascade-pot.js';

const VERSION = '0.2.0';
const MAX_BODY_SIZE = 1_000_000; // 1 MB

// Cascades constructed once per cold-start.
function pickCascade(): Cascade {
  const mode = (process.env.DQL_CASCADE ?? 'stub').toLowerCase();
  if (mode === 'pot-cli' || mode === 'potcli' || mode === 'live') {
    return new PotCliCascade();
  }
  return new StubCascade();
}
const cascade = pickCascade();
const sandboxCascade = new SandboxCascade();

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const requestId = `dql_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

  try {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-DQL-Key');
    res.setHeader('X-DQL-Version', VERSION);
    res.setHeader('X-Request-Id', requestId);

    if (req.method === 'OPTIONS') {
      return res.status(200).end();
    }

    if (req.method !== 'POST') {
      return res.status(405).json({
        error: 'Method not allowed',
        code: 'METHOD_NOT_ALLOWED',
        allowed: ['POST'],
      });
    }

    const contentType = req.headers['content-type'];
    if (contentType && !contentType.includes('application/json')) {
      return res.status(415).json({
        error: 'Content-Type must be application/json',
        code: 'UNSUPPORTED_MEDIA_TYPE',
      });
    }

    if (req.body && JSON.stringify(req.body).length > MAX_BODY_SIZE) {
      return res.status(413).json({
        error: 'Request too large',
        code: 'PAYLOAD_TOO_LARGE',
        max_bytes: MAX_BODY_SIZE,
      });
    }

    const validation = validateVerifyRequest(req.body);
    if (!validation.valid) {
      return res.status(400).json({
        error: 'Validation failed',
        code: 'INVALID_REQUEST',
        details: validation.errors,
      });
    }

    // TODO(phase-1): payment / dev-access gate goes here.
    //   - X-DQL-Key present + valid + dev_access → skip charge
    //   - X-DQL-Key present + valid + billable  → record Stripe meter event
    //   - PAYMENT-SIGNATURE present              → x402 verify + settle
    //   - Sandbox request                        → skip charge (free)
    //   - Otherwise                              → 402 Payment Required with both options

    const response = await runVerification({
      request: validation.request,
      cascade,
      sandboxCascade,
      requestId,
      version: VERSION,
    });

    return res.status(200).json(response);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return res.status(500).json({
      error: 'Internal server error',
      code: 'INTERNAL_ERROR',
      details: message,
    });
  }
}
