/**
 * GET /dql/account — balance / usage for a post-purchase session.
 *
 * Auth: `X-DQL-Account: dqla_…` or `Authorization: Bearer dqla_…`.
 * The verify key (`dqlk_…`) is not accepted. No full key is returned.
 *
 * Does not enable `DQL_CHECKOUT_ENABLED`. Merge ≠ self-serve product.
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';

import { authorizeAccount, getAccountSnapshot } from '../../src/auth/account.js';
import { createKeyStore } from '../../src/auth/key-store.js';
import { PACKAGE_VERSION } from '../../src/package-version.js';

const VERSION = PACKAGE_VERSION;

function cors(res: VercelResponse): void {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-DQL-Account');
  res.setHeader('X-DQL-Version', VERSION);
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') {
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

  const snap = await getAccountSnapshot({ record: auth.record, store });
  return res.status(200).json(snap);
}
