/**
 * Spec-Tests — validate the OpenAPI structure served by the /openapi.json
 * handler against the wire contract of d7a8ff6 (v5 OpenAPI delta, approved).
 *
 * Mechanics (R5, v5 §6): the test invokes the handler with a response double
 * and inspects the JSON it would serve — no `spec` export, no runtime-code
 * delta. The enum literals below are AUDITED EXPECTATION VALUES from the live
 * d7a8ff6 audit (v5 delta §3): `MAX_FIELD_LENGTH` is not exported from
 * src/validation.ts, and FailureCategory / the circuit-event unions are pure
 * TypeScript types with no runtime representation — so the literals are
 * pinned here. Synchronized drift on both sides is NOT auto-discriminated;
 * that residual risk is covered by the single-source follow-up (v5 §0b).
 */

import { describe, it, expect } from 'vitest';
import handler from './openapi';

type AnyObj = Record<string, any>;

function serveSpec(): { status: number; spec: AnyObj } {
  let status = 0;
  let body: AnyObj | undefined;
  const res: AnyObj = {
    setHeader: () => res,
    status: (c: number) => {
      status = c;
      return res;
    },
    json: (b: unknown) => {
      body = b as AnyObj;
      return res;
    },
  };
  handler({} as never, res as never);
  if (!body) throw new Error('handler did not call res.json()');
  return { status, spec: body };
}

const { status, spec } = serveSpec();
const schemas: AnyObj = spec.components.schemas;
const headers: AnyObj = spec.components.headers;
const verifyResponses: AnyObj = spec.paths['/dql/verify'].post.responses;

/** Statuses the verify handler produces itself (diagnostics-capable). */
const HANDLER_STATUSES = ['200', '400', '405', '413', '415', '500'] as const;

const FIVE_STREAMS = [
  'transitions',
  'stale_results',
  'invalid_outcomes',
  'attempts',
  'binding_summaries',
] as const;

describe('openapi handler basics', () => {
  it('serves HTTP 200 with an OpenAPI 3.1 document', () => {
    expect(status).toBe(200);
    expect(spec.openapi).toBe('3.1.0');
  });

  it('info carries x-guidance, not the 3.1-invalid bare guidance key', () => {
    // Bare `guidance` fails strict OpenAPI 3.1 validation
    // (unevaluatedProperties on the info object) — §7.5 gate.
    expect(spec.info['x-guidance']).toBeTypeOf('string');
    expect(spec.info.guidance).toBeUndefined();
  });

  it('resolves every $ref in the document', () => {
    const refs: string[] = [];
    const walk = (node: unknown): void => {
      if (Array.isArray(node)) return node.forEach(walk);
      if (node && typeof node === 'object') {
        for (const [k, v] of Object.entries(node as AnyObj)) {
          if (k === '$ref' && typeof v === 'string') refs.push(v);
          else walk(v);
        }
      }
    };
    walk(spec);
    expect(refs.length).toBeGreaterThan(0);
    for (const ref of refs) {
      expect(ref.startsWith('#/')).toBe(true);
      const target = ref
        .slice(2)
        .split('/')
        .reduce((acc: AnyObj | undefined, part) => acc?.[part], spec);
      expect(target, `unresolved $ref: ${ref}`).toBeDefined();
    }
  });
});

describe('response headers on POST /dql/verify', () => {
  it('declares all five headers on every handler-produced status', () => {
    for (const code of HANDLER_STATUSES) {
      const h = verifyResponses[code]?.headers;
      expect(h, `missing headers block on ${code}`).toBeDefined();
      expect(Object.keys(h).sort()).toEqual(
        [
          'X-DQL-Diagnostics',
          'X-DQL-Diagnostics-Counts',
          'X-DQL-Diagnostics-Truncated',
          'X-DQL-Version',
          'X-Request-Id',
        ].sort(),
      );
    }
  });

  it('503 declares ONLY X-DQL-Version + X-Request-Id — no diagnostics headers (R4)', () => {
    const h = verifyResponses['503']?.headers;
    expect(h).toBeDefined();
    expect(Object.keys(h).sort()).toEqual(['X-DQL-Version', 'X-Request-Id']);
  });

  it('503 body is DqlConfigError', () => {
    expect(verifyResponses['503'].content['application/json'].schema.$ref).toBe(
      '#/components/schemas/DqlConfigError',
    );
  });

  it('JSON headers are modeled as string + contentMediaType, never format:json or object $ref', () => {
    for (const name of ['DqlDiagnostics', 'DqlDiagnosticsCounts']) {
      const s = headers[name].schema;
      expect(s.type).toBe('string');
      expect(s.contentMediaType).toBe('application/json');
      expect(s.format).toBeUndefined();
      expect(s.$ref).toBeUndefined();
    }
  });

  it('X-DQL-Diagnostics-Truncated is the literal "1"', () => {
    expect(headers.DqlDiagnosticsTruncated.schema).toMatchObject({
      type: 'string',
      enum: ['1'],
    });
  });

  it('DqlRequestId is an opaque string contract without pattern (R3)', () => {
    const s = headers.DqlRequestId.schema;
    expect(s.type).toBe('string');
    expect(s.pattern).toBeUndefined();
  });
});

describe('DqlConfigError (503 CONFIG_INVALID body)', () => {
  it('has exactly {error, code, reasons} — closed, no details', () => {
    const s = schemas.DqlConfigError;
    expect(s.required.sort()).toEqual(['code', 'error', 'reasons']);
    expect(Object.keys(s.properties).sort()).toEqual(['code', 'error', 'reasons']);
    expect(s.properties.details).toBeUndefined();
    expect(s.additionalProperties).toBe(false);
    expect(s.properties.code.const).toBe('CONFIG_INVALID');
    expect(s.properties.reasons).toMatchObject({ type: 'array', items: { type: 'string' } });
  });

  it('generic DqlError keeps its details escape hatch (other error paths)', () => {
    expect(Object.keys(schemas.DqlError.properties)).toContain('details');
  });
});

describe('bounded enum vocabularies (audited from d7a8ff6)', () => {
  it('FailureCategory has exactly 7 values', () => {
    expect(schemas.FailureCategory.enum.sort()).toEqual(
      ['client_4xx', 'network', 'other', 'parse', 'rate_limit', 'server_5xx', 'timeout'].sort(),
    );
  });

  it('AttemptRoute has exactly 2 values', () => {
    expect(schemas.AttemptRoute.enum.sort()).toEqual(['fallback', 'primary']);
  });

  it('TransitionEvent has exactly the 4 kinds, each a closed object', () => {
    const branches: AnyObj[] = schemas.TransitionEvent.oneOf;
    expect(branches).toHaveLength(4);
    const kinds = branches.map((b) => b.properties.kind.const).sort();
    expect(kinds).toEqual(
      ['closed_to_open', 'half_open_to_closed', 'half_open_to_open', 'open_to_half_open'].sort(),
    );
    for (const b of branches) {
      expect(b.additionalProperties).toBe(false);
      expect(b.required.sort()).toEqual(Object.keys(b.properties).sort());
    }
  });

  it('per-kind reason vocabularies are closed', () => {
    const byKind = Object.fromEntries(
      schemas.TransitionEvent.oneOf.map((b: AnyObj) => [b.properties.kind.const, b]),
    );
    expect(byKind.closed_to_open.properties.reason.enum.sort()).toEqual(
      ['failure_rate', 'latency'].sort(),
    );
    expect(byKind.half_open_to_open.properties.reason.enum.sort()).toEqual(
      ['probe_failed', 'probe_slow'].sort(),
    );
    expect(byKind.open_to_half_open.properties.reason).toBeUndefined();
    expect(byKind.half_open_to_closed.properties.reason).toBeUndefined();
  });

  it('StaleResultEvent has exactly 5 reasons', () => {
    expect(schemas.StaleResultEvent.properties.reason.enum.sort()).toEqual(
      ['already_consumed', 'invalid_token', 'wrong_epoch', 'wrong_generation', 'wrong_state'].sort(),
    );
  });

  it('InvalidOutcomeEvent has exactly 3 reasons', () => {
    expect(schemas.InvalidOutcomeEvent.properties.reason.enum.sort()).toEqual(
      ['infinite_latency', 'nan_latency', 'negative_latency'].sort(),
    );
  });
});

describe('closed item schemas (additionalProperties: false)', () => {
  it.each(['AttemptEvent', 'BindingSummary', 'StaleResultEvent', 'InvalidOutcomeEvent'])(
    '%s is closed',
    (name) => {
      expect(schemas[name].additionalProperties).toBe(false);
    },
  );

  it('AttemptEvent has the exact required set and optional axis/callId/errorCategory', () => {
    const s = schemas.AttemptEvent;
    expect(s.required.sort()).toEqual(
      ['attemptAlias', 'elapsedMs', 'iteration', 'ok', 'requestId', 'requestedAlias', 'route'].sort(),
    );
    expect(Object.keys(s.properties).sort()).toEqual(
      [
        'attemptAlias',
        'axis',
        'callId',
        'elapsedMs',
        'errorCategory',
        'iteration',
        'ok',
        'requestId',
        'requestedAlias',
        'route',
      ].sort(),
    );
    expect(s.properties.errorCategory.$ref).toBe('#/components/schemas/FailureCategory');
    expect(s.properties.iteration).toMatchObject({ type: 'integer', minimum: 1 });
  });

  it('BindingSummary has the exact required set', () => {
    const s = schemas.BindingSummary;
    expect(s.required.sort()).toEqual(
      [
        'attemptAlias',
        'attemptCount',
        'backoffWaitedMs',
        'netLatencyMs',
        'ok',
        'requestId',
        'requestedAlias',
        'route',
        'wallClockMs',
      ].sort(),
    );
    expect(s.properties.attemptCount).toMatchObject({ type: 'integer', minimum: 1 });
    // O11: time differences are numbers, not integers
    for (const f of ['netLatencyMs', 'backoffWaitedMs', 'wallClockMs']) {
      expect(s.properties[f].type).toBe('number');
    }
  });
});

describe('DiagnosticsSnapshot', () => {
  const s = () => schemas.DiagnosticsSnapshot;

  it('requires camelCase requestId plus all five streams', () => {
    expect(s().required.sort()).toEqual(['requestId', ...FIVE_STREAMS].sort());
    expect(s().properties.requestId.type).toBe('string');
    expect(s().properties.request_id).toBeUndefined();
    expect(s().additionalProperties).toBe(false);
  });

  it.each(FIVE_STREAMS)('stream %s is a closed {items, dropped} envelope', (stream) => {
    const env = s().properties[stream];
    expect(env.required.sort()).toEqual(['dropped', 'items']);
    expect(env.additionalProperties).toBe(false);
    expect(env.properties.dropped).toMatchObject({ type: 'integer', minimum: 0 });
    expect(env.properties.items.type).toBe('array');
  });

  it('stream items reference the right event schemas', () => {
    const p = s().properties;
    expect(p.transitions.properties.items.items.$ref).toBe('#/components/schemas/TransitionEvent');
    expect(p.stale_results.properties.items.items.$ref).toBe('#/components/schemas/StaleResultEvent');
    expect(p.invalid_outcomes.properties.items.items.$ref).toBe(
      '#/components/schemas/InvalidOutcomeEvent',
    );
    expect(p.attempts.properties.items.items.$ref).toBe('#/components/schemas/AttemptEvent');
    expect(p.binding_summaries.properties.items.items.$ref).toBe(
      '#/components/schemas/BindingSummary',
    );
  });
});

describe('DiagnosticsTruncationCounts', () => {
  it('requires five retained keys plus dropped with five sub-keys — both closed', () => {
    const s = schemas.DiagnosticsTruncationCounts;
    expect(s.required.sort()).toEqual([...FIVE_STREAMS, 'dropped'].sort());
    expect(s.additionalProperties).toBe(false);
    for (const stream of FIVE_STREAMS) {
      expect(s.properties[stream]).toMatchObject({ type: 'integer', minimum: 0 });
    }
    const dropped = s.properties.dropped;
    expect(dropped.required.sort()).toEqual([...FIVE_STREAMS].sort());
    expect(dropped.additionalProperties).toBe(false);
    for (const stream of FIVE_STREAMS) {
      expect(dropped.properties[stream]).toMatchObject({ type: 'integer', minimum: 0 });
    }
  });
});

describe('DqlRequest maxima (Δ8 — audited MAX_FIELD_LENGTH)', () => {
  it.each(['mandate', 'proposed_action', 'reasoning', 'context'])(
    '%s has maxLength 20000',
    (field) => {
      expect(schemas.DqlRequest.properties[field].maxLength).toBe(20000);
    },
  );
});

describe('AxisResult provider attribution (d7a8ff6 wire fields)', () => {
  it('provider_route enum is exactly {primary, fallback} and optional', () => {
    const s = schemas.AxisResult;
    expect(s.properties.provider_route.enum.sort()).toEqual(['fallback', 'primary']);
    expect(s.required).not.toContain('provider_route');
  });

  it('provider_outcome enum is exactly {served, circuit_rejected, provider_error} and optional', () => {
    const s = schemas.AxisResult;
    expect(s.properties.provider_outcome.enum.sort()).toEqual(
      ['circuit_rejected', 'provider_error', 'served'].sort(),
    );
    expect(s.required).not.toContain('provider_outcome');
  });
});
