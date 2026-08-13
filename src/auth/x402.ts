/**
 * DQL x402 payment rail (Base mainnet only) — ported lightly from Sentinel.
 *
 * PAYMENT.md Rail B. Default OFF via DQL_X402_ENABLED.
 * Wallet: same as Sentinel (0xAB9f…82E83) unless PAYMENT_WALLET override.
 *
 * Flow:
 *   - API key present → caller handles key path (this module not used)
 *   - PAYMENT-SIGNATURE → verify+settle via CDP/x402 facilitator
 *   - else → 402 challenge payload (caller sends)
 *
 * No GOAT/XRPL in v1 DQL port — Base USDC only. Expand later if needed.
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';

import { PRICE_USD_PER_CALL } from '../pricing.js';
import { generateCdpJwt, hasCdpCredentials } from './cdp-jwt.js';

const DEFAULT_WALLET = '0xAB9f84864662f980614bD1453dB9950Ef2b82E83';
const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const CDP_FACILITATOR_URL = 'https://api.cdp.coinbase.com/platform/v2/x402';
const RESOURCE_URL = 'https://dql.thoughtproof.ai/dql/verify';

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

function facilitatorUrl(env: NodeJS.ProcessEnv): string {
  if (env.X402_FACILITATOR_URL?.trim()) return env.X402_FACILITATOR_URL.trim();
  return hasCdpCredentials(env) ? CDP_FACILITATOR_URL : 'https://x402.org/facilitator';
}

function facilitatorRequest(
  path: '/verify' | '/settle',
  env: NodeJS.ProcessEnv,
): { url: string; headers: Record<string, string> } {
  const url = `${facilitatorUrl(env)}${path}`;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (hasCdpCredentials(env)) {
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

async function facilitatorVerify(
  payload: unknown,
  paymentRequirements: unknown,
  env: NodeJS.ProcessEnv,
): Promise<{ isValid: boolean; invalidReason?: string }> {
  const cdp = hasCdpCredentials(env);
  const req = paymentRequirements as Record<string, unknown>;
  const body = cdp
    ? {
        x402Version: 2,
        paymentPayload: toV2PaymentPayload(payload as Record<string, unknown>, toV2Requirements(req)),
        paymentRequirements: toV2Requirements(req),
      }
    : { x402Version: 1, paymentPayload: payload, paymentRequirements };
  const { url, headers } = facilitatorRequest('/verify', env);
  const resp = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
  if (!resp.ok) {
    const text = await resp.text().catch(() => 'unknown');
    return { isValid: false, invalidReason: `Facilitator verify failed (${resp.status}): ${text}` };
  }
  return (await resp.json()) as { isValid: boolean; invalidReason?: string };
}

async function facilitatorSettle(
  payload: unknown,
  paymentRequirements: unknown,
  env: NodeJS.ProcessEnv,
): Promise<{ success: boolean; txHash?: string; network?: string; error?: string }> {
  const cdp = hasCdpCredentials(env);
  const req = paymentRequirements as Record<string, unknown>;
  const body = cdp
    ? {
        x402Version: 2,
        paymentPayload: toV2PaymentPayload(payload as Record<string, unknown>, toV2Requirements(req)),
        paymentRequirements: toV2Requirements(req),
      }
    : { x402Version: 1, paymentPayload: payload, paymentRequirements };
  const { url, headers } = facilitatorRequest('/settle', env);
  const resp = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
  if (!resp.ok) {
    const text = await resp.text().catch(() => 'unknown');
    return { success: false, error: `Facilitator settle failed (${resp.status}): ${text}` };
  }
  const raw = (await resp.json()) as Record<string, unknown>;
  return {
    success: raw.success === true,
    txHash: (raw.transaction ?? raw.txHash) as string | undefined,
    network: raw.network as string | undefined,
    error: (raw.error ?? raw.errorReason ?? raw.errorMessage) as string | undefined,
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

export type X402GateResult =
  | { kind: 'disabled' }
  | { kind: 'paid'; txHash?: string; network?: string }
  | { kind: 'challenge' }
  | { kind: 'reject'; status: number; body: Record<string, unknown> };

/**
 * Process PAYMENT-SIGNATURE when present. Does NOT send the response —
 * caller applies challenge headers / JSON.
 */
export async function processX402Payment(
  req: VercelRequest,
  env: NodeJS.ProcessEnv = process.env,
): Promise<X402GateResult> {
  if (!isX402Enabled(env)) return { kind: 'disabled' };

  const paymentSig = req.headers['payment-signature'] as string | undefined;
  if (!paymentSig) return { kind: 'challenge' };

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(Buffer.from(paymentSig, 'base64').toString('utf8')) as Record<string, unknown>;
  } catch {
    return {
      kind: 'reject',
      status: 402,
      body: { error: 'Invalid PAYMENT-SIGNATURE header: not valid base64 JSON', code: 'PAYMENT_REQUIRED' },
    };
  }

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
      kind: 'reject',
      status: 402,
      body: {
        error: 'Unsupported x402 network for DQL (Base mainnet only in v1)',
        code: 'PAYMENT_REQUIRED',
        network: effectiveNetwork,
      },
    };
  }

  const clientNetwork = effectiveNetwork === 'base' ? 'base' : 'eip155:8453';
  const micro = amountMicro();
  const paymentRequirements = {
    scheme: 'exact',
    network: clientNetwork,
    amount: micro,
    maxAmountRequired: micro,
    asset: USDC_BASE,
    payTo: paymentWallet(env),
    resource: RESOURCE_URL,
    maxTimeoutSeconds: 300,
    extra: { name: 'USD Coin', version: '2' },
  };

  let verification: { isValid: boolean; invalidReason?: string };
  try {
    verification = await facilitatorVerify(payload, paymentRequirements, env);
  } catch (err) {
    return {
      kind: 'reject',
      status: 502,
      body: { error: `Payment verification unavailable: ${String(err)}`, code: 'PAYMENT_UNAVAILABLE' },
    };
  }
  if (!verification.isValid) {
    return {
      kind: 'reject',
      status: 402,
      body: {
        error: 'Payment verification failed',
        code: 'PAYMENT_REQUIRED',
        reason: verification.invalidReason,
      },
    };
  }

  let settlement: { success: boolean; txHash?: string; network?: string; error?: string };
  try {
    settlement = await facilitatorSettle(payload, paymentRequirements, env);
  } catch (err) {
    return {
      kind: 'reject',
      status: 502,
      body: { error: `Settlement unavailable: ${String(err)}`, code: 'PAYMENT_UNAVAILABLE' },
    };
  }
  if (!settlement.success) {
    return {
      kind: 'reject',
      status: 402,
      body: {
        error: 'Settlement failed',
        code: 'PAYMENT_REQUIRED',
        details: settlement.error,
      },
    };
  }

  return { kind: 'paid', txHash: settlement.txHash, network: settlement.network ?? clientNetwork };
}

/** Apply challenge headers onto a 402 response. */
export function applyX402ChallengeHeaders(res: VercelResponse, env: NodeJS.ProcessEnv = process.env): Record<string, unknown> {
  const { body, paymentRequiredHeader } = buildX402Challenge(env);
  res.setHeader('payment-required', paymentRequiredHeader);
  return body;
}
