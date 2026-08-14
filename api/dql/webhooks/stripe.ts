/**
 * POST /dql/webhooks/stripe
 *
 * Stripe webhook receiver. Signature required (`STRIPE_WEBHOOK_SECRET`).
 * Raw body only — JSON bodyParser is disabled so HMAC matches.
 *
 * Handles `checkout.session.completed` for sessions tagged
 * `metadata.dql_checkout=1`. Other events (including shared-account
 * Sentinel traffic) are acknowledged and ignored.
 *
 * Never returns or logs the minted plaintext key.
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';

import { handleStripeWebhookEvent, loadCheckoutConfig } from '../../../src/auth/checkout.js';
import { createKeyStore } from '../../../src/auth/key-store.js';
import { readRawBody } from '../../../src/auth/stripe-http.js';

export const config = {
  api: {
    bodyParser: false,
  },
};

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed', code: 'METHOD_NOT_ALLOWED' });
  }

  const cfg = loadCheckoutConfig(process.env);
  if (!cfg.webhookSecret) {
    return res.status(503).json({
      error: 'Webhook secret is not configured',
      code: 'WEBHOOK_UNAVAILABLE',
    });
  }

  const store = createKeyStore(process.env);
  if (!store) {
    return res.status(503).json({
      error: 'Key store unavailable',
      code: 'WEBHOOK_UNAVAILABLE',
    });
  }

  let rawBody: string;
  try {
    rawBody = await readRawBody(req);
  } catch {
    return res.status(400).json({
      error: 'Raw body required for signature verification',
      code: 'INVALID_REQUEST',
    });
  }

  const header = req.headers['stripe-signature'];
  const signatureHeader = Array.isArray(header) ? header[0] : header;

  const result = await handleStripeWebhookEvent({
    rawBody,
    signatureHeader,
    webhookSecret: cfg.webhookSecret,
    store,
  });

  if (result.kind === 'unauthorized') {
    return res.status(400).json({
      error: 'Invalid Stripe signature',
      code: 'INVALID_SIGNATURE',
    });
  }
  if (result.kind === 'error') {
    return res.status(400).json({
      error: 'Webhook rejected',
      code: 'INVALID_REQUEST',
    });
  }

  // 200 even for ignored / already-minted / in-progress so Stripe does not retry
  // forever. in_progress is rare (lock race); a later success GET will finish.
  return res.status(200).json({ received: true, result: result.kind });
}
