/**
 * GET /openapi.json
 *
 * OpenAPI 3.1 spec for the DQL API. Served as-is from a static object so
 * clients can render docs (Swagger UI, Redoc), autogenerate SDKs, or discover
 * capabilities without pulling the source repo.
 *
 * Kept intentionally close to prod-Sentinel's openapi.ts in shape and tone —
 * developers who already integrate Sentinel should find DQL familiar.
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';

/**
 * Shared response-header block for every status code the verify handler
 * produces itself (200/400/401/405/413/415/500, and 402 plus PAYMENT-REQUIRED).
 * The config-invalid 503 path deliberately declares only X-DQL-Version +
 * X-Request-Id — on that path no diagnostics collector exists (v5 delta, R4).
 */
const verifyResponseHeaders = {
  'X-DQL-Version': { $ref: '#/components/headers/DqlVersion' },
  'X-Request-Id': { $ref: '#/components/headers/DqlRequestId' },
  'X-DQL-Diagnostics': { $ref: '#/components/headers/DqlDiagnostics' },
  'X-DQL-Diagnostics-Truncated': { $ref: '#/components/headers/DqlDiagnosticsTruncated' },
  'X-DQL-Diagnostics-Counts': { $ref: '#/components/headers/DqlDiagnosticsCounts' },
};

const spec = {
  openapi: '3.1.0',
  info: {
    title: 'ThoughtProof Decision Quality Layer (DQL) API',
    description:
      'Five-axis reasoning verification for AI agents. Each axis (intent, scope, risk, consistency, reversibility) is evaluated independently; the response returns per-axis verdicts plus an aggregate verdict. Cross-model cascade (serv-nano → serv-swift). Companion product to Sentinel — where Sentinel returns one verdict per call, DQL returns five so callers know which dimension of the decision is weak.',
    version: '0.2.0',
    // Pre-existing d7a8ff6 field renamed to a spec-conformant x- extension:
    // bare `guidance` is not a valid OpenAPI 3.1 info property and fails
    // strict 3.1 validation (unevaluatedProperties). Content unchanged.
    'x-guidance':
      'POST /dql/verify with (mandate, proposed_action, reasoning, context?) to receive per-axis verdicts plus an aggregate. Set `sandbox: true` in the body for a free deterministic mock response — useful for integration testing against the schema. GET /dql/axes for axis metadata (question and failure mode per axis). Live rails: X-DQL-Key (env ∪ Upstash store) or X-DQL-Account / Bearer dqla_… (bills the bound prepaid ledger; never returns dqlk_…), Stripe meter dql_verify_call, x402 on Base. Public Checkout key-mint and the post-purchase account API are code-complete behind DQL_CHECKOUT_ENABLED (default off) — merge does not enable the flag and is not a live self-serve claim.',
    contact: {
      url: 'https://thoughtproof.ai',
      email: 'support@thoughtproof.ai',
    },
    license: {
      name: 'MIT',
      url: 'https://github.com/ThoughtProof/decision-quality-layer/blob/main/LICENSE',
    },
  },
  servers: [
    {
      url: 'https://dql.thoughtproof.ai',
      description: 'Production',
    },
  ],
  security: [{ dqlKey: [] }, { dqlAccount: [] }, {}],
  paths: {
    '/dql/verify': {
      post: {
        operationId: 'dqlVerify',
        summary: 'Verify a proposed agent action across five axes',
        description:
          'Runs the requested axes in parallel through the serv-nano → serv-swift cascade. Returns per-axis verdicts (PASS / FAIL / UNCERTAIN with confidence and objection) and an aggregate verdict (ALLOW / BLOCK / REVIEW). Aggregation rules are pre-registered and documented in docs/ARCHITECTURE.md. Auth: `X-DQL-Key: dqlk_…` (unchanged) or `X-DQL-Account: dqla_…` / `Authorization: Bearer dqla_…` (bills the bound credit ledger; response never includes the raw verify key). `dqla_…` is not accepted as `X-DQL-Key`. Invalid/missing account token → 401. Unpaid (no key, no `PAYMENT-SIGNATURE`) → 402 x402 handshake (`PAYMENT-REQUIRED` + `body.x402.accepts` / `payTo`). Exhausted credits → 402 before the engine. Account path: per-account reserve + fencing token + full request digest; in-progress → 409; payload mismatch → 409; committed replay returns the stored result; PAYG meter failure stores meter_pending and remeters on retry. Optional `Idempotency-Key` / validated `X-Request-Id` is the reservation id. Not a self-serve product claim.',
        parameters: [
          {
            name: 'Idempotency-Key',
            in: 'header',
            required: false,
            description:
              'Optional client idempotency key for account-token verify admission. Charset [A-Za-z0-9._:-], length 8–128. Namespaced per account and bound to the full request digest. Echoed as X-Request-Id. In-progress → 409; different payload → 409; committed replay returns the stored result. Two accounts may reuse the same ordinary key. Values that look like secrets (`dqlk_`, `dqla_`, `sk_…`) are rejected (400 INVALID_IDEMPOTENCY_KEY).',
            schema: { type: 'string', minLength: 8, maxLength: 128 },
          },
          {
            name: 'X-Request-Id',
            in: 'header',
            required: false,
            description:
              'Optional client request id used as the reservation id when Idempotency-Key is absent and the value passes the same charset/length checks. Invalid values are ignored and the server generates an id. Echoed on the response X-Request-Id.',
            schema: { type: 'string' },
          },
        ],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/DqlRequest' },
              examples: {
                simple: {
                  summary: 'Minimal request — all five axes',
                  value: {
                    mandate: 'Book me a flight from Berlin to Rome on July 20th, morning departure.',
                    proposed_action:
                      'Book Lufthansa flight LH1234, Munich to Rome, 09:15 departure, on July 20th.',
                    reasoning:
                      'Chose the earliest morning option available in the search results.',
                    context: 'Search returned 5 morning flights BER-FCO on July 20th.',
                  },
                },
                sandbox: {
                  summary: 'Sandbox — deterministic mock, no cost',
                  value: {
                    mandate: 'test mandate',
                    proposed_action: 'test action',
                    reasoning: 'test reasoning',
                    sandbox: true,
                  },
                },
              },
            },
          },
        },
        responses: {
          '200': {
            description: 'Verification complete',
            headers: verifyResponseHeaders,
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/DqlResponse' },
              },
            },
          },
          '400': {
            description: 'Validation failed',
            headers: verifyResponseHeaders,
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/DqlError' },
              },
            },
          },
          '401': {
            description:
              'Missing or invalid account token (`X-DQL-Account` / `Authorization: Bearer dqla_…`). Code `ACCOUNT_UNAUTHORIZED`.',
            headers: verifyResponseHeaders,
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/DqlError' },
              },
            },
          },
          '402': {
            description:
              'Payment required. Unpaid `POST /dql/verify` (no `X-DQL-Key`, no `PAYMENT-SIGNATURE`) returns HTTP 402 with the x402 v2 handshake: header `PAYMENT-REQUIRED` (`payment-required` on the wire) is the base64-encoded challenge, and the JSON body wraps the same object at `x402` (`x402.accepts[]` with `scheme`, `network`, `amount`, `asset`, `payTo`, `resource`). Vanilla `exact` only — Base USDC (`eip155:8453` and alias `base`), $0.05 (amount `50000`, 6dp), no Circle Gateway scheme. Retry with `PAYMENT-SIGNATURE` or a valid API key. Account-token credit exhaustion is a different 402 (`CREDITS_EXHAUSTED`) without this handshake.',
            headers: {
              ...verifyResponseHeaders,
              'PAYMENT-REQUIRED': { $ref: '#/components/headers/PaymentRequired' },
            },
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/X402PaymentRequired' },
                example: {
                  error:
                    'This endpoint requires a valid API key (X-DQL-Key), x402 payment, or sandbox: true.',
                  code: 'PAYMENT_REQUIRED',
                  price_usd_per_call: 0.05,
                  protocol: 'x402',
                  access:
                    'dev-access keys: raul@thoughtproof.ai · stripe: contact for metered key',
                  x402: {
                    x402Version: 2,
                    error: 'Payment required',
                    resource: {
                      url: 'https://dql.thoughtproof.ai/dql/verify',
                      description: 'DQL 5-axis mandate verification — $0.05/call USDC on Base',
                      mimeType: 'application/json',
                    },
                    accepts: [
                      {
                        scheme: 'exact',
                        network: 'eip155:8453',
                        amount: '50000',
                        maxAmountRequired: '50000',
                        asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
                        payTo: '0xAB9f84864662f980614bD1453dB9950Ef2b82E83',
                        resource: 'https://dql.thoughtproof.ai/dql/verify',
                        maxTimeoutSeconds: 300,
                        extra: { name: 'USD Coin', version: '2' },
                      },
                      {
                        scheme: 'exact',
                        network: 'base',
                        amount: '50000',
                        maxAmountRequired: '50000',
                        asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
                        payTo: '0xAB9f84864662f980614bD1453dB9950Ef2b82E83',
                        resource: 'https://dql.thoughtproof.ai/dql/verify',
                        maxTimeoutSeconds: 300,
                        extra: { name: 'USD Coin', version: '2' },
                      },
                    ],
                  },
                },
              },
            },
          },
          '405': {
            description: 'Method not allowed (POST only)',
            headers: verifyResponseHeaders,
          },
          '413': {
            description: 'Payload too large (>1 MB)',
            headers: verifyResponseHeaders,
          },
          '415': {
            description: 'Unsupported media type (must be application/json)',
            headers: verifyResponseHeaders,
          },
          '500': {
            description: 'Internal error',
            headers: verifyResponseHeaders,
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/DqlError' },
              },
            },
          },
          '503': {
            description:
              'Service configuration invalid — cold-start config resolution failed (env override, CB config or provider key). Body carries code=CONFIG_INVALID with a reasons[] array. On this path no diagnostics collector exists: the X-DQL-Diagnostics* headers are ABSENT for the config-invalid 503 (the only deterministically reachable 503 path in d7a8ff6).',
            headers: {
              // R4: NUR die beiden tatsächlich gesetzten Header. Die drei
              // Diagnostics-Header werden hier bewusst NICHT deklariert — der
              // einzige real erreichbare 503-Pfad garantiert ihre Abwesenheit.
              // Spätere Codeänderung → spätere Spec-Erweiterung.
              'X-DQL-Version': { $ref: '#/components/headers/DqlVersion' },
              'X-Request-Id': { $ref: '#/components/headers/DqlRequestId' },
            },
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/DqlConfigError' },
              },
            },
          },
        },
      },
    },
    '/dql/axes': {
      get: {
        operationId: 'dqlAxes',
        summary: 'List the five axes with their questions and failure modes',
        responses: {
          '200': {
            description: 'Axis metadata',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    axes: {
                      type: 'array',
                      items: { $ref: '#/components/schemas/AxisDefinition' },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
    '/dql/health': {
      get: {
        operationId: 'dqlHealth',
        summary: 'Liveness probe with build metadata',
        responses: {
          '200': {
            description: 'Service is up',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    status: { type: 'string', enum: ['ok'] },
                    service: { type: 'string' },
                    version: { type: 'string' },
                    timestamp: { type: 'string', format: 'date-time' },
                  },
                  required: ['status', 'service', 'version', 'timestamp'],
                },
              },
            },
          },
        },
      },
    },
    '/dql/checkout': {
      post: {
        operationId: 'dqlCheckout',
        summary: 'Start Stripe Checkout for a prepaid pack, trial, or PAYG opt-in',
        description:
          'Default OFF (`DQL_CHECKOUT_ENABLED`). Merge does not enable live packs. `pack` is required: `trial` (card bind + first 5 checks, once per email ∪ card fingerprint), `starter` (200 credits), `plus` (1000 credits), or `payg` (opt-in meter, no prepaid credits). Missing pack price env → 503 CHECKOUT_UNAVAILABLE. `no_freemium=true`. Not a live self-serve claim until the flag is on, both pack prices exist, and the ledger is deployed.',
        security: [],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['email', 'pack'],
                properties: {
                  email: { type: 'string', format: 'email' },
                  pack: { type: 'string', enum: ['trial', 'starter', 'plus', 'payg'] },
                },
              },
            },
          },
        },
        responses: {
          '200': {
            description: 'Checkout Session URL',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    url: { type: 'string', format: 'uri' },
                    session_id: { type: 'string' },
                    pack: { type: 'string' },
                    no_freemium: { type: 'boolean' },
                  },
                },
              },
            },
          },
          '400': {
            description: 'Missing/unknown pack or invalid email (`INVALID_REQUEST`)',
          },
          '503': {
            description: 'Checkout disabled (`CHECKOUT_DISABLED`) or pack price missing (`CHECKOUT_UNAVAILABLE`)',
          },
        },
      },
      get: {
        operationId: 'dqlCheckoutReveal',
        summary: 'Reveal the minted API key and account token once',
        description:
          'Query `session_id` (Stripe Checkout Session id). Returns `api_key` (`dqlk_…`) and `account_token` (`dqla_…`) once, plus `key_prefix`, `credits`, `pack`, `trial`, `payg_opt_in`. Replay → 409 KEY_ALREADY_DELIVERED (no key, no token). Does not put secrets in the query string. Account token is not a verify key.',
        security: [],
        parameters: [
          {
            name: 'session_id',
            in: 'query',
            required: true,
            schema: { type: 'string' },
          },
        ],
        responses: {
          '200': {
            description: 'Key and account token shown once',
          },
          '409': {
            description: 'Key already delivered (no key, no token)',
          },
        },
      },
    },
    '/dql/account': {
      get: {
        operationId: 'dqlAccount',
        summary: 'Post-purchase balance and usage',
        description:
          'Auth: `X-DQL-Account` or `Authorization: Bearer dqla_…`. Returns `key_prefix`, `credits`, `trial`, `payg_opt_in`, `usage_today`, `daily_cap`, `email_masked`. Never returns the full verify key. Invalid/missing token → 401. Not a login product. Code exists; Checkout flag stays default off — not a live self-serve claim.',
        security: [{ dqlAccount: [] }],
        responses: {
          '200': { description: 'Account snapshot' },
          '401': { description: 'Missing or invalid account token' },
        },
      },
    },
    '/dql/account/portal': {
      post: {
        operationId: 'dqlAccountPortal',
        summary: 'Create a Stripe Customer Billing Portal session',
        description:
          'Returns `{ url }` for invoice history and payment method. Fail closed (`503 PORTAL_UNAVAILABLE`) if Stripe Customer Portal is not configured.',
        security: [{ dqlAccount: [] }],
        responses: {
          '200': { description: 'Portal URL' },
          '401': { description: 'Missing or invalid account token' },
          '503': { description: 'Portal not configured' },
        },
      },
    },
    '/dql/account/rotate': {
      post: {
        operationId: 'dqlAccountRotate',
        summary: 'Rotate the live verify key',
        description:
          'Issues a new `dqlk_…` once. Old hash is revoked. Credits, PAYG, customer, and account token are preserved.',
        security: [{ dqlAccount: [] }],
        responses: {
          '200': { description: 'New API key shown once' },
          '401': { description: 'Missing or invalid account token' },
        },
      },
    },
    '/dql/account/revoke': {
      post: {
        operationId: 'dqlAccountRevoke',
        summary: 'Revoke the live verify key',
        description: 'Key is dead. Prepaid credits remain unused. Account token is not a verify key.',
        security: [{ dqlAccount: [] }],
        responses: {
          '200': { description: 'Revoked' },
          '401': { description: 'Missing or invalid account token' },
        },
      },
    },
    '/dql/webhooks/stripe': {
      post: {
        operationId: 'dqlStripeWebhook',
        summary: 'Stripe webhook (signature required)',
        security: [],
        responses: {
          '200': { description: 'Received' },
          '400': { description: 'Invalid signature or payload' },
        },
      },
    },
  },
  components: {
    headers: {
      DqlVersion: {
        // S1: Scope-präzise — der /openapi.json-Handler setzt KEINEN
        // X-DQL-Version-Header (nur CORS + Cache-Control). Die Aussage gilt
        // nur für den auditierten Verify-Handler.
        description: 'DQL API build version. Set on every /dql/verify response.',
        schema: { type: 'string', example: '0.2.0' },
      },
      DqlRequestId: {
        description:
          'Request correlation id; identical to DqlResponse.id and DiagnosticsSnapshot.requestId. Echoes a valid client `Idempotency-Key` or `X-Request-Id` when present; otherwise a server-generated `dql_…` id. Used as the account-path reservation id.',
        schema: {
          // R3: opaker String-Vertrag, KEIN pattern — der Generator kann im
          // Randfall (Math.random() === 0) einen leeren Suffix erzeugen.
          type: 'string',
          description: 'Opaque request id (client idempotency key or server-generated dql_ prefix).',
          example: 'dql_abc123_x7k9p2',
        },
      },
      DqlDiagnostics: {
        description:
          'Present when the runtime is a valid pot-cli production bundle AND DQL_RUNTIME_DIAGNOSTICS=1 AND the serialized snapshot fits in 8_192 bytes UTF-8. DQL_V0431_ACTIVE is NOT part of the emission condition (it merely requires diagnostics via config validation). An empty collector still emits this header with five empty streams. Absent on the config-invalid 503 path and on OPTIONS preflight. Value: JSON-encoded DiagnosticsSnapshot (see components.schemas.DiagnosticsSnapshot).',
        schema: {
          type: 'string',
          contentMediaType: 'application/json',
          description: 'JSON-encoded DiagnosticsSnapshot',
        },
      },
      DqlDiagnosticsTruncated: {
        description:
          'Present INSTEAD OF X-DQL-Diagnostics when the serialized snapshot exceeds the 8_192-byte header cap. Literal "1". Consumers MUST fall back to X-DQL-Diagnostics-Counts for retained/dropped counts.',
        schema: { type: 'string', enum: ['1'] },
      },
      DqlDiagnosticsCounts: {
        description:
          'Present together with X-DQL-Diagnostics-Truncated: 1. JSON-encoded DiagnosticsTruncationCounts (see components.schemas.DiagnosticsTruncationCounts): retained count per stream plus dropped count per stream. Contract: every stream appears in BOTH top-level and dropped — a missing key never encodes a valid count.',
        schema: {
          type: 'string',
          contentMediaType: 'application/json',
          description: 'JSON-encoded DiagnosticsTruncationCounts',
        },
      },
      PaymentRequired: {
        description:
          'x402 `PAYMENT-REQUIRED` handshake. Base64-encoded x402 v2 challenge JSON — the same object as `body.x402` (version, resource, `accepts[]` with `scheme`/`network`/`amount`/`asset`/`payTo`). Live HTTP/2 header name is `payment-required`. Vanilla `exact` on Base USDC only; no Circle Gateway scheme.',
        schema: {
          type: 'string',
          description: 'Base64-encoded x402 v2 PaymentRequired challenge',
        },
      },
    },
    securitySchemes: {
      dqlKey: {
        type: 'apiKey',
        in: 'header',
        name: 'X-DQL-Key',
        description:
          'DQL API key (`dqlk_…`). Dev-access keys are granted manually (free). Self-serve keys are billable ($0.05/call) when Checkout is enabled. Alias: Authorization: Bearer dqlk_…. Contact support@thoughtproof.ai for dev access. Account tokens (`dqla_…`) are not accepted on this header — use `X-DQL-Account`.',
      },
      dqlAccount: {
        type: 'apiKey',
        in: 'header',
        name: 'X-DQL-Account',
        description:
          'Post-purchase account session (`dqla_…`). Shown once on checkout reveal. Alias: Authorization: Bearer dqla_…. Authorizes `/dql/account` and `POST /dql/verify` (credits billed to the bound ledger; response never includes `dqlk_…`). Not accepted as `X-DQL-Key`. Not a login product.',
      },
    },
    schemas: {
      Axis: {
        type: 'string',
        enum: ['intent', 'scope', 'risk', 'consistency', 'reversibility'],
      },
      AxisVerdict: { type: 'string', enum: ['PASS', 'FAIL', 'UNCERTAIN'] },
      AggregateVerdict: { type: 'string', enum: ['ALLOW', 'BLOCK', 'REVIEW'] },
      DqlRequest: {
        type: 'object',
        required: ['mandate', 'proposed_action', 'reasoning'],
        properties: {
          mandate: {
            type: 'string',
            description: 'The user’s stated goal / instruction the agent is acting on.',
            maxLength: 20000,
          },
          proposed_action: {
            type: 'string',
            description: 'The action or decision the agent proposes to take.',
            maxLength: 20000,
          },
          reasoning: {
            type: 'string',
            description: 'The agent’s own reasoning / plan for the action.',
            maxLength: 20000,
          },
          context: {
            type: 'string',
            description:
              'Optional extra evidence, tool outputs, or prior conversation turns available to the agent.',
            maxLength: 20000,
          },
          structured_context: {
            $ref: '#/components/schemas/DqlStructuredContext',
            description:
              'Optional machine-readable fields for the deterministic structural pre-check (ADR-0020). Free-text context is never parsed for this. Incomplete field pairs stay silent (fail-toward-silence). Trust boundary: granted.* MUST be principal-/platform-supplied (session, rail, host policy) — not agent-asserted; agent-controlled granted fields make the gate bypassable (omit → silent).',
          },
          gate_mode: {
            type: 'string',
            enum: ['shadow', 'enforce'],
            default: 'shadow',
            description:
              "Structural pre-check rollout mode (ADR-0020). 'shadow' (default): compute + attach response.structural, still run the cascade. 'enforce': hard binary violations short-circuit to BLOCK before the LLM cascade.",
          },
          axes: {
            type: 'array',
            items: { $ref: '#/components/schemas/Axis' },
            description:
              'Optional subset of axes to evaluate. Defaults to all five. Order is preserved in the response.',
          },
          sandbox: {
            type: 'boolean',
            description:
              'If true, returns a deterministic mock response without running the cascade. Free. Useful for integration tests.',
            default: false,
          },
        },
      },
      DqlStructuredContext: {
        type: 'object',
        additionalProperties: false,
        properties: {
          granted: {
            type: 'object',
            additionalProperties: false,
            properties: {
              max_amount: { type: 'number' },
              amount_currency: { type: 'string' },
              recipient: { type: 'string' },
              iban: { type: 'string' },
              allow_unlimited: { type: 'boolean' },
            },
          },
          proposed: {
            type: 'object',
            additionalProperties: false,
            properties: {
              amount: { type: 'number' },
              amount_currency: { type: 'string' },
              recipient: { type: 'string' },
              iban: { type: 'string' },
              allowance: {
                oneOf: [{ type: 'number' }, { type: 'string' }],
                description: 'Exact allowance, or unlimited sentinels (unlimited, MAX_UINT256, hex).',
              },
            },
          },
          history: {
            type: 'object',
            additionalProperties: false,
            properties: {
              past_payments_to_same_counterparty: { type: 'number' },
              amount_variance_from_history: {
                type: 'number',
                description: 'Relative deviation, e.g. 0.02 = 2%. Hard break only with ≥3 prior payments.',
              },
            },
          },
        },
      },
      StructuralField: {
        type: 'object',
        required: ['mode', 'would_block', 'enforced', 'silent', 'violations'],
        additionalProperties: false,
        properties: {
          mode: { type: 'string', enum: ['shadow', 'enforce'] },
          would_block: { type: 'boolean' },
          enforced: { type: 'boolean' },
          silent: { type: 'boolean' },
          violations: {
            type: 'array',
            items: {
              type: 'object',
              required: ['kind', 'detail'],
              additionalProperties: false,
              properties: {
                kind: {
                  type: 'string',
                  enum: [
                    'amount_overshoot',
                    'recipient_mismatch',
                    'iban_mismatch',
                    'unlimited_approval',
                    'history_variance_break',
                  ],
                },
                detail: { type: 'string' },
              },
            },
          },
        },
      },
      AxisResult: {
        type: 'object',
        required: ['axis', 'verdict', 'confidence', 'reasoning', 'objection'],
        properties: {
          axis: { $ref: '#/components/schemas/Axis' },
          verdict: { $ref: '#/components/schemas/AxisVerdict' },
          confidence: {
            type: 'number',
            minimum: 0,
            maximum: 1,
            description: 'Model confidence in the per-axis verdict.',
          },
          reasoning: {
            type: 'string',
            description: 'Short human-readable reasoning for the verdict.',
          },
          objection: {
            type: 'string',
            description:
              'Concrete objection when verdict is FAIL or UNCERTAIN. Empty string on PASS.',
          },
          provider_route: {
            type: 'string',
            enum: ['primary', 'fallback'],
            description:
              "Which route actually served the underlying model calls for this axis. Present only when a route served a response (provider_outcome='served'). Absent when no provider served — fail-closed axes are never attributed to a route. Optional field; older readers see no behavior change.",
          },
          provider_outcome: {
            type: 'string',
            enum: ['served', 'circuit_rejected', 'provider_error'],
            description:
              "Outcome classification for the provider chain on this axis. 'served' — some route (primary or fallback) returned a response; provider_route names which one. 'circuit_rejected' — NO provider fetch was started (circuit breaker rejected before any network I/O); provider_route is absent. 'provider_error' — at least one provider fetch was started but no route ultimately served a response; provider_route is absent. Optional: omitted when not applicable (e.g. sandbox path, legacy responses).",
          },
        },
      },
      AggregateResult: {
        type: 'object',
        required: ['verdict', 'confidence', 'triggered_by', 'rationale'],
        properties: {
          verdict: { $ref: '#/components/schemas/AggregateVerdict' },
          confidence: { type: 'number', minimum: 0, maximum: 1 },
          triggered_by: {
            type: 'array',
            items: { $ref: '#/components/schemas/Axis' },
            description: 'Axes that pushed the aggregate away from ALLOW (empty on ALLOW).',
          },
          rationale: {
            type: 'string',
            description: 'One-sentence explanation of why the aggregate is what it is.',
          },
        },
      },
      DqlResponse: {
        type: 'object',
        required: ['id', 'version', 'axes', 'aggregate', 'meta'],
        properties: {
          id: { type: 'string', description: 'Request id (echoed in X-Request-Id).' },
          version: { type: 'string' },
          axes: {
            type: 'array',
            items: { $ref: '#/components/schemas/AxisResult' },
          },
          aggregate: { $ref: '#/components/schemas/AggregateResult' },
          structural: {
            $ref: '#/components/schemas/StructuralField',
            description:
              'Deterministic structural pre-check artifact (ADR-0020). Present after engine run. In shadow mode enforced=false and axes/aggregate still come from the cascade. Optional for older clients.',
          },
          meta: {
            type: 'object',
            required: ['duration_ms', 'models_used', 'axes_evaluated', 'sandbox'],
            properties: {
              duration_ms: { type: 'integer', minimum: 0 },
              models_used: {
                type: 'array',
                items: { type: 'string' },
                description:
                  'Concrete provider:model identifiers the cascade actually invoked, e.g. "serv:serv-nano".',
              },
              axes_evaluated: {
                type: 'array',
                items: { $ref: '#/components/schemas/Axis' },
              },
              sandbox: { type: 'boolean' },
            },
          },
        },
      },
      AxisDefinition: {
        type: 'object',
        required: ['axis', 'question', 'failure_mode'],
        properties: {
          axis: { $ref: '#/components/schemas/Axis' },
          question: { type: 'string' },
          failure_mode: { type: 'string' },
        },
      },
      DqlError: {
        type: 'object',
        required: ['error', 'code'],
        properties: {
          error: { type: 'string' },
          code: { type: 'string' },
          details: {},
        },
      },
      DqlConfigError: {
        type: 'object',
        required: ['error', 'code', 'reasons'],
        additionalProperties: false,
        properties: {
          error: { type: 'string' },
          code: { type: 'string', const: 'CONFIG_INVALID' },
          reasons: { type: 'array', items: { type: 'string' } },
        },
        description:
          'Body of 503 Service Unavailable when cold-start config resolution failed. reasons lists every validation failure collected by the resolver.',
      },
      X402PaymentRequired: {
        type: 'object',
        required: ['error', 'code', 'protocol', 'x402'],
        description:
          'Unpaid 402 body for POST /dql/verify. Wrapper plus standard `x402` challenge. `x402.accepts` is the machine-readable price list (`payTo`, `amount`, `asset`, `network`). Matches the live unpaid handshake; vanilla x402 `exact` only.',
        properties: {
          error: { type: 'string' },
          code: { type: 'string', const: 'PAYMENT_REQUIRED' },
          price_usd_per_call: {
            type: 'number',
            const: 0.05,
            description: 'USD price per verify call. USDC 6dp amount is 50000.',
          },
          protocol: { type: 'string', const: 'x402' },
          access: { type: 'string' },
          x402: { $ref: '#/components/schemas/X402Challenge' },
        },
      },
      X402Challenge: {
        type: 'object',
        required: ['x402Version', 'accepts'],
        description:
          'x402 v2 challenge (also the decoded `PAYMENT-REQUIRED` header). Two `accepts` rows: CAIP-2 `eip155:8453` and alias `base`, same price and wallet.',
        properties: {
          x402Version: { type: 'integer', const: 2 },
          error: { type: 'string' },
          resource: {
            type: 'object',
            properties: {
              url: { type: 'string', format: 'uri', example: 'https://dql.thoughtproof.ai/dql/verify' },
              description: { type: 'string' },
              mimeType: { type: 'string', example: 'application/json' },
            },
          },
          accepts: {
            type: 'array',
            minItems: 2,
            description:
              'Vanilla x402 `exact` accepts only (no Circle Gateway). Same amount/asset/payTo on `eip155:8453` and `base`.',
            items: { $ref: '#/components/schemas/X402Accept' },
          },
        },
      },
      X402Accept: {
        type: 'object',
        required: ['scheme', 'network', 'amount', 'asset', 'payTo', 'resource'],
        description:
          'One x402 payment option. Production: scheme=exact, amount=50000 ($0.05 USDC 6dp), asset=Base USDC, payTo=0xAB9f84864662f980614bD1453dB9950Ef2b82E83, resource=https://dql.thoughtproof.ai/dql/verify.',
        properties: {
          scheme: {
            type: 'string',
            const: 'exact',
            description: 'Vanilla x402 exact scheme. No Gateway / extra rails.',
          },
          network: {
            type: 'string',
            enum: ['eip155:8453', 'base'],
            description: 'Base mainnet CAIP-2 (`eip155:8453`) or the `base` alias. Same price/wallet on both rows.',
          },
          amount: {
            type: 'string',
            const: '50000',
            description: 'Atomic USDC (6 decimals). 50000 = $0.05.',
            example: '50000',
          },
          maxAmountRequired: {
            type: 'string',
            const: '50000',
            description: 'x402 v1 alias of `amount`. Same 50000 ($0.05 USDC).',
          },
          asset: {
            type: 'string',
            const: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
            description: 'USDC on Base.',
            example: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
          },
          payTo: {
            type: 'string',
            const: '0xAB9f84864662f980614bD1453dB9950Ef2b82E83',
            description: 'Seller wallet. Same as the live unpaid handshake; do not rotate.',
            example: '0xAB9f84864662f980614bD1453dB9950Ef2b82E83',
          },
          resource: {
            type: 'string',
            format: 'uri',
            const: 'https://dql.thoughtproof.ai/dql/verify',
            example: 'https://dql.thoughtproof.ai/dql/verify',
          },
          maxTimeoutSeconds: { type: 'integer', const: 300 },
          extra: {
            type: 'object',
            properties: {
              name: { type: 'string', example: 'USD Coin' },
              version: { type: 'string', example: '2' },
            },
          },
        },
      },
      FailureCategory: {
        type: 'string',
        enum: ['timeout', 'rate_limit', 'network', 'server_5xx', 'client_4xx', 'parse', 'other'],
        description:
          'Bounded failure taxonomy for AttemptEvent.errorCategory. Raw provider error text is never included in RuntimeDiagnostics fields (this guarantee does not extend to existing error bodies or AxisResult.objection).',
      },
      AttemptRoute: {
        type: 'string',
        enum: ['primary', 'fallback'],
        description:
          'Whether the recorded attempt used the primary binding or the fallback binding of the cascade.',
      },
      AttemptEvent: {
        type: 'object',
        required: ['requestId', 'requestedAlias', 'attemptAlias', 'route', 'iteration', 'ok', 'elapsedMs'],
        additionalProperties: false,
        properties: {
          requestId: { type: 'string', description: 'Handler-owned request id (== X-Request-Id).' },
          axis: { type: 'string', description: 'Present when the parent CallContext has an axis fork.' },
          callId: { type: 'string', description: 'Present when the parent CallContext has a per-axis callId.' },
          requestedAlias: { type: 'string', description: 'Alias the cascade asked for (e.g. serv-nano).' },
          attemptAlias: { type: 'string', description: 'Alias actually invoked (may differ from requestedAlias on fallback).' },
          route: { $ref: '#/components/schemas/AttemptRoute' },
          iteration: { type: 'integer', minimum: 1, description: 'Retry iteration index of this ACTUAL provider fetch, starting at 1.' },
          ok: { type: 'boolean' },
          elapsedMs: { type: 'number', minimum: 0, description: 'Wall-clock ms for this single fetch iteration.' },
          errorCategory: { $ref: '#/components/schemas/FailureCategory', description: 'Present iff ok===false.' },
        },
      },
      BindingSummary: {
        type: 'object',
        required: ['requestId', 'requestedAlias', 'attemptAlias', 'route', 'ok', 'netLatencyMs', 'backoffWaitedMs', 'wallClockMs', 'attemptCount'],
        additionalProperties: false,
        properties: {
          requestId: { type: 'string' },
          axis: { type: 'string' },
          callId: { type: 'string' },
          requestedAlias: { type: 'string' },
          attemptAlias: { type: 'string' },
          route: { $ref: '#/components/schemas/AttemptRoute' },
          ok: { type: 'boolean', description: 'True iff the last iteration succeeded.' },
          netLatencyMs: { type: 'number', minimum: 0, description: 'wallClockMs − backoffWaitedMs.' },
          backoffWaitedMs: { type: 'number', minimum: 0, description: 'Sum of backoff sleeps across all retry iterations of this binding.' },
          wallClockMs: { type: 'number', minimum: 0 },
          attemptCount: { type: 'integer', minimum: 1, description: 'Iterations executed (≥1, ≤maxAttempts).' },
        },
      },
      // O8: Event-Schemas vollständig — Enums abgeschlossen aus circuit-breaker.ts (d7a8ff6).
      TransitionEvent: {
        oneOf: [
          {
            type: 'object',
            required: ['kind', 'reason', 'alias', 'from', 'to', 'at', 'tripGeneration', 'stateRevision'],
            additionalProperties: false,
            properties: {
              kind: { type: 'string', const: 'closed_to_open' },
              reason: { type: 'string', enum: ['failure_rate', 'latency'] },
              alias: { type: 'string' },
              from: { type: 'string', const: 'CLOSED' },
              to: { type: 'string', const: 'OPEN' },
              at: { type: 'number', minimum: 0, description: 'Epoch ms.' },
              tripGeneration: { type: 'integer', minimum: 0 },
              stateRevision: { type: 'integer', minimum: 0 },
            },
          },
          {
            type: 'object',
            required: ['kind', 'alias', 'from', 'to', 'at', 'tripGeneration', 'recoveryEpoch', 'probeSequence', 'stateRevision'],
            additionalProperties: false,
            properties: {
              kind: { type: 'string', const: 'open_to_half_open' },
              alias: { type: 'string' },
              from: { type: 'string', const: 'OPEN' },
              to: { type: 'string', const: 'HALF_OPEN' },
              at: { type: 'number', minimum: 0 },
              tripGeneration: { type: 'integer', minimum: 0 },
              recoveryEpoch: { type: 'integer', minimum: 0 },
              probeSequence: { type: 'integer', minimum: 0 },
              stateRevision: { type: 'integer', minimum: 0 },
            },
          },
          {
            type: 'object',
            required: ['kind', 'reason', 'alias', 'from', 'to', 'at', 'tripGeneration', 'recoveryEpoch', 'probeSequence', 'stateRevision'],
            additionalProperties: false,
            properties: {
              kind: { type: 'string', const: 'half_open_to_open' },
              reason: { type: 'string', enum: ['probe_failed', 'probe_slow'] },
              alias: { type: 'string' },
              from: { type: 'string', const: 'HALF_OPEN' },
              to: { type: 'string', const: 'OPEN' },
              at: { type: 'number', minimum: 0 },
              tripGeneration: { type: 'integer', minimum: 0 },
              recoveryEpoch: { type: 'integer', minimum: 0 },
              probeSequence: { type: 'integer', minimum: 0 },
              stateRevision: { type: 'integer', minimum: 0 },
            },
          },
          {
            type: 'object',
            required: ['kind', 'alias', 'from', 'to', 'at', 'tripGeneration', 'recoveryEpoch', 'probeSequence', 'closedEpoch', 'stateRevision'],
            additionalProperties: false,
            properties: {
              kind: { type: 'string', const: 'half_open_to_closed' },
              alias: { type: 'string' },
              from: { type: 'string', const: 'HALF_OPEN' },
              to: { type: 'string', const: 'CLOSED' },
              at: { type: 'number', minimum: 0 },
              tripGeneration: { type: 'integer', minimum: 0 },
              recoveryEpoch: { type: 'integer', minimum: 0 },
              probeSequence: { type: 'integer', minimum: 0 },
              closedEpoch: { type: 'integer', minimum: 0 },
              stateRevision: { type: 'integer', minimum: 0 },
            },
          },
        ],
        description:
          'Circuit-breaker state transition. Discriminated by kind — the four kinds form a closed vocabulary: closed_to_open, open_to_half_open, half_open_to_open, half_open_to_closed.',
      },
      StaleResultEvent: {
        type: 'object',
        required: ['kind', 'reason', 'alias', 'at', 'stateRevision'],
        additionalProperties: false,
        properties: {
          kind: { type: 'string', const: 'stale_result' },
          reason: { type: 'string', enum: ['invalid_token', 'already_consumed', 'wrong_state', 'wrong_epoch', 'wrong_generation'] },
          alias: { type: 'string' },
          at: { type: 'number', minimum: 0, description: 'Epoch ms.' },
          stateRevision: { type: 'integer', minimum: 0 },
        },
      },
      InvalidOutcomeEvent: {
        type: 'object',
        required: ['kind', 'reason', 'alias', 'at', 'stateRevision'],
        additionalProperties: false,
        properties: {
          kind: { type: 'string', const: 'invalid_outcome' },
          reason: { type: 'string', enum: ['nan_latency', 'infinite_latency', 'negative_latency'] },
          alias: { type: 'string' },
          at: { type: 'number', minimum: 0, description: 'Epoch ms.' },
          stateRevision: { type: 'integer', minimum: 0 },
        },
      },
      DiagnosticsSnapshot: {
        type: 'object',
        required: ['requestId', 'transitions', 'stale_results', 'invalid_outcomes', 'attempts', 'binding_summaries'],
        additionalProperties: false,
        properties: {
          requestId: { type: 'string', description: 'camelCase — identical to X-Request-Id and DqlResponse.id.' },
          transitions: {
            type: 'object',
            required: ['items', 'dropped'],
            additionalProperties: false,
            properties: {
              items: { type: 'array', items: { $ref: '#/components/schemas/TransitionEvent' } },
              dropped: { type: 'integer', minimum: 0 },
            },
          },
          stale_results: {
            type: 'object',
            required: ['items', 'dropped'],
            additionalProperties: false,
            properties: {
              items: { type: 'array', items: { $ref: '#/components/schemas/StaleResultEvent' } },
              dropped: { type: 'integer', minimum: 0 },
            },
          },
          invalid_outcomes: {
            type: 'object',
            required: ['items', 'dropped'],
            additionalProperties: false,
            properties: {
              items: { type: 'array', items: { $ref: '#/components/schemas/InvalidOutcomeEvent' } },
              dropped: { type: 'integer', minimum: 0 },
            },
          },
          attempts: {
            type: 'object',
            required: ['items', 'dropped'],
            additionalProperties: false,
            properties: {
              items: { type: 'array', items: { $ref: '#/components/schemas/AttemptEvent' } },
              dropped: { type: 'integer', minimum: 0 },
            },
          },
          binding_summaries: {
            type: 'object',
            required: ['items', 'dropped'],
            additionalProperties: false,
            properties: {
              items: { type: 'array', items: { $ref: '#/components/schemas/BindingSummary' } },
              dropped: { type: 'integer', minimum: 0 },
            },
          },
        },
        description:
          // S2: Freeze ist eine serverseitige Integritätseigenschaft vor der
          // Serialisierung — sie überlebt die Header-Serialisierung nicht.
          'JSON-encoded body of X-DQL-Diagnostics. All five streams are always present; each stream is a bounded ring buffer (oldest dropped first) with a per-stream dropped counter. The server freezes snapshot items and arrays before serialization. This is a server-side integrity property; JSON decoded by a consumer is not technically frozen. Consumers should treat the decoded snapshot as read-only contract data. May carry five empty streams (empty collector is still flushed).',
      },
      DiagnosticsTruncationCounts: {
        type: 'object',
        required: ['transitions', 'stale_results', 'invalid_outcomes', 'attempts', 'binding_summaries', 'dropped'],
        additionalProperties: false,
        properties: {
          transitions: { type: 'integer', minimum: 0 },
          stale_results: { type: 'integer', minimum: 0 },
          invalid_outcomes: { type: 'integer', minimum: 0 },
          attempts: { type: 'integer', minimum: 0 },
          binding_summaries: { type: 'integer', minimum: 0 },
          dropped: {
            type: 'object',
            required: ['transitions', 'stale_results', 'invalid_outcomes', 'attempts', 'binding_summaries'],
            additionalProperties: false,
            properties: {
              transitions: { type: 'integer', minimum: 0 },
              stale_results: { type: 'integer', minimum: 0 },
              invalid_outcomes: { type: 'integer', minimum: 0 },
              attempts: { type: 'integer', minimum: 0 },
              binding_summaries: { type: 'integer', minimum: 0 },
            },
          },
        },
        description:
          'Body of X-DQL-Diagnostics-Counts. Every stream appears in BOTH top-level and dropped — a missing key never encodes a valid count.',
      },
    },
  },
};

export default function handler(_req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'public, max-age=3600');
  return res.status(200).json(spec);
}
