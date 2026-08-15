/**
 * DQL account surface — single Serverless Function (Hobby 12-fn limit).
 *
 *   GET  /dql/account
 *   POST /dql/account/portal
 *   POST /dql/account/rotate
 *   POST /dql/account/revoke
 *
 * Auth: `X-DQL-Account: dqla_…` or `Authorization: Bearer dqla_…`.
 * The verify key (`dqlk_…`) is not accepted.
 *
 * Path routing via vercel.json rewrites (`?action=portal|rotate|revoke`)
 * or residual URL path. Does not enable `DQL_CHECKOUT_ENABLED`.
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';

import {
  authorizeAccount,
  createBillingPortalSession,
  getAccountSnapshot,
  revokeAccountKey,
  rotateAccountKey,
} from '../../src/auth/account.js';
import { loadCheckoutConfig } from '../../src/auth/checkout.js';
import { createKeyStore } from '../../src/auth/key-store.js';
import { PACKAGE_VERSION } from '../../src/package-version.js';

const VERSION = PACKAGE_VERSION;

type AccountAction = 'root' | 'portal' | 'rotate' | 'revoke';

function cors(res: VercelResponse, methods: string): void {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', methods);
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-DQL-Account');
  res.setHeader('X-DQL-Version', VERSION);
}

function firstString(v: unknown): string | null {
  if (typeof v === 'string') return v;
  if (Array.isArray(v) && typeof v[0] === 'string') return v[0];
  return null;
}

/** Resolve action from rewrite query or residual path. */
export function resolveAccountAction(req: VercelRequest): AccountAction {
  const q = firstString(req.query?.action)?.trim().toLowerCase();
  if (q === 'portal' || q === 'rotate' || q === 'revoke') return q;

  const raw = typeof req.url === 'string' ? req.url : '';
  const pathOnly = raw.split('?')[0] ?? '';
  // Matches /dql/account/portal, /api/dql/account/portal, trailing slash ok.
  const m = /\/account\/(portal|rotate|revoke)\/?$/i.exec(pathOnly);
  if (m?.[1]) return m[1].toLowerCase() as AccountAction;
  return 'root';
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const action = resolveAccountAction(req);
  const allowMethods = action === 'root' ? 'GET, OPTIONS' : 'POST, OPTIONS';
  cors(res, allowMethods);

  if (req.method === 'OPTIONS') return res.status(200).end();

  if (action === 'root') {
    if (req.method !== 'GET') {
      return res.status(405).json({ error: 'Method not allowed', code: 'METHOD_NOT_ALLOWED' });
    }
  } else if (req.method !== 'POST') {
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

  if (action === 'root') {
    const snap = await getAccountSnapshot({ record: auth.record, store });
    return res.status(200).json(snap);
  }

  if (action === 'portal') {
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

  if (action === 'rotate') {
    const rotated = await rotateAccountKey({
      record: auth.record,
      store,
      token: auth.token,
    });
    if (rotated.kind === 'in_progress') {
      return res.status(409).json({
        error: 'Key rotation already in progress. Retry shortly.',
        code: 'ROTATE_IN_PROGRESS',
      });
    }
    if (rotated.kind !== 'ok') {
      return res.status(502).json({
        error: 'Unable to rotate key.',
        code: 'ACCOUNT_UNAVAILABLE',
      });
    }
    return res.status(200).json({
      api_key: rotated.api_key,
      key_prefix: rotated.key_prefix,
      shown_once: true,
      header: 'X-DQL-Key',
    });
  }

  // revoke
  const revoked = await revokeAccountKey({ record: auth.record, store });
  if (revoked.kind !== 'ok') {
    return res.status(502).json({
      error: 'Unable to revoke key.',
      code: 'ACCOUNT_UNAVAILABLE',
    });
  }
  return res.status(200).json({
    revoked: true,
    key_prefix: revoked.key_prefix,
  });
}
