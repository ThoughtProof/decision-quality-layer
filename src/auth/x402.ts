/**
 * DQL x402 payment rail (Base mainnet only) — ported lightly from Sentinel.
 *
 * PAYMENT.md Rail B. Default OFF via DQL_X402_ENABLED.
 * Wallet: same as Sentinel (0xAB9f…82E83) unless PAYMENT_WALLET override.
 *
 * Correct payment semantics (PR #36 HOLD fix):
 *   1. Request validate
 *   2. Payment VERIFY only (no settle)
 *   3. DQL execute
 *   4. Payment SETTLE only on DQL success
 *   5. Deliver result
 *
 * No silent public-facilitator fallback without CDP credentials.
 * Hard timeouts on facilitator network calls; client errors are sanitized.
 *
 * No GOAT/XRPL in v1 DQL port — Base USDC only. Expand later if needed.
 */

import { createHash } from 'node:crypto';

import type { VercelRequest, VercelResponse } from '@vercel/node';

import { PRICE_USD_PER_CALL } from '../pricing.js';
import { generateCdpJwt, hasCdpCredentials } from './cdp-jwt.js';

const DEFAULT_WALLET = '0xAB9f84864662f980614bD1453dB9950Ef2b82E83';
const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const CDP_FACILITATOR_URL = 'https://api.cdp.coinbase.com/platform/v2/x402';
const RESOURCE_URL = 'https://dql.thoughtproof.ai/dql/verify';

/** Hard timeout for facilitator verify/settle network calls. */
export const X402_FACILITATOR_TIMEOUT_MS = 8_000;

function truthy(v: string | undefined): boolean {
  return ['true', '1', 'on', 'yes'].includes((v ?? '').trim().toLowerCase());
}

export function isX402Enabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return truthy(env.DQL_X402_ENABLED);
}

export function paymentWallet(env: NodeJS.ProcessEnv = process.env): string {
  return (env.PAYMENT_WALLET ?? DEFAULT_WALLET).trim() || DEFAULT_WALLET;
}

function amountMicro(priceUsd: number = PRICE_USD_PER_CALL): string {
  return String(Math.round(priceUsd * 1_000_000));
}

/**
 * Resolve facilitator URL. Fail-closed when x402 is enabled without:
 *   - CDP credentials (preferred Coinbase path), OR
 *   - an explicit X402_FACILITATOR_URL override.
 * Never silently falls back to https://x402.org/facilitator.
 */
export function resolveFacilitatorUrl(
  env: NodeJS.ProcessEnv,
): { ok: true; url: string; mode: 'cdp' | 'explicit' } | { ok: false; reason: string } {
  const explicit = env.X402_FACILITATOR_URL?.trim();
  if (explicit) {
    return { ok: true, url: explicit.replace(/\/$/, ''), mode: 'explicit' };
  }
  if (hasCdpCredentials(env)) {
    return { ok: true, url: CDP_FACILITATOR_URL, mode: 'cdp' };
  }
  return {
    ok: false,
    reason:
      'x402 enabled but no CDP credentials (X402_CDP_KEY_ID/SECRET) and no X402_FACILITATOR_URL',
  };
}

function facilitatorRequest(
  path: '/verify' | '/settle',
  env: NodeJS.ProcessEnv,
  baseUrl: string,
  mode: 'cdp' | 'explicit',
): { url: string; headers: Record<string, string> } {
  const url = `${baseUrl}${path}`;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  // Sign only when talking to CDP (credentials present). Explicit non-CDP
  // facilitators must not receive CDP JWTs.
  if (mode === 'cdp' && hasCdpCredentials(env)) {
    const { host, pathname } = new URL(url);
    headers.Authorization = `Bearer ${generateCdpJwt(
      env.X402_CDP_KEY_ID!,
      env.X402_CDP_KEY_SECRET!,
      'POST',
      host,
      pathname,
    )}`;
  }
  return { url, headers };
}

function toV2PaymentPayload(
  payload: Record<string, unknown>,
  paymentRequirements: Record<string, unknown>,
): Record<string, unknown> {
  return {
    x402Version: 2,
    accepted: paymentRequirements,
    payload: payload.payload ?? {},
    resource: {
      url: RESOURCE_URL,
      description: 'ThoughtProof DQL decision-quality verification',
      mimeType: 'application/json',
    },
  };
}

function toV2Requirements(req: Record<string, unknown>): Record<string, unknown> {
  return {
    scheme: req.scheme,
    network: 'eip155:8453',
    asset: req.asset,
    amount: req.amount,
    payTo: req.payTo,
    maxTimeoutSeconds: req.maxTimeoutSeconds,
    extra: req.extra,
  };
}

/** Sanitize facilitator/network errors for client responses (no secrets/URLs). */
export function sanitizePaymentClientError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  if (/aborted|timeout|TimeoutError|AbortError/i.test(raw)) {
    return 'Payment facilitator timed out';
  }
  if (/fetch failed|ECONN|ENOTFOUND|network/i.test(raw)) {
    return 'Payment facilitator unreachable';
  }
  // Never leak stack/host/secret material.
  return 'Payment facilitator error';
}

/** Sanitize server-side log reasons — no raw secrets/hosts/stacks. */
export function sanitizeServerLogReason(err: unknown): string {
  const raw = err instanceof Error ? `${err.name}:${err.message}` : String(err);
  if (/aborted|timeout|TimeoutError|AbortError/i.test(raw)) return 'timeout';
  if (/fetch failed|ECONN|ENOTFOUND|network|EAI_AGAIN|socket hang up/i.test(raw)) {
    return 'network';
  }
  // Keep only a coarse class token; never the full message.
  return 'error';
}

/**
 * Non-sensitive payment identifier for reconcile logs.
 * Prefer payload nonce/authorization hash fields; never log signatures.
 */
/**
 * Non-sensitive payment reconcile id: SHA-256 fingerprint over non-secret
 * authorization fields only. Never returns raw nonce, wallet, or signature.
 */
export function paymentReconcileId(payload: Record<string, unknown>): string {
  const nested =
    payload.payload && typeof payload.payload === 'object'
      ? (payload.payload as Record<string, unknown>)
      : {};
  const auth =
    nested.authorization && typeof nested.authorization === 'object'
      ? (nested.authorization as Record<string, unknown>)
      : {};
  const accepted =
    payload.accepted && typeof payload.accepted === 'object'
      ? (payload.accepted as Record<string, unknown>)
      : {};

  // Include only non-sensitive authorization material. Explicitly exclude
  // signature, private material, and full wallet dumps as standalone ids.
  const material = {
    scheme: payload.scheme ?? accepted.scheme ?? null,
    network: payload.network ?? accepted.network ?? null,
    amount: accepted.amount ?? accepted.maxAmountRequired ?? null,
    asset: accepted.asset ?? null,
    payTo: accepted.payTo ?? null,
    // Hashed-in fields from authorization (values hashed as part of whole blob;
    // never emitted raw). Prefer structured auth fields when present.
    auth_from: typeof auth.from === 'string' ? auth.from : null,
    auth_to: typeof auth.to === 'string' ? auth.to : null,
    auth_value: typeof auth.value === 'string' ? auth.value : null,
    auth_validAfter: typeof auth.validAfter === 'string' ? auth.validAfter : null,
    auth_validBefore: typeof auth.validBefore === 'string' ? auth.validBefore : null,
    auth_nonce: typeof auth.nonce === 'string' ? auth.nonce : null,
    nested_nonce: typeof nested.nonce === 'string' ? nested.nonce : null,
  };

  const digest = createHash('sha256')
    .update(JSON.stringify(material), 'utf8')
    .digest('hex')
    .slice(0, 24);
  return `pay_${digest}`;
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number = X402_FACILITATOR_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

type FacilitatorVerifyOutcome =
  | { outcome: 'valid' }
  | { outcome: 'invalid'; invalidReason?: string }
  | { outcome: 'http_error'; status: number }
  | { outcome: 'unavailable'; reason: string };

async function facilitatorVerify(
  payload: unknown,
  paymentRequirements: unknown,
  env: NodeJS.ProcessEnv,
  baseUrl: string,
  mode: 'cdp' | 'explicit',
): Promise<FacilitatorVerifyOutcome> {
  const cdp = mode === 'cdp' && hasCdpCredentials(env);
  const req = paymentRequirements as Record<string, unknown>;
  const body = cdp
    ? {
        x402Version: 2,
        paymentPayload: toV2PaymentPayload(payload as Record<string, unknown>, toV2Requirements(req)),
        paymentRequirements: toV2Requirements(req),
      }
    : { x402Version: 1, paymentPayload: payload, paymentRequirements };
  const { url, headers } = facilitatorRequest('/verify', env, baseUrl, mode);
  const resp = await fetchWithTimeout(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    // Never log facilitator response bodies (may contain sensitive payment details).
    await resp.text().catch(() => '');
    console.warn(
      JSON.stringify({
        type: 'dql_x402_verify_http_error',
        status: resp.status,
        ts: new Date().toISOString(),
      }),
    );
    // 5xx / transport-class HTTP failures are infrastructure, not invalid payment.
    return { outcome: 'http_error', status: resp.status };
  }
  const raw = (await resp.json()) as { isValid?: boolean; invalidReason?: string };
  if (raw.isValid === true) return { outcome: 'valid' };
  return { outcome: 'invalid', invalidReason: raw.invalidReason };
}

type FacilitatorSettleOutcome =
  | { outcome: 'success'; success: true; txHash?: string; network?: string }
  | { outcome: 'failed'; success: false; error?: string }
  | { outcome: 'unknown'; success: false; error?: string; status?: number };

async function facilitatorSettle(
  payload: unknown,
  paymentRequirements: unknown,
  env: NodeJS.ProcessEnv,
  baseUrl: string,
  mode: 'cdp' | 'explicit',
): Promise<FacilitatorSettleOutcome> {
  const cdp = mode === 'cdp' && hasCdpCredentials(env);
  const req = paymentRequirements as Record<string, unknown>;
  const body = cdp
    ? {
        x402Version: 2,
        paymentPayload: toV2PaymentPayload(payload as Record<string, unknown>, toV2Requirements(req)),
        paymentRequirements: toV2Requirements(req),
      }
    : { x402Version: 1, paymentPayload: payload, paymentRequirements };
  const { url, headers } = facilitatorRequest('/settle', env, baseUrl, mode);
  const resp = await fetchWithTimeout(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    // Never log facilitator response bodies.
    await resp.text().catch(() => '');
    console.warn(
      JSON.stringify({
        type: 'dql_x402_settle_http_error',
        status: resp.status,
        ts: new Date().toISOString(),
      }),
    );
    // After the settle request is sent, a 5xx/ambiguous HTTP error does NOT
    // prove the facilitator rejected before accept — chain may have settled.
    // Only definitive JSON success:false is "failed". HTTP errors → unknown.
    return {
      outcome: 'unknown',
      success: false,
      error: `Facilitator settle HTTP ${resp.status}`,
      status: resp.status,
    };
  }
  const raw = (await resp.json()) as Record<string, unknown>;
  if (raw.success === true) {
    return {
      outcome: 'success',
      success: true,
      txHash: (raw.transaction ?? raw.txHash) as string | undefined,
      network: raw.network as string | undefined,
    };
  }
  // Authoritative facilitator rejection after accepted request.
  return {
    outcome: 'failed',
    success: false,
    error: typeof (raw.error ?? raw.errorReason ?? raw.errorMessage) === 'string'
      ? String(raw.error ?? raw.errorReason ?? raw.errorMessage)
      : 'settlement_rejected',
  };
}

export function buildX402Challenge(env: NodeJS.ProcessEnv = process.env): {
  body: Record<string, unknown>;
  paymentRequiredHeader: string;
} {
  const micro = amountMicro();
  const wallet = paymentWallet(env);
  const accepts = [
    {
      scheme: 'exact',
      network: 'eip155:8453',
      amount: micro,
      maxAmountRequired: micro,
      asset: USDC_BASE,
      payTo: wallet,
      resource: RESOURCE_URL,
      maxTimeoutSeconds: 300,
      extra: { name: 'USD Coin', version: '2' },
    },
    {
      scheme: 'exact',
      network: 'base',
      amount: micro,
      maxAmountRequired: micro,
      asset: USDC_BASE,
      payTo: wallet,
      resource: RESOURCE_URL,
      maxTimeoutSeconds: 300,
      extra: { name: 'USD Coin', version: '2' },
    },
  ];
  const challenge = {
    x402Version: 2,
    error: 'Payment required',
    resource: {
      url: RESOURCE_URL,
      description: 'DQL 5-axis mandate verification — $0.05/call USDC on Base',
      mimeType: 'application/json',
    },
    accepts,
  };
  return {
    body: {
      error: 'This endpoint requires a valid API key (X-DQL-Key), x402 payment, or sandbox: true.',
      code: 'PAYMENT_REQUIRED',
      price_usd_per_call: PRICE_USD_PER_CALL,
      protocol: 'x402',
      access: 'dev-access keys: raul@thoughtproof.ai · stripe: contact for metered key',
      x402: challenge,
    },
    paymentRequiredHeader: Buffer.from(JSON.stringify(challenge)).toString('base64'),
  };
}

export type X402PaymentContext = {
  payload: Record<string, unknown>;
  paymentRequirements: Record<string, unknown>;
  clientNetwork: string;
  facilitatorUrl: string;
  facilitatorMode: 'cdp' | 'explicit';
};

export type X402VerifyResult =
  | { kind: 'disabled' }
  | { kind: 'challenge' }
  | { kind: 'verified'; ctx: X402PaymentContext }
  | { kind: 'reject'; status: number; body: Record<string, unknown> };

export type X402SettleResult =
  | { kind: 'settled'; txHash?: string; network?: string }
  | { kind: 'reject'; status: number; body: Record<string, unknown> };

function parsePaymentSignature(
  paymentSig: string,
):
  | { ok: true; payload: Record<string, unknown> }
  | { ok: false; result: X402VerifyResult } {
  try {
    const payload = JSON.parse(
      Buffer.from(paymentSig, 'base64').toString('utf8'),
    ) as Record<string, unknown>;
    return { ok: true, payload };
  } catch {
    return {
      ok: false,
      result: {
        kind: 'reject',
        status: 402,
        body: {
          error: 'Invalid PAYMENT-SIGNATURE header: not valid base64 JSON',
          code: 'PAYMENT_REQUIRED',
        },
      },
    };
  }
}

function buildPaymentRequirements(
  payload: Record<string, unknown>,
  env: NodeJS.ProcessEnv,
):
  | { ok: true; paymentRequirements: Record<string, unknown>; clientNetwork: string }
  | { ok: false; result: X402VerifyResult } {
  const payloadNetwork = String(payload.network ?? '');
  const acceptedNet =
    payload.accepted && typeof payload.accepted === 'object'
      ? String((payload.accepted as Record<string, unknown>).network ?? '')
      : '';
  const effectiveNetwork = payloadNetwork || acceptedNet;
  if (
    effectiveNetwork &&
    effectiveNetwork !== 'base' &&
    effectiveNetwork !== 'eip155:8453'
  ) {
    return {
      ok: false,
      result: {
        kind: 'reject',
        status: 402,
        body: {
          error: 'Unsupported x402 network for DQL (Base mainnet only in v1)',
          code: 'PAYMENT_REQUIRED',
          network: effectiveNetwork,
        },
      },
    };
  }

  const clientNetwork = effectiveNetwork === 'base' ? 'base' : 'eip155:8453';
  const micro = amountMicro();
  return {
    ok: true,
    clientNetwork,
    paymentRequirements: {
      scheme: 'exact',
      network: clientNetwork,
      amount: micro,
      maxAmountRequired: micro,
      asset: USDC_BASE,
      payTo: paymentWallet(env),
      resource: RESOURCE_URL,
      maxTimeoutSeconds: 300,
      extra: { name: 'USD Coin', version: '2' },
    },
  };
}

/**
 * VERIFY-only path. Does NOT settle.
 * Caller must run body validation + DQL, then call settleX402Payment on success.
 */
export async function verifyX402Payment(
  req: VercelRequest,
  env: NodeJS.ProcessEnv = process.env,
): Promise<X402VerifyResult> {
  if (!isX402Enabled(env)) return { kind: 'disabled' };

  // Readiness BEFORE challenge: never advertise a payment path that cannot settle.
  const fac = resolveFacilitatorUrl(env);
  if (!fac.ok) {
    console.error(
      JSON.stringify({
        type: 'dql_x402_misconfigured',
        reason: 'facilitator_not_ready',
        ts: new Date().toISOString(),
      }),
    );
    return {
      kind: 'reject',
      status: 503,
      body: {
        error: 'Payment rail unavailable',
        code: 'PAYMENT_UNAVAILABLE',
      },
    };
  }

  const paymentSig = req.headers['payment-signature'] as string | undefined;
  if (!paymentSig) return { kind: 'challenge' };

  const parsed = parsePaymentSignature(paymentSig);
  if (!parsed.ok) return parsed.result;

  const reqs = buildPaymentRequirements(parsed.payload, env);
  if (!reqs.ok) return reqs.result;

  let verification: FacilitatorVerifyOutcome;
  try {
    verification = await facilitatorVerify(
      parsed.payload,
      reqs.paymentRequirements,
      env,
      fac.url,
      fac.mode,
    );
  } catch (err) {
    console.warn(
      JSON.stringify({
        type: 'dql_x402_verify_error',
        reason: sanitizeServerLogReason(err),
        payment_id: paymentReconcileId(parsed.payload),
        ts: new Date().toISOString(),
      }),
    );
    return {
      kind: 'reject',
      status: 502,
      body: {
        error: sanitizePaymentClientError(err),
        code: 'PAYMENT_UNAVAILABLE',
      },
    };
  }

  if (verification.outcome === 'http_error' || verification.outcome === 'unavailable') {
    // Verify 5xx / infrastructure failure — not an invalid payment signature.
    return {
      kind: 'reject',
      status: 502,
      body: {
        error: 'Payment verification unavailable',
        code: 'PAYMENT_UNAVAILABLE',
      },
    };
  }

  if (verification.outcome === 'invalid') {
    return {
      kind: 'reject',
      status: 402,
      body: {
        error: 'Payment verification failed',
        code: 'PAYMENT_REQUIRED',
        reason: verification.invalidReason
          ? 'Payment signature rejected by facilitator'
          : undefined,
      },
    };
  }

  return {
    kind: 'verified',
    ctx: {
      payload: parsed.payload,
      paymentRequirements: reqs.paymentRequirements,
      clientNetwork: reqs.clientNetwork,
      facilitatorUrl: fac.url,
      facilitatorMode: fac.mode,
    },
  };
}

/**
 * SETTLE-only path. Call only after DQL completed successfully.
 * Customers must never be charged for 400/500 responses.
 */
export async function settleX402Payment(
  ctx: X402PaymentContext,
  env: NodeJS.ProcessEnv = process.env,
): Promise<X402SettleResult> {
  const paymentId = paymentReconcileId(ctx.payload);
  let settlement: FacilitatorSettleOutcome;
  try {
    settlement = await facilitatorSettle(
      ctx.payload,
      ctx.paymentRequirements,
      env,
      ctx.facilitatorUrl,
      ctx.facilitatorMode,
    );
  } catch (err) {
    // Timeout / connection drop AFTER request may mean chain already settled.
    // Never claim "not charged" when outcome is technically unknown.
    const unknown = /aborted|timeout|TimeoutError|AbortError|fetch failed|ECONN|network|socket hang up/i.test(
      err instanceof Error ? err.message : String(err),
    );
    console.warn(
      JSON.stringify({
        type: 'dql_x402_settle_error',
        reason: sanitizeServerLogReason(err),
        payment_id: paymentId,
        outcome: unknown ? 'unknown' : 'error',
        ts: new Date().toISOString(),
      }),
    );
    if (unknown) {
      return {
        kind: 'reject',
        status: 502,
        body: {
          error: 'Payment settlement status unknown',
          code: 'PAYMENT_STATUS_UNKNOWN',
          details:
            'Do not retry the payment blindly. Reconcile using the payment identifier.',
          payment_id: paymentId,
        },
      };
    }
    return {
      kind: 'reject',
      status: 502,
      body: {
        error: sanitizePaymentClientError(err),
        code: 'PAYMENT_UNAVAILABLE',
        details: 'Settlement request could not be completed; reconcile if unsure.',
        payment_id: paymentId,
      },
    };
  }

  if (settlement.outcome === 'success') {
    return {
      kind: 'settled',
      txHash: settlement.txHash,
      network: settlement.network ?? ctx.clientNetwork,
    };
  }

  if (settlement.outcome === 'unknown') {
    // Settle HTTP 5xx / ambiguous after request sent — status unknown.
    // Do not claim "not charged" or "not accepted".
    console.warn(
      JSON.stringify({
        type: 'dql_x402_settle_unknown_outcome',
        payment_id: paymentId,
        status: settlement.status,
        ts: new Date().toISOString(),
      }),
    );
    return {
      kind: 'reject',
      status: 502,
      body: {
        error: 'Payment settlement status unknown',
        code: 'PAYMENT_STATUS_UNKNOWN',
        details:
          'Do not retry the payment blindly. Reconcile using the payment identifier.',
        payment_id: paymentId,
      },
    };
  }

  // Authoritative success:false from facilitator.
  console.warn(
    JSON.stringify({
      type: 'dql_x402_settle_failed',
      payment_id: paymentId,
      ts: new Date().toISOString(),
    }),
  );
  return {
    kind: 'reject',
    status: 402,
    body: {
      error: 'Payment settlement failed',
      code: 'PAYMENT_FAILED',
      details: 'Facilitator rejected settlement; not charged.',
      payment_id: paymentId,
    },
  };
}

/**
 * @deprecated Prefer verifyX402Payment + settleX402Payment.
 * Kept as a thin wrapper for tests that only exercise parse/challenge paths.
 * Does NOT settle — returns verified context or reject/challenge.
 */
export async function processX402Payment(
  req: VercelRequest,
  env: NodeJS.ProcessEnv = process.env,
): Promise<X402VerifyResult> {
  // Backward-compat name: VERIFY ONLY. Settlement is intentionally not here.
  // No 'paid' outcome — that only exists after settleX402Payment.
  return verifyX402Payment(req, env);
}

/** Apply challenge headers onto a 402 response. */
export function applyX402ChallengeHeaders(
  res: VercelResponse,
  env: NodeJS.ProcessEnv = process.env,
): Record<string, unknown> {
  const { body, paymentRequiredHeader } = buildX402Challenge(env);
  res.setHeader('payment-required', paymentRequiredHeader);
  return body;
}
