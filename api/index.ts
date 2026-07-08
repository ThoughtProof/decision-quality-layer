import type { VercelRequest, VercelResponse } from '@vercel/node';

export default function handler(_req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  return res.status(200).json({
    service: 'decision-quality-layer',
    description:
      '5-axis reasoning verification for AI agents (intent, scope, risk, consistency, reversibility).',
    endpoints: {
      verify: 'POST /dql/verify',
      axes: 'GET /dql/axes',
      health: 'GET /dql/health',
    },
    docs: 'https://github.com/ThoughtProof/decision-quality-layer',
  });
}
