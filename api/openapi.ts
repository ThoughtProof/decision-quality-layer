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

const spec = {
  openapi: '3.1.0',
  info: {
    title: 'ThoughtProof Decision Quality Layer (DQL) API',
    description:
      'Five-axis reasoning verification for AI agents. Each axis (intent, scope, risk, consistency, reversibility) is evaluated independently; the response returns per-axis verdicts plus an aggregate verdict. Cross-model cascade (serv-nano → serv-swift). Companion product to Sentinel — where Sentinel returns one verdict per call, DQL returns five so callers know which dimension of the decision is weak.',
    version: '0.2.0',
    guidance:
      'POST /dql/verify with (mandate, proposed_action, reasoning, context?) to receive per-axis verdicts plus an aggregate. Set `sandbox: true` in the body for a free deterministic mock response — useful for integration testing against the schema. GET /dql/axes for axis metadata (question and failure mode per axis). Payment (Stripe metered + x402 on Base) lands in a later release; for now DQL is dev-access on request.',
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
  security: [{ dqlKey: [] }, {}],
  paths: {
    '/dql/verify': {
      post: {
        operationId: 'dqlVerify',
        summary: 'Verify a proposed agent action across five axes',
        description:
          'Runs the requested axes in parallel through the serv-nano → serv-swift cascade. Returns per-axis verdicts (PASS / FAIL / UNCERTAIN with confidence and objection) and an aggregate verdict (ALLOW / BLOCK / REVIEW). Aggregation rules are pre-registered and documented in docs/ARCHITECTURE.md.',
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
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/DqlResponse' },
              },
            },
          },
          '400': {
            description: 'Validation failed',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/DqlError' },
              },
            },
          },
          '405': {
            description: 'Method not allowed (POST only)',
          },
          '413': {
            description: 'Payload too large (>1 MB)',
          },
          '415': {
            description: 'Unsupported media type (must be application/json)',
          },
          '500': {
            description: 'Internal error',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/DqlError' },
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
  },
  components: {
    securitySchemes: {
      dqlKey: {
        type: 'apiKey',
        in: 'header',
        name: 'X-DQL-Key',
        description:
          'Dev-access API key. Payment gates (Stripe metered + x402 on Base) will replace / augment this in a later release. Contact support@thoughtproof.ai for dev access.',
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
            maxLength: 100000,
          },
          proposed_action: {
            type: 'string',
            description: 'The action or decision the agent proposes to take.',
            maxLength: 100000,
          },
          reasoning: {
            type: 'string',
            description: 'The agent’s own reasoning / plan for the action.',
            maxLength: 100000,
          },
          context: {
            type: 'string',
            description:
              'Optional extra evidence, tool outputs, or prior conversation turns available to the agent.',
            maxLength: 100000,
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
          meta: {
            type: 'object',
            required: ['duration_ms', 'models_used', 'axes_evaluated', 'sandbox'],
            properties: {
              duration_ms: { type: 'integer', minimum: 0 },
              models_used: {
                type: 'array',
                items: { type: 'string' },
                description:
                  'Concrete provider:model identifiers the cascade actually invoked, e.g. "openai:gpt-4o-mini".',
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
    },
  },
};

export default function handler(_req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'public, max-age=3600');
  return res.status(200).json(spec);
}
