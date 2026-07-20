/**
 * POST /dql/verify
 *
 * 5-axis reasoning verification for AI agents.
 *
 * Request body:  DqlRequest  (see src/types.ts)
 * Response:      DqlResponse (200) | DqlError (4xx/5xx)
 *
 * Phase 0.2 (this file): production cascade (PotCliCascade, nano→swift) is
 * wired behind the DQL_CASCADE env-switch. Default remains the StubCascade
 * so local dev + CI stay hermetic. Sandbox mode still returns deterministic
 * mock verdicts. Payment gates land in Phase 2.
 *
 * Cascade selection:
 *   DQL_CASCADE=stub      → StubCascade (default; all axes UNCERTAIN)
 *   DQL_CASCADE=pot-cli   → PotCliCascade (serv-nano → serv-swift, live LLM)
 *   sandbox: true         → SandboxCascade (regardless of DQL_CASCADE)
 *
 * PotCliCascade requires:
 *   SERV_API_KEY    — for both serv-nano and serv-swift models
 * See docs/ENV.md for the full list.
 *
 * Pricing (see src/pricing.ts):
 *   - Pay-as-you-go, $0.05/call
 *   - No freemium
 *   - Sandbox calls (`sandbox: true` in body) are free
 *   - Dev-access API keys are granted manually and are also free
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { validateVerifyRequest } from '../../src/validation.js';
import { runVerification } from '../../src/engine/index.js';
import { StubCascade } from '../../src/engine/cascade.js';
import type { Cascade } from '../../src/engine/cascade.js';
import { SandboxCascade } from '../../src/engine/sandbox-cascade.js';
import { authorizeCall, parseApiKeys } from '../../src/auth/keys.js';
import { createUsageGate, emitUsageLine } from '../../src/auth/usage.js';
import { priceForCall } from '../../src/pricing.js';
import {
  createProductionRuntime,
  type ProductionRuntime,
} from '../../src/engine/production-runtime.js';
import {
  parseRuntimeMode,
  ProductionConfigError,
} from '../../src/engine/production-config.js';
import {
  RuntimeDiagnosticsCollector,
  type DiagnosticsSnapshot,
} from '../../src/engine/runtime-diagnostics.js';

const VERSION = '0.2.0';
const MAX_BODY_SIZE = 1_000_000; // 1 MB

// v0.4.3.1 hardening: production runtime bundle is constructed at cold-start.
// If resolveProductionConfig (or parseRuntimeMode itself) throws, we cache
// the error as kind='error' and surface 503 CONFIG_INVALID to EVERY POST
// request — including sandbox. Sandbox bypasses provider I/O and billing,
// NOT the deployment-health invariant (Hermes Blocker 1).
type RuntimeInit =
  | { kind: 'stub'; cascade: Cascade }
  | { kind: 'production'; production: ProductionRuntime; cascade: Cascade }
  | { kind: 'error'; reason: ProductionConfigError };

function pickRuntime(): RuntimeInit {
  let mode;
  try {
    mode = parseRuntimeMode(process.env.DQL_CASCADE);
  } catch (e) {
    if (e instanceof ProductionConfigError) return { kind: 'error', reason: e };
    throw e;
  }
  if (mode === 'pot-cli') {
    try {
      const production = createProductionRuntime(process.env);
      return { kind: 'production', production, cascade: production.cascade };
    } catch (e) {
      if (e instanceof ProductionConfigError) {
        return { kind: 'error', reason: e };
      }
      throw e;
    }
  }
  return { kind: 'stub', cascade: new StubCascade() };
}
const RUNTIME = pickRuntime();
const sandboxCascade = new SandboxCascade();

// Phase 2 key gate (docs/PAYMENT.md decision matrix): env-held key list,
// parsed once at cold start. A malformed DQL_API_KEYS yields an EMPTY map —
// every non-sandbox call fails closed (402), the safe direction for billing.
// USAGE_GATE is Upstash-backed when configured, otherwise a no-op (the
// daily-cap brake degrades; key validation is env-based and still holds).
const API_KEYS = parseApiKeys(process.env.DQL_API_KEYS);
const USAGE_GATE = createUsageGate(process.env);

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const requestId = `dql_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

  // v0.4.3.1 §C+integration: per-request diagnostics collector, created ONLY
  // when the runtime is a valid production bundle AND diagnostics_on=true.
  // The `finally` block below flushes the collector into the response body's
  // diagnostics slot (or into a bounded response header on error paths).
  //
  // NOTE: `requireDiagnostics` is enforced by the resolver's v0431_active
  // canary path (see production-config.ts). If the resolver accepted the
  // config, diagnostics_on is guaranteed truthy for the canary; nothing here
  // may silently override that.
  let collector: RuntimeDiagnosticsCollector | null = null;
  if (
    RUNTIME.kind === 'production' &&
    RUNTIME.production.config.diagnostics_on
  ) {
    collector = new RuntimeDiagnosticsCollector(requestId);
  }

  // v0.4.3.1 §C+integration H4: prepare (status, payload) inside try/catch,
  // then send exactly once via sendJsonWithDiagnostics() OUTSIDE the
  // try/catch. The helper flushes the diagnostics header FIRST
  // (setHeader is safe as long as no body has been written) THEN calls
  // res.status(...).json(...). This guarantees the header is wire-effective
  // on BOTH success and error paths, closing the gap where the previous
  // implementation flushed only in the 200 branch.
  let status = 200;
  let payload: unknown = null;

  try {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-DQL-Key');
    res.setHeader('X-DQL-Version', VERSION);
    res.setHeader('X-Request-Id', requestId);

    if (req.method === 'OPTIONS') {
      // No diagnostics on preflight — collector is not populated for OPTIONS.
      return res.status(200).end();
    }

    if (req.method !== 'POST') {
      status = 405;
      payload = { error: 'Method not allowed', code: 'METHOD_NOT_ALLOWED', allowed: ['POST'] };
    } else {
      const contentType = req.headers['content-type'];
      if (contentType && !contentType.includes('application/json')) {
        status = 415;
        payload = { error: 'Content-Type must be application/json', code: 'UNSUPPORTED_MEDIA_TYPE' };
      } else if (req.body && JSON.stringify(req.body).length > MAX_BODY_SIZE) {
        status = 413;
        payload = { error: 'Request too large', code: 'PAYLOAD_TOO_LARGE', max_bytes: MAX_BODY_SIZE };
      } else {
        // Phase 2 key gate: sandbox stays free (integration testing);
        // everything else needs a valid X-DQL-Key (PAYMENT.md matrix).
        // Auth runs BEFORE validation — strangers don't get parsing work.
        const auth = await authorizeCall({
          headers: req.headers as Record<string, unknown>,
          sandbox: (req.body as { sandbox?: unknown } | undefined)?.sandbox === true,
          keys: API_KEYS,
          usage: USAGE_GATE,
        });
        if (auth.kind === 'deny') {
          status = auth.status;
          payload = auth.payload;
        } else {
          const validation = validateVerifyRequest(req.body);
          if (!validation.valid) {
            status = 400;
            payload = { error: 'Validation failed', code: 'INVALID_REQUEST', details: validation.errors };
          } else if (RUNTIME.kind === 'error') {
            // v0.4.3.1 hardening (Hermes Blocker 1): if the cold-start
            // resolver failed for a Live-configured deploy, EVERY POST
            // returns 503, including sandbox=true.
            status = 503;
            payload = {
              error: 'Runtime not initialised',
              code: 'CONFIG_INVALID',
              reasons: RUNTIME.reason.reasons,
            };
          } else {
            const response = await runVerification({
              request: validation.request,
              cascade: RUNTIME.cascade,
              sandboxCascade,
              requestId,
              version: VERSION,
              collector: collector ?? undefined,
              ...(RUNTIME.kind === 'production' &&
              RUNTIME.production.config.deadline_enforcement_enabled
                ? {
                    requestDeadlineMs: RUNTIME.production.config.request_deadline_ms,
                    providerCallBudgetMs: RUNTIME.production.config.provider_call_budget_ms,
                  }
                : {}),
            });
            status = 200;
            payload = response;
            // Billing surface: informational headers + the structured usage
            // line that becomes the meter record once Stripe/x402 rails land.
            if (auth.kind === 'allow') {
              const price = priceForCall({
                sandbox: false,
                dev_access: auth.record.dev_access,
              });
              res.setHeader('X-DQL-Billing', auth.record.dev_access ? 'dev-access' : 'metered');
              res.setHeader('X-DQL-Price-Usd', price.toFixed(2));
              emitUsageLine({
                requestId,
                key: auth.key,
                owner: auth.record.owner,
                devAccess: auth.record.dev_access,
                priceUsd: price,
                verdict: (response as { verdict?: string }).verdict,
              });
            } else {
              res.setHeader('X-DQL-Billing', 'sandbox');
              res.setHeader('X-DQL-Price-Usd', '0.00');
            }
          }
        }
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    status = 500;
    payload = { error: 'Internal server error', code: 'INTERNAL_ERROR', details: message };
  }

  return sendJsonWithDiagnostics(res, collector, status, payload);
}

/**
 * v0.4.3.1 §C+integration H4: send status+body in one hop, but ALWAYS
 * attempt the diagnostics header flush FIRST so it lands on the wire.
 * Because setHeader is legal until the first body write, this ordering
 * guarantees the `X-DQL-Diagnostics` (or the truncated-counts pair) is
 * present on ALL response paths — 200, 400, 405, 413, 415, 500, 503 —
 * whenever the collector observed activity.
 *
 * Never throws. A failure inside the flush is swallowed; the (status,
 * body) pair is delivered unchanged.
 */
export function sendJsonWithDiagnostics(
  res: VercelResponse,
  collector: RuntimeDiagnosticsCollector | null,
  status: number,
  payload: unknown,
): void {
  try {
    flushDiagnosticsHeader(collector, res);
  } catch {
    // Diagnostics must never poison the live response.
  }
  res.status(status).json(payload);
}

/**
 * v0.4.3.1 §C+integration: bounded, structured diagnostics header flush.
 *
 * The primary success path calls this BEFORE res.json() so the header
 * actually lands on the wire (Vercel closes headers on the first body
 * write). The `finally` handler calls it as a safety net on error paths
 * where headers may still be settable.
 *
 * NEVER throws. Any failure inside the flush is swallowed — the response
 * status/body must not be affected by diagnostics.
 */
export function flushDiagnosticsHeader(
  collector: RuntimeDiagnosticsCollector | null,
  res: VercelResponse,
): void {
  if (!collector) return;
  try {
    if (res.headersSent) return;
    const snapshot: DiagnosticsSnapshot = collector.flush();
    const serialized = JSON.stringify(snapshot);
    // Cap header value at 8 KB to stay well below Vercel's 16 KB per-header
    // limit. When over-cap, emit compact counts instead so operators still
    // know the request produced diagnostics that could not fit on the wire.
    // v0.4.3.1 §C+integration M2: use Buffer.byteLength so we cap on wire
    // bytes (UTF-8) rather than JavaScript string length. Multi-byte
    // characters would otherwise sneak past the string-length cap and
    // push the header over Vercel's 16 KB per-header limit.
    if (Buffer.byteLength(serialized, 'utf8') <= 8_192) {
      res.setHeader('X-DQL-Diagnostics', serialized);
    } else {
      res.setHeader('X-DQL-Diagnostics-Truncated', '1');
      // v0.4.3.1 §C+integration M2 follow-up (Hermes b5f9dc6 review):
      // binding_summaries is a first-class stream on the snapshot and MUST
      // appear in the truncation counts (both retained and dropped). Without
      // it, an oversize response would silently hide summary evidence.
      res.setHeader(
        'X-DQL-Diagnostics-Counts',
        JSON.stringify({
          transitions: snapshot.transitions.items.length,
          stale_results: snapshot.stale_results.items.length,
          invalid_outcomes: snapshot.invalid_outcomes.items.length,
          attempts: snapshot.attempts.items.length,
          binding_summaries: snapshot.binding_summaries.items.length,
          dropped: {
            transitions: snapshot.transitions.dropped,
            stale_results: snapshot.stale_results.dropped,
            invalid_outcomes: snapshot.invalid_outcomes.dropped,
            attempts: snapshot.attempts.dropped,
            binding_summaries: snapshot.binding_summaries.dropped,
          },
        }),
      );
    }
  } catch {
    // Diagnostics must never poison a live response.
  }
}
