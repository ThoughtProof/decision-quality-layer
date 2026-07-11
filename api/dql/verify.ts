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
 *   SERV_API_KEY    — for both serv-nano and serv-swift models
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
import {
  createProductionRuntime,
  type ProductionRuntime,
} from '../../src/engine/production-runtime.js';
import {
  parseRuntimeMode,
  ProductionConfigError,
} from '../../src/engine/production-config.js';

const VERSION = '0.2.0';
const MAX_BODY_SIZE = 1_000_000; // 1 MB

// v0.4.3.1 hardening: production runtime bundle is constructed at cold-start.
// If resolveProductionConfig (or parseRuntimeMode itself) throws, we cache
// the error as kind='error' and surface 503 CONFIG_INVALID to EVERY POST
// request — including sandbox. Sandbox bypasses provider I/O and billing,
// NOT the deployment-health invariant (Hermes Blocker 1).
type RuntimeInit =
  | { kind: 'stub'; cascade: Cascade }
  | { kind: 'production'; production: ProductionRuntime; cascade: Cascade }
  | { kind: 'error'; reason: ProductionConfigError };

function pickRuntime(): RuntimeInit {
  let mode;
  try {
    mode = parseRuntimeMode(process.env.DQL_CASCADE);
  } catch (e) {
    if (e instanceof ProductionConfigError) return { kind: 'error', reason: e };
    throw e;
  }
  if (mode === 'pot-cli') {
    try {
      const production = createProductionRuntime(process.env);
      return { kind: 'production', production, cascade: production.cascade };
    } catch (e) {
      if (e instanceof ProductionConfigError) {
        return { kind: 'error', reason: e };
      }
      throw e;
    }
  }
  return { kind: 'stub', cascade: new StubCascade() };
}
const RUNTIME = pickRuntime();
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

    // v0.4.3.1 hardening (Hermes Blocker 1): if the cold-start resolver
    // failed for a Live-configured deploy, EVERY POST returns 503, including
    // sandbox=true. A mis-configured DQL_CASCADE=pot-cli process must not be
    // able to answer 200 via the sandbox path — that would let a broken
    // deploy appear healthy to callers who probe with sandbox first.
    if (RUNTIME.kind === 'error') {
      return res.status(503).json({
        error: 'Runtime not initialised',
        code: 'CONFIG_INVALID',
        reasons: RUNTIME.reason.reasons,
      });
    }

    const response = await runVerification({
      request: validation.request,
      cascade: RUNTIME.cascade,
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
