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
      checkout: 'POST /dql/checkout (flag DQL_CHECKOUT_ENABLED, default off)',
      checkout_reveal: 'GET /dql/checkout?session_id=cs_…',
      account: 'GET /dql/account (X-DQL-Account / Bearer dqla_…)',
      account_portal: 'POST /dql/account/portal',
      account_rotate: 'POST /dql/account/rotate',
      account_revoke: 'POST /dql/account/revoke',
      stripe_webhook: 'POST /dql/webhooks/stripe',
      openapi: 'GET /openapi.json',
    },
    docs: 'https://github.com/ThoughtProof/decision-quality-layer',
    contact: 'support@thoughtproof.ai',
  });
}
