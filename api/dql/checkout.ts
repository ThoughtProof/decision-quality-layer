/**
 * POST /dql/checkout  — start Stripe Checkout (flag-gated, default OFF)
 * GET  /dql/checkout?session_id=cs_… — reveal minted key once
 *
 * Merge ≠ public billing. Production stays closed until
 * `DQL_CHECKOUT_ENABLED=true` plus Stripe + Upstash secrets.
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';

import {
  createCheckoutSession,
  loadCheckoutConfig,
  revealCheckoutKey,
} from '../../src/auth/checkout.js';
import { createKeyStore } from '../../src/auth/key-store.js';
import { PACKAGE_VERSION } from '../../src/package-version.js';

const VERSION = PACKAGE_VERSION;

function cors(res: VercelResponse): void {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('X-DQL-Version', VERSION);
}

function firstQuery(v: string | string[] | undefined): string {
  if (Array.isArray(v)) return v[0] ?? '';
  return v ?? '';
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const cfg = loadCheckoutConfig(process.env);
  const store = createKeyStore(process.env);

  if (req.method === 'GET') {
    const sessionId = firstQuery(req.query.session_id as string | string[] | undefined).trim();
    if (!sessionId) {
      return res.status(400).json({
        error: 'Missing session_id',
        code: 'INVALID_REQUEST',
      });
    }
    if (!store) {
      return res.status(503).json({
        error: 'Key store unavailable',
        code: 'CHECKOUT_UNAVAILABLE',
      });
    }
    if (!cfg.secretKey) {
      return res.status(503).json({
        error: 'Checkout is not configured',
        code: 'CHECKOUT_UNAVAILABLE',
      });
    }

    const revealed = await revealCheckoutKey({
      sessionId,
      store,
      config: cfg,
    });

    if (revealed.kind === 'ok') {
      const payload = {
        api_key: revealed.api_key,
        prefix: revealed.prefix,
        owner: revealed.owner,
        shown_once: true as const,
        header: 'X-DQL-Key',
        price_usd_per_call: 0.05,
      };
      const accept = String(req.headers.accept ?? '');
      if (accept.includes('text/html')) {
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.status(200);
        res.end(renderRevealHtml(payload.api_key, payload.prefix));
        return;
      }
      return res.status(200).json(payload);
    }
    if (revealed.kind === 'pending' || revealed.kind === 'in_progress') {
      return res.status(202).json({
        status: 'pending',
        code: 'CHECKOUT_PENDING',
        error: 'Checkout is not complete yet. Retry shortly.',
      });
    }
    if (revealed.kind === 'already_delivered') {
      return res.status(409).json({
        error: 'API key already delivered. It is shown only once.',
        code: 'KEY_ALREADY_DELIVERED',
        prefix: revealed.prefix,
        owner: revealed.owner,
        access: 'dev-access keys: raul@thoughtproof.ai',
      });
    }
    if (revealed.kind === 'invalid') {
      return res.status(400).json({
        error: 'Invalid checkout session',
        code: 'INVALID_REQUEST',
      });
    }
    return res.status(502).json({
      error: 'Checkout reveal failed',
      code: 'CHECKOUT_UNAVAILABLE',
    });
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed', code: 'METHOD_NOT_ALLOWED' });
  }

  if (!cfg.enabled) {
    return res.status(503).json({
      error: 'Public checkout is not enabled.',
      code: 'CHECKOUT_DISABLED',
    });
  }
  if (!store) {
    return res.status(503).json({
      error: 'Key store unavailable (Upstash required to persist minted keys).',
      code: 'CHECKOUT_UNAVAILABLE',
    });
  }

  const email =
    typeof req.body === 'object' && req.body && typeof (req.body as { email?: unknown }).email === 'string'
      ? (req.body as { email: string }).email
      : '';

  const created = await createCheckoutSession({ email, store, config: cfg });
  if (created.kind === 'disabled') {
    return res.status(503).json({
      error: 'Public checkout is not enabled.',
      code: 'CHECKOUT_DISABLED',
    });
  }
  if (created.kind === 'invalid') {
    return res.status(400).json({
      error: 'A valid email is required.',
      code: 'INVALID_REQUEST',
    });
  }
  if (created.kind === 'unconfigured' || created.kind === 'error') {
    return res.status(502).json({
      error: 'Unable to start checkout.',
      code: 'CHECKOUT_UNAVAILABLE',
    });
  }

  return res.status(200).json({
    url: created.url,
    session_id: created.session_id,
  });
}

function renderRevealHtml(apiKey: string, prefix: string): string {
  const escaped = apiKey.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>DQL API key</title>
<meta name="robots" content="noindex, nofollow">
<style>
  body { font-family: ui-sans-serif, system-ui, sans-serif; max-width: 40rem; margin: 3rem auto; padding: 0 1rem; }
  code { display: block; word-break: break-all; background: #111; color: #eee; padding: 1rem; border-radius: 8px; }
  p { color: #333; }
</style></head><body>
<h1>Your DQL API key</h1>
<p>Shown once. Copy it now. Header: <code style="display:inline;padding:.2rem .4rem">X-DQL-Key</code> or <code style="display:inline;padding:.2rem .4rem">Authorization: Bearer</code>.</p>
<p>Prefix ${prefix.replace(/</g, '')} · $0.05 / call · no freemium</p>
<code>${escaped}</code>
</body></html>`;
}
