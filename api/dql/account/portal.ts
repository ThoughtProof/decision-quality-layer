/**
 * POST /dql/account/portal — Stripe Customer Billing Portal session.
 *
 * Fail closed if the portal is not configured in the Stripe Dashboard.
 * Does not enable `DQL_CHECKOUT_ENABLED`.
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';

import { authorizeAccount, createBillingPortalSession } from '../../../src/auth/account.js';
import { loadCheckoutConfig } from '../../../src/auth/checkout.js';
import { createKeyStore } from '../../../src/auth/key-store.js';
import { PACKAGE_VERSION } from '../../../src/package-version.js';

const VERSION = PACKAGE_VERSION;

function cors(res: VercelResponse): void {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-DQL-Account');
  res.setHeader('X-DQL-Version', VERSION);
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed', code: 'METHOD_NOT_ALLOWED' });
  }

  const store = createKeyStore(process.env);
  if (!store) {
    return res.status(503).json({
      error: 'Account store unavailable',
      code: 'ACCOUNT_UNAVAILABLE',
    });
  }

  const auth = await authorizeAccount({ headers: req.headers, store });
  if (auth.kind !== 'ok') {
    return res.status(401).json({
      error: 'Valid account token required (X-DQL-Account or Authorization: Bearer dqla_…).',
      code: 'ACCOUNT_UNAUTHORIZED',
    });
  }

  const cfg = loadCheckoutConfig(process.env);
  const portal = await createBillingPortalSession({
    record: auth.record,
    secretKey: cfg.secretKey,
    returnUrl: cfg.portalReturnUrl,
    configuration: cfg.portalConfiguration || undefined,
  });

  if (portal.kind === 'ok') return res.status(200).json({ url: portal.url });
  return res.status(503).json({
    error: 'Stripe billing portal is not configured.',
    code: 'PORTAL_UNAVAILABLE',
  });
}
