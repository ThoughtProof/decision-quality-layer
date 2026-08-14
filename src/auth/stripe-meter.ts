/**
 * Stripe Billing Meter Events for DQL billable API-key calls.
 *
 * PAYMENT.md Rail A: meter event name `dql_verify_call` @ $0.05/call.
 * Default OFF — only active when STRIPE_SECRET_KEY is set AND
 * DQL_STRIPE_METER_ENABLED is truthy. Missing customer mapping skips
 * the event (never fails the verify call).
 *
 * Idempotency: Stripe-Idempotency-Key = DQL request_id.
 *
 * PR #36 HOLD fix: meter emit is AWAITED (not fire-and-forget) with a hard
 * timeout. On Vercel, fire-and-forget can be dropped after the response is
 * sent. Failure is logged; billing errors do not flip a successful DQL
 * response to 5xx (product already delivered; retry via idempotency key).
 */

import { createHash } from 'node:crypto';

import { PRICE_USD_PER_CALL } from '../pricing.js';

export const STRIPE_METER_EVENT_NAME = 'dql_verify_call';
export const STRIPE_METER_EVENTS_URL = 'https://api.stripe.com/v1/billing/meter_events';

/** Hard timeout for Stripe meter network calls. */
export const STRIPE_METER_TIMEOUT_MS = 5_000;

export type StripeMeterResult =
  | { kind: 'skipped'; reason: string }
  | { kind: 'ok'; event_name: string; identifier?: string }
  | { kind: 'error'; reason: string; status?: number };

export interface StripeMeterConfig {
  enabled: boolean;
  secretKey: string;
  eventName: string;
  /** Map owner → Stripe customer id (cus_…). */
  customerByOwner: Map<string, string>;
}

function truthy(v: string | undefined): boolean {
  return ['true', '1', 'on', 'yes'].includes((v ?? '').trim().toLowerCase());
}

/** Parse DQL_STRIPE_CUSTOMER_MAP JSON: {"owner":"cus_xxx", ...}. */
export function parseCustomerMap(raw: string | undefined): Map<string, string> {
  const out = new Map<string, string>();
  if (!raw?.trim()) return out;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return out;
    for (const [owner, cus] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof owner === 'string' && typeof cus === 'string' && cus.startsWith('cus_')) {
        out.set(owner, cus);
      }
    }
  } catch {
    return out;
  }
  return out;
}

export function loadStripeMeterConfig(env: NodeJS.ProcessEnv = process.env): StripeMeterConfig {
  const secretKey = (env.STRIPE_SECRET_KEY ?? '').trim();
  const enabled = truthy(env.DQL_STRIPE_METER_ENABLED) && secretKey.length > 0;
  const eventName =
    (env.STRIPE_METER_EVENT_NAME ?? STRIPE_METER_EVENT_NAME).trim() || STRIPE_METER_EVENT_NAME;
  return {
    enabled,
    secretKey,
    eventName,
    customerByOwner: parseCustomerMap(env.DQL_STRIPE_CUSTOMER_MAP),
  };
}

export interface EmitStripeMeterOpts {
  requestId: string;
  owner: string;
  priceUsd?: number;
  /** Optional override for tests. */
  fetchImpl?: typeof fetch;
  config?: StripeMeterConfig;
  nowSec?: () => number;
  /** Timeout ms (default STRIPE_METER_TIMEOUT_MS). */
  timeoutMs?: number;
}

async function fetchWithTimeout(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Awaited meter emit with hard timeout. Never throws into the request path.
 * Billable keys only (caller must gate on !dev_access && price > 0).
 * MUST be awaited before the response is finalized on Vercel.
 */
export async function emitStripeMeterEvent(opts: EmitStripeMeterOpts): Promise<StripeMeterResult> {
  const cfg = opts.config ?? loadStripeMeterConfig();
  if (!cfg.enabled) return { kind: 'skipped', reason: 'meter_disabled' };

  const customer = cfg.customerByOwner.get(opts.owner);
  if (!customer) return { kind: 'skipped', reason: 'no_customer_mapping' };

  const price = opts.priceUsd ?? PRICE_USD_PER_CALL;
  if (!(price > 0)) return { kind: 'skipped', reason: 'zero_price' };

  const timestamp = (opts.nowSec ?? (() => Math.floor(Date.now() / 1000)))();
  // Stripe meter events: event_name + payload[stripe_customer_id] + value
  const body = new URLSearchParams();
  body.set('event_name', cfg.eventName);
  body.set('timestamp', String(timestamp));
  body.set('identifier', opts.requestId);
  body.set('payload[stripe_customer_id]', customer);
  body.set('payload[value]', '1'); // 1 call unit; price is on the meter/price object in Stripe

  const fetchImpl = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const timeoutMs = opts.timeoutMs ?? STRIPE_METER_TIMEOUT_MS;
  try {
    const resp = await fetchWithTimeout(
      fetchImpl,
      STRIPE_METER_EVENTS_URL,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${cfg.secretKey}`,
          'Content-Type': 'application/x-www-form-urlencoded',
          'Idempotency-Key': opts.requestId,
          'Stripe-Version': '2024-11-20.acacia',
        },
        body: body.toString(),
      },
      timeoutMs,
    );
    if (!resp.ok) {
      // Never log Stripe response bodies (may contain account/customer details).
      await resp.text().catch(() => '');
      console.warn(
        JSON.stringify({
          type: 'dql_stripe_meter_error',
          request_id: opts.requestId,
          owner: opts.owner,
          status: resp.status,
          ts: new Date().toISOString(),
        }),
      );
      return { kind: 'error', reason: `http_${resp.status}`, status: resp.status };
    }
    const json = (await resp.json().catch(() => ({}))) as { identifier?: string };
    console.log(
      JSON.stringify({
        type: 'dql_stripe_meter',
        request_id: opts.requestId,
        owner: opts.owner,
        customer_fingerprint: fingerprintCustomer(customer),
        event_name: cfg.eventName,
        value: 1,
        price_usd: price,
        ts: new Date().toISOString(),
      }),
    );
    return { kind: 'ok', event_name: cfg.eventName, identifier: json.identifier ?? opts.requestId };
  } catch (err) {
    // Coarse reason only — never raw err.message (may contain URLs/secrets).
    const reason =
      err instanceof Error && /aborted|timeout|AbortError/i.test(err.message)
        ? 'timeout'
        : err instanceof Error && /fetch failed|ECONN|ENOTFOUND|network/i.test(err.message)
          ? 'network'
          : 'fetch_failed';
    console.warn(
      JSON.stringify({
        type: 'dql_stripe_meter_error',
        request_id: opts.requestId,
        owner: opts.owner,
        reason,
        ts: new Date().toISOString(),
      }),
    );
    return { kind: 'error', reason };
  }
}

function fingerprintCustomer(cus: string): string {
  return createHash('sha256').update(cus, 'utf8').digest('hex').slice(0, 12);
}
