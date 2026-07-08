/**
 * POST /dql/verify
 *
 * 5-axis reasoning verification for AI agents.
 *
 * Request body:  DqlRequest  (see src/types.ts)
 * Response:      DqlResponse (200) | DqlError (4xx/5xx)
 *
 * Phase 0 (this file): stub cascade returns UNCERTAIN for every axis. The
 * scaffolding — request validation, engine orchestration, aggregation, error
 * shape, headers — is production-ready. Wire in the real cascade in a
 * follow-up commit.
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { validateVerifyRequest } from '../../src/validation.js';
import { runVerification } from '../../src/engine/index.js';
import { StubCascade } from '../../src/engine/cascade.js';

const VERSION = '0.1.0';
const MAX_BODY_SIZE = 1_000_000; // 1 MB

// A single cascade instance per cold-start.
const cascade = new StubCascade();

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

    const response = await runVerification({
      request: validation.request,
      tier: validation.request.tier,
      cascade,
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
