/**
 * GET /dql/structural-metrics
 *
 * Process-local peek at ADR-0020 shadow agreement counters
 * (structural.would_block vs cascade scope FAIL).
 *
 * Honest limits:
 *   • Vercel serverless = per-instance memory. Counters reset on cold start.
 *   • Durable N-day rates come from the structured log event
 *     `dql.structural_shadow` (Vercel log drain), not this endpoint.
 *
 * This endpoint exists so canary/dogfood can spot-check live agreement
 * without waiting for a drain pipeline.
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getStructuralMetricsSnapshot } from '../../src/engine/structural-metrics.js';

const VERSION = '0.2.0';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('X-DQL-Version', VERSION);

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'GET') {
    return res.status(405).json({
      error: 'Method not allowed',
      code: 'METHOD_NOT_ALLOWED',
      allowed: ['GET'],
    });
  }

  const snapshot = getStructuralMetricsSnapshot();
  return res.status(200).json({
    service: 'decision-quality-layer',
    version: VERSION,
    ...snapshot,
    note:
      'process_local=true — counters are per serverless instance and reset on cold start. ' +
      'For N-day rates grep Vercel logs for event=dql.structural_shadow (ADR-0020 step 2).',
  });
}
