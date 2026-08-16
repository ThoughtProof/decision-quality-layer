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
import { authorizeCall, extractApiKey, parseApiKeys } from '../../src/auth/keys.js';
import {
  authorizeVerifyWithAccount,
  commitVerifyReservation,
  extractAccountToken,
  persistMeterPending,
  releaseVerifyReservation,
  reserveVerifyWithAccount,
} from '../../src/auth/account.js';
import { createKeyStore } from '../../src/auth/key-store.js';
import { generateVerifyRequestId, resolveVerifyRequestId } from '../../src/auth/request-id.js';
import { verifyPayloadDigest } from '../../src/auth/verify-payload.js';
import { createUsageGate, emitUsageLine } from '../../src/auth/usage.js';
import { emitStripeMeterEvent, loadStripeMeterConfig } from '../../src/auth/stripe-meter.js';
import {
  applyX402ChallengeHeaders,
  isX402Enabled,
  settleX402Payment,
  verifyX402Payment,
  type X402PaymentContext,
} from '../../src/auth/x402.js';
import { PRICE_USD_PER_CALL, priceForCall } from '../../src/pricing.js';
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

import { PACKAGE_VERSION } from '../../src/package-version.js';

/** Artifact version (package.json). See docs/ENV.md § Version semantics. */
const VERSION = PACKAGE_VERSION;
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

// Phase 2 key gate (docs/PAYMENT.md decision matrix): env-held key list
// (bootstrap: canary / guardian-pwa / manual dev_access) ∪ Upstash store
// (self-serve minted billable keys). Malformed DQL_API_KEYS → empty env
// map. Store miss + env miss → 402. USAGE_GATE is the daily-cap brake.
const API_KEYS = parseApiKeys(process.env.DQL_API_KEYS);
const USAGE_GATE = createUsageGate(process.env);
const KEY_STORE = createKeyStore(process.env);

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const resolvedId = resolveVerifyRequestId(req.headers as Record<string, unknown>);
  const requestId = resolvedId.kind === 'ok' ? resolvedId.id : generateVerifyRequestId();
  type AccountHold = {
    requestId: string;
    keyHash: string;
    fence: number;
    billing?: import('../../src/auth/keys.js').AllowBilling;
  };
  let accountHold: AccountHold | null = null;
  let accountReplay: {
    result: unknown;
    billing?: import('../../src/auth/keys.js').AllowBilling;
    meter?: import('../../src/auth/key-store.js').VerifyReservation['meter'];
  } | null = null;
  let accountMeterPending: { result: unknown; hold: AccountHold } | null = null;

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
    res.setHeader(
      'Access-Control-Allow-Headers',
      'Content-Type, Authorization, X-DQL-Key, X-DQL-Account, Idempotency-Key, X-Request-Id, PAYMENT-SIGNATURE, Payment-Signature',
    );
    res.setHeader(
      'Access-Control-Expose-Headers',
      [
        'X-Request-Id',
        'X-DQL-Version',
        'X-DQL-Billing',
        'X-DQL-Price-Usd',
        'X-DQL-Meter',
        'payment-required',
        'payment-response',
        'X-DQL-Diagnostics',
        'X-DQL-Diagnostics-Truncated',
        'X-DQL-Diagnostics-Counts',
      ].join(', '),
    );
    res.setHeader('X-DQL-Version', VERSION);
    res.setHeader('X-Request-Id', requestId);

    if (req.method === 'OPTIONS') {
      // No diagnostics on preflight — collector is not populated for OPTIONS.
      return res.status(200).end();
    }

    if (resolvedId.kind === 'invalid') {
      status = 400;
      payload = {
        error: 'Idempotency-Key must be 8–128 characters of [A-Za-z0-9._:-] and must not look like a secret.',
        code: 'INVALID_IDEMPOTENCY_KEY',
      };
    } else if (req.method !== 'POST') {
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
        // Correct payment semantics (PR #36 HOLD fix):
        //   validate → payment VERIFY → DQL → payment SETTLE / Stripe await → respond
        // Never settle/charge before a successful DQL result.
        // Cheap auth identity (key presence / sandbox) still runs early for 402 matrix.
        const isSandbox =
          (req.body as { sandbox?: unknown } | undefined)?.sandbox === true;
        const headers = req.headers as Record<string, unknown>;
        const presentedKey = extractApiKey(headers);
        const accountToken = extractAccountToken(headers);
        const verifyKey = presentedKey && presentedKey.startsWith('dqlk_') ? presentedKey : null;

        type AuthPath =
          | { kind: 'free_sandbox' }
          | {
              kind: 'allow';
              key: string;
              record: import('../../src/auth/keys.js').ApiKeyRecord;
              billing?: import('../../src/auth/keys.js').AllowBilling;
              via?: 'key' | 'account';
            }
          | { kind: 'x402_verified'; ctx: X402PaymentContext }
          | { kind: 'deny'; status: number; payload: object };

        // 1) Body validation FIRST for non-challenge paths that will charge.
        //    Sandbox and pure 402-challenge still need identity matrix, but
        //    invalid bodies must never reach settle/meter.
        const validation = validateVerifyRequest(req.body);
        const validatedRequest = validation.valid ? validation.request : null;

        let authPath: AuthPath;

        if (!validation.valid || !validatedRequest) {
          // Invalid body → 400. Never verify/settle x402 or emit Stripe on bad requests.
          authPath = {
            kind: 'deny',
            status: 400,
            payload: {
              error: 'Validation failed',
              code: 'INVALID_REQUEST',
              details: validation.valid ? ['Invalid request'] : validation.errors,
            },
          };
        } else if (isSandbox) {
          authPath = { kind: 'free_sandbox' };
        } else if (verifyKey) {
          const auth = await authorizeCall({
            headers,
            sandbox: false,
            keys: API_KEYS,
            usage: USAGE_GATE,
            store: KEY_STORE ?? undefined,
          });
          if (auth.kind === 'deny') {
            authPath = { kind: 'deny', status: auth.status, payload: auth.payload as object };
          } else if (auth.kind === 'allow') {
            authPath = { kind: 'allow', key: auth.key, record: auth.record, billing: auth.billing };
          } else {
            authPath = { kind: 'free_sandbox' };
          }
        } else if (accountToken) {
          // App-credential path: `dqla_…` bills the bound ledger. Never returns `dqlk_…`.
          if (!KEY_STORE) {
            authPath = {
              kind: 'deny',
              status: 503,
              payload: {
                error: 'Account store unavailable',
                code: 'ACCOUNT_UNAVAILABLE',
              },
            };
          } else {
            const auth = await authorizeVerifyWithAccount({
              headers,
              store: KEY_STORE,
            });
            if (auth.kind === 'deny') {
              authPath = { kind: 'deny', status: auth.status, payload: auth.payload as object };
            } else if (auth.kind === 'allow') {
              authPath = {
                kind: 'allow',
                key: auth.key,
                record: auth.record,
                via: 'account',
              };
            } else {
              authPath = { kind: 'free_sandbox' };
            }
          }
        } else if (presentedKey) {
          // `X-DQL-Key: dqla_…` (or other non-dqlk_ value) — not an account token.
          const auth = await authorizeCall({
            headers,
            sandbox: false,
            keys: API_KEYS,
            usage: USAGE_GATE,
            store: KEY_STORE ?? undefined,
          });
          if (auth.kind === 'deny') {
            authPath = { kind: 'deny', status: auth.status, payload: auth.payload as object };
          } else if (auth.kind === 'allow') {
            authPath = { kind: 'allow', key: auth.key, record: auth.record, billing: auth.billing };
          } else {
            authPath = { kind: 'free_sandbox' };
          }
        } else if (isX402Enabled(process.env)) {
          // 2) Payment VERIFY only — settle happens after successful DQL.
          const x402 = await verifyX402Payment(req, process.env);
          if (x402.kind === 'verified') {
            authPath = { kind: 'x402_verified', ctx: x402.ctx };
          } else if (x402.kind === 'reject') {
            authPath = { kind: 'deny', status: x402.status, payload: x402.body };
          } else if (x402.kind === 'challenge' || x402.kind === 'disabled') {
            const challengeBody = applyX402ChallengeHeaders(res, process.env);
            authPath = { kind: 'deny', status: 402, payload: challengeBody };
          } else {
            const challengeBody = applyX402ChallengeHeaders(res, process.env);
            authPath = { kind: 'deny', status: 402, payload: challengeBody };
          }
        } else {
          const auth = await authorizeCall({
            headers,
            sandbox: false,
            keys: API_KEYS,
            usage: USAGE_GATE,
            store: KEY_STORE ?? undefined,
          });
          if (auth.kind === 'deny') {
            authPath = { kind: 'deny', status: auth.status, payload: auth.payload as object };
          } else if (auth.kind === 'allow') {
            authPath = { kind: 'allow', key: auth.key, record: auth.record, billing: auth.billing };
          } else {
            authPath = { kind: 'free_sandbox' };
          }
        }

        if (authPath.kind === 'allow' && authPath.via === 'account') {
          // Admission: reserve credit + daily-cap BEFORE verify / CONFIG_INVALID.
          if (!KEY_STORE) {
            authPath = {
              kind: 'deny',
              status: 503,
              payload: {
                error: 'Account store unavailable',
                code: 'ACCOUNT_UNAVAILABLE',
              },
            };
          } else {
            const reserved = await reserveVerifyWithAccount({
              requestId,
              keyHash: authPath.key,
              payloadDigest: verifyPayloadDigest(validatedRequest!),
              record: authPath.record,
              store: KEY_STORE,
            });
            if (reserved.kind === 'deny') {
              authPath = { kind: 'deny', status: reserved.status, payload: reserved.payload as object };
            } else if (reserved.kind === 'replay') {
              authPath = {
                kind: 'allow',
                key: reserved.key,
                record: reserved.record,
                billing: reserved.billing,
                via: 'account',
              };
              accountReplay = {
                result: reserved.result,
                billing: reserved.billing,
                meter: reserved.reservation.meter,
              };
            } else if (reserved.kind === 'meter_pending') {
              authPath = {
                kind: 'allow',
                key: reserved.key,
                record: reserved.record,
                billing: reserved.billing,
                via: 'account',
              };
              accountMeterPending = {
                result: reserved.result,
                hold: {
                  requestId,
                  keyHash: reserved.reservation.keyHash,
                  fence: reserved.reservation.fence,
                  billing: reserved.billing,
                },
              };
            } else if (reserved.kind === 'execute') {
              authPath = {
                kind: 'allow',
                key: reserved.key,
                record: reserved.record,
                billing: reserved.billing,
                via: 'account',
              };
              accountHold = {
                requestId,
                keyHash: reserved.reservation.keyHash,
                fence: reserved.reservation.fence,
                billing: reserved.billing,
              };
            }
          }
        }

        if (authPath.kind === 'deny') {
          status = authPath.status;
          payload = authPath.payload;
        } else if (accountReplay) {
          if (accountReplay.result == null) {
            status = 503;
            payload = {
              error: 'Idempotent replay is missing a stored result.',
              code: 'IDEMPOTENCY_RESULT_MISSING',
            };
          } else {
            applyAccountBillingHeaders(res, accountReplay.billing);
            if (accountReplay.billing === 'payg' || accountReplay.meter === 'ok') {
              res.setHeader('X-DQL-Meter', 'ok');
            }
            status = 200;
            payload = accountReplay.result;
          }
        } else if (accountMeterPending && KEY_STORE && authPath.kind === 'allow') {
          if (accountMeterPending.result == null) {
            status = 503;
            payload = {
              error: 'Stored verify result is missing; meter cannot be retried.',
              code: 'IDEMPOTENCY_RESULT_MISSING',
            };
          } else {
            const metered = await meterAccountPayg({
              requestId,
              record: authPath.record,
              store: KEY_STORE,
            });
            if (metered !== 'ok') {
              status = 503;
              payload = meterUnavailablePayload();
            } else {
              const acked = await acknowledgeCommit({
                hold: accountMeterPending.hold,
                store: KEY_STORE,
                result: accountMeterPending.result,
                meter: 'ok',
              });
              if (!acked) {
                status = 503;
                payload = commitUnavailablePayload();
              } else {
                applyAccountBillingHeaders(res, accountMeterPending.hold.billing);
                res.setHeader('X-DQL-Meter', 'ok');
                status = 200;
                payload = accountMeterPending.result;
              }
            }
          }
        } else if (RUNTIME.kind === 'error') {
          // v0.4.3.1 hardening (Hermes Blocker 1): if the cold-start
          // resolver failed for a Live-configured deploy, EVERY POST
          // returns 503, including sandbox=true. Never settle on config fail.
          if (accountHold && KEY_STORE) {
            await releaseVerifyReservation({
              requestId: accountHold.requestId,
              keyHash: accountHold.keyHash,
              fence: accountHold.fence,
              store: KEY_STORE,
            });
            accountHold = null;
          }
          status = 503;
          payload = {
            error: 'Runtime not initialised',
            code: 'CONFIG_INVALID',
            reasons: RUNTIME.reason.reasons,
          };
        } else {
          // 3) DQL execute — validatedRequest is non-null on non-deny paths.
          const response = await runVerification({
            request: validatedRequest!,
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

          // Account PAYG: persist result as meter_pending, then meter, then
          // commit. A failed meter must not discard the engine result or
          // release the debit — retry remeters only.
          if (accountHold && KEY_STORE && accountHold.billing === 'payg' && authPath.kind === 'allow') {
            const pending = await persistMeterPending({
              requestId: accountHold.requestId,
              keyHash: accountHold.keyHash,
              fence: accountHold.fence,
              store: KEY_STORE,
              result: response,
            });
            if (pending !== 'pending') {
              status = 503;
              payload = commitUnavailablePayload();
            } else {
              const metered = await meterAccountPayg({
                requestId,
                record: authPath.record,
                store: KEY_STORE,
              });
              if (metered !== 'ok') {
                status = 503;
                payload = meterUnavailablePayload();
              } else {
                const acked = await acknowledgeCommit({
                  hold: accountHold,
                  store: KEY_STORE,
                  result: response,
                  meter: 'ok',
                });
                if (!acked) {
                  status = 503;
                  payload = commitUnavailablePayload();
                } else {
                  accountHold = null;
                  res.setHeader('X-DQL-Meter', 'ok');
                }
              }
            }
          } else if (accountHold && KEY_STORE) {
            const acked = await acknowledgeCommit({
              hold: accountHold,
              store: KEY_STORE,
              result: response,
              meter: 'n/a',
            });
            if (!acked) {
              status = 503;
              payload = commitUnavailablePayload();
            } else {
              accountHold = null;
            }
          }

          // 4) Payment settle / Stripe meter ONLY after successful DQL.
          if (authPath.kind === 'allow' && status === 200 && payload === null) {
            const price = priceForCall({
              sandbox: false,
              dev_access: authPath.record.dev_access,
            });
            const rail = authPath.record.dev_access ? 'dev-access' : 'metered-log-only';
            const usedCredit = authPath.billing === 'credit';
            res.setHeader(
              'X-DQL-Billing',
              authPath.record.dev_access ? 'dev-access' : usedCredit ? 'credit' : 'metered',
            );
            res.setHeader('X-DQL-Price-Usd', usedCredit ? '0.00' : price.toFixed(2));
            emitUsageLine({
              requestId,
              key: authPath.key,
              owner: authPath.record.owner,
              devAccess: authPath.record.dev_access,
              priceUsd: usedCredit ? 0 : price,
              verdict: (response as { verdict?: string }).verdict,
              billingRail: usedCredit ? 'credit' : rail,
            });
            // Stripe meter: AWAITED (not fire-and-forget). Vercel drops
            // dangling promises after response. Errors are logged; product
            // already delivered — do not convert 200 → 5xx. Idempotency-Key
            // = requestId allows safe retry of failed meter posts.
            // Prepaid credit calls must not also emit a meter event.
            // Account PAYG already metered (and fail-closed) before commit.
            if (
              !authPath.record.dev_access &&
              !usedCredit &&
              price > 0 &&
              !(authPath.via === 'account' && authPath.billing === 'payg')
            ) {
              const meterCfg = loadStripeMeterConfig();
              const customerId =
                authPath.record.stripe_customer_id ??
                meterCfg.customerByOwner.get(authPath.record.owner) ??
                (KEY_STORE
                  ? await KEY_STORE.getCustomerByOwner(authPath.record.owner)
                  : undefined);
              const meter = await emitStripeMeterEvent({
                requestId,
                owner: authPath.record.owner,
                customerId,
                priceUsd: price,
                config: meterCfg,
              });
              if (meter.kind === 'error') {
                res.setHeader('X-DQL-Meter', 'error');
              } else if (meter.kind === 'ok') {
                res.setHeader('X-DQL-Meter', 'ok');
              } else {
                res.setHeader('X-DQL-Meter', meter.reason);
              }
            }
            status = 200;
            payload = response;
          } else if (authPath.kind === 'x402_verified') {
            // Settle only after successful DQL. Outcome may be settled,
            // PAYMENT_FAILED, PAYMENT_UNAVAILABLE, or PAYMENT_STATUS_UNKNOWN.
            const settled = await settleX402Payment(authPath.ctx, process.env);
            if (settled.kind === 'reject') {
              status = settled.status;
              payload = settled.body;
            } else {
              if (settled.txHash) {
                const receipt = {
                  txHash: settled.txHash,
                  network: settled.network ?? 'eip155:8453',
                  paidWith: 'x402-facilitator',
                };
                res.setHeader(
                  'payment-response',
                  Buffer.from(JSON.stringify(receipt)).toString('base64'),
                );
              }
              res.setHeader('X-DQL-Billing', 'x402');
              res.setHeader(
                'X-DQL-Price-Usd',
                priceForCall({ sandbox: false, dev_access: false }).toFixed(2),
              );
              console.log(
                JSON.stringify({
                  type: 'dql_usage',
                  request_id: requestId,
                  billing_rail: 'x402',
                  price_usd: PRICE_USD_PER_CALL,
                  tx_hash: settled.txHash,
                  network: settled.network,
                  verdict: (response as { verdict?: string }).verdict,
                  ts: new Date().toISOString(),
                }),
              );
              status = 200;
              payload = response;
            }
          } else if (authPath.kind === 'free_sandbox') {
            res.setHeader('X-DQL-Billing', 'sandbox');
            res.setHeader('X-DQL-Price-Usd', '0.00');
            status = 200;
            payload = response;
          }
          // Account reserve deny (402/429/503) already set status+payload before verify.
        }
      }
    }
  } catch (err) {
    if (accountHold && KEY_STORE) {
      try {
        await releaseVerifyReservation({
          requestId: accountHold.requestId,
          keyHash: accountHold.keyHash,
          fence: accountHold.fence,
          store: KEY_STORE,
        });
      } catch {
        // Release must not mask the original failure.
      }
      accountHold = null;
    }
    status = 500;
    payload = { error: 'Internal server error', code: 'INTERNAL_ERROR' };
  }

  return sendJsonWithDiagnostics(res, collector, status, payload);
}

function meterUnavailablePayload(): Record<string, unknown> {
  return {
    error: 'Pay-as-you-go meter unavailable. The verify result is stored; retry remeters only.',
    code: 'METER_UNAVAILABLE',
    no_freemium: true,
  };
}

function commitUnavailablePayload(): Record<string, unknown> {
  return {
    error: 'Verify result could not be durably committed. Retry the same Idempotency-Key.',
    code: 'COMMIT_UNAVAILABLE',
    no_freemium: true,
  };
}

async function meterAccountPayg(opts: {
  requestId: string;
  record: import('../../src/auth/keys.js').ApiKeyRecord;
  store: NonNullable<typeof KEY_STORE>;
}): Promise<'ok' | 'unavailable'> {
  const price = priceForCall({ sandbox: false, dev_access: opts.record.dev_access });
  const meterCfg = loadStripeMeterConfig();
  const customerId =
    opts.record.stripe_customer_id ??
    meterCfg.customerByOwner.get(opts.record.owner) ??
    (await opts.store.getCustomerByOwner(opts.record.owner));
  const meter = await emitStripeMeterEvent({
    requestId: opts.requestId,
    owner: opts.record.owner,
    customerId,
    priceUsd: price,
    config: meterCfg,
  });
  return meter.kind === 'ok' ? 'ok' : 'unavailable';
}

async function acknowledgeCommit(opts: {
  hold: { requestId: string; keyHash: string; fence: number };
  store: NonNullable<typeof KEY_STORE>;
  result: unknown;
  meter: import('../../src/auth/key-store.js').VerifyReservation['meter'];
}): Promise<boolean> {
  const acked = await commitVerifyReservation({
    requestId: opts.hold.requestId,
    keyHash: opts.hold.keyHash,
    fence: opts.hold.fence,
    store: opts.store,
    result: opts.result,
    meter: opts.meter,
  });
  return acked === 'committed';
}

function applyAccountBillingHeaders(
  res: VercelResponse,
  billing: import('../../src/auth/keys.js').AllowBilling | undefined,
): void {
  const usedCredit = billing === 'credit';
  res.setHeader('X-DQL-Billing', usedCredit ? 'credit' : 'metered');
  res.setHeader('X-DQL-Price-Usd', usedCredit ? '0.00' : PRICE_USD_PER_CALL.toFixed(2));
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
