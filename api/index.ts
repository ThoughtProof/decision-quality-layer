import type { VercelRequest, VercelResponse } from '@vercel/node';

export default function handler(_req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  return res.status(200).json({
    service: 'decision-quality-layer',
    version: '0.2.0',
    description:
      '5-axis reasoning verification for AI agents (intent, scope, risk, consistency, reversibility).',
    endpoints: {
      verify: 'POST /dql/verify',
      axes: 'GET /dql/axes',
      health: 'GET /dql/health',
      structural_metrics: 'GET /dql/structural-metrics',
      openapi: 'GET /openapi.json',
    },
    docs: 'https://github.com/ThoughtProof/decision-quality-layer',
    contact: 'support@thoughtproof.ai',
  });
}
