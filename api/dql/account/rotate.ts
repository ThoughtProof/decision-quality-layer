/**
 * POST /dql/account/rotate — issue a new `dqlk_…` once; old hash revoked.
 * Credits, PAYG, customer, and account token are preserved.
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';

import { authorizeAccount, rotateAccountKey } from '../../../src/auth/account.js';
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
