/**
 * GET /dql/health
 *
 * Liveness endpoint. Returns 200 with build info.
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';

const VERSION = '0.1.0';

export default function handler(_req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('X-DQL-Version', VERSION);
  return res.status(200).json({
    status: 'ok',
    service: 'decision-quality-layer',
    version: VERSION,
    timestamp: new Date().toISOString(),
  });
}
