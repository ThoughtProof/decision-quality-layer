/**
 * GET|POST /dql/internal/sweep-reservations
 *
 * Production crash recovery for expired account-path verify holds.
 * Vercel Cron hits this route; it refunds stale `held` reservations
 * (credit + daily-cap) without requiring the client to retry that id.
 * Does not refund `meter_pending` or `committed`.
 *
 * Auth: `Authorization: Bearer` matching `DQL_CRON_SECRET` or `CRON_SECRET`.
 * Fail closed when no secret is configured.
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createKeyStore } from '../../../src/auth/key-store.js';

const SWEEP_LIMIT_NOTE =
  'Expired held reservations were refunded. meter_pending and committed records are left intact.';

function cronSecret(env: NodeJS.ProcessEnv = process.env): string {
  return (env.DQL_CRON_SECRET ?? env.CRON_SECRET ?? '').trim();
}

function bearerToken(headers: VercelRequest['headers']): string | null {
  const raw = headers.authorization ?? headers.Authorization;
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== 'string') return null;
  const m = /^Bearer\s+(\S+)\s*$/i.exec(value.trim());
  return m?.[1] ?? null;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed', code: 'METHOD_NOT_ALLOWED' });
  }

  const expected = cronSecret();
  const presented = bearerToken(req.headers);
  if (!expected || !presented || presented !== expected) {
    return res.status(401).json({ error: 'Unauthorized', code: 'CRON_UNAUTHORIZED' });
  }

  const store = createKeyStore(process.env);
  if (!store) {
    return res.status(503).json({
      error: 'Reservation store unavailable',
      code: 'RESERVE_STORE_UNAVAILABLE',
    });
  }

  const refunded = await store.recoverExpiredHeldReservations();
  return res.status(200).json({
    ok: true,
    refunded,
    note: SWEEP_LIMIT_NOTE,
  });
}
