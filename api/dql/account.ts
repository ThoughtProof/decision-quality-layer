/**
 * DQL account surface — single Serverless Function (Hobby 12-fn limit).
 *
 *   GET  /dql/account
 *   POST /dql/account/portal
 *   POST /dql/account/rotate
 *   POST /dql/account/revoke
 *   POST /dql/account/login     { email }           — magic-link request
 *   POST /dql/account/session   { login_token }     — exchange for dqla_…
 *
 * Auth (except login/session): `X-DQL-Account: dqla_…` or
 * `Authorization: Bearer dqla_…`. The verify key (`dqlk_…`) is not accepted.
 *
 * Path routing via vercel.json rewrites (`?action=…`) or residual URL path.
 * Does not enable `DQL_CHECKOUT_ENABLED`.
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';

import {
  authorizeAccount,
  consumeAccountLogin,
  createBillingPortalSession,
  getAccountSnapshot,
  requestAccountLogin,
  revokeAccountKey,
  rotateAccountKey,
} from '../../src/auth/account.js';
import { loadCheckoutConfig, publicAppUrl } from '../../src/auth/checkout.js';
import { createKeyStore } from '../../src/auth/key-store.js';
import { PACKAGE_VERSION } from '../../src/package-version.js';

const VERSION = PACKAGE_VERSION;

type AccountAction = 'root' | 'portal' | 'rotate' | 'revoke' | 'login' | 'session';

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

function bodyObject(req: VercelRequest): Record<string, unknown> {
  const b = req.body;
  if (b && typeof b === 'object' && !Array.isArray(b)) return b as Record<string, unknown>;
  if (typeof b === 'string') {
    try {
      const parsed = JSON.parse(b) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      /* ignore */
    }
  }
  return {};
}

/** Resolve action from rewrite query or residual path. */
export function resolveAccountAction(req: VercelRequest): AccountAction {
  const q = firstString(req.query?.action)?.trim().toLowerCase();
  if (
    q === 'portal' ||
    q === 'rotate' ||
    q === 'revoke' ||
    q === 'login' ||
    q === 'session'
  ) {
    return q;
  }

  const raw = typeof req.url === 'string' ? req.url : '';
  const pathOnly = raw.split('?')[0] ?? '';
  const m = /\/account\/(portal|rotate|revoke|login|session)\/?$/i.exec(pathOnly);
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

  // Public login endpoints — no X-DQL-Account required.
  if (action === 'login') {
    const body = bodyObject(req);
    const email = typeof body.email === 'string' ? body.email : '';
    const cfg = loadCheckoutConfig(process.env);
    const appBase =
      publicAppUrl(process.env) ||
      (cfg.publicApp ? cfg.publicApp : '') ||
      'https://app.thoughtproof.ai';
    const result = await requestAccountLogin({
      email,
      store,
      secretKey: cfg.secretKey || process.env.STRIPE_SECRET_KEY,
      resendApiKey: process.env.RESEND_API_KEY,
      fromEmail: process.env.DQL_LOGIN_FROM_EMAIL || process.env.RESEND_FROM,
      appBaseUrl: appBase,
    });
    if (result.kind === 'invalid_email') {
      return res.status(400).json({
        error: 'A valid email is required.',
        code: 'INVALID_REQUEST',
      });
    }
    if (result.kind === 'unconfigured') {
      return res.status(503).json({
        error: 'Account login email is not configured.',
        code: 'LOGIN_UNAVAILABLE',
      });
    }
    if (result.kind === 'error') {
      return res.status(502).json({
        error: 'Unable to send login email.',
        code: 'LOGIN_FAILED',
      });
    }
    // sent | accepted — same public response (no enumeration)
    return res.status(200).json({
      ok: true,
      message: 'If an account exists for that email, a sign-in link was sent. Check your inbox.',
    });
  }

  if (action === 'session') {
    const body = bodyObject(req);
    const loginToken =
      (typeof body.login_token === 'string' && body.login_token) ||
      (typeof body.token === 'string' && body.token) ||
      '';
    const consumed = await consumeAccountLogin({ loginToken, store });
    if (consumed.kind === 'invalid') {
      return res.status(401).json({
        error: 'This sign-in link is invalid or already used.',
        code: 'LOGIN_INVALID',
      });
    }
    if (consumed.kind !== 'ok') {
      return res.status(502).json({
        error: 'Unable to complete sign-in.',
        code: 'ACCOUNT_UNAVAILABLE',
      });
    }
    return res.status(200).json({
      account_token: consumed.account_token,
      shown_once: true,
      key_prefix: consumed.key_prefix,
      credits: consumed.credits,
      header: 'X-DQL-Account',
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
