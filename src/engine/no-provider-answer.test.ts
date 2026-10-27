/**
 * No-provider-answer marker.
 *
 * Outage, HTTP failure, deadline, and abort must be distinguishable from a
 * genuine model UNCERTAIN. The marker is request-level and only present when
 * every evaluated axis went unserved. Axis verdict stays UNCERTAIN and the
 * aggregate must not be ALLOW.
 */

import { describe, expect, it } from 'vitest';

import type { Axis, DqlRequest } from '../types.js';
import type { Cascade, CascadeOutput } from './cascade.js';
import { runVerification } from './index.js';
import {
  CircuitAllOpenError,
  DeadlineExceededError,
  ProviderCallError,
} from './llm-client.js';
import { SandboxCascade } from './sandbox-cascade.js';

const sandboxCascade = new SandboxCascade();

function request(axes: Axis[]): Required<Omit<DqlRequest, 'context' | 'structured_context' | 'gate_mode'>> &
  Pick<DqlRequest, 'context' | 'structured_context' | 'gate_mode'> {
  return {
    mandate: 'noop',
    proposed_action: 'noop',
    reasoning: 'noop',
    axes,
    sandbox: false,
    context: undefined,
  };
}

function served(
  axis: Axis,
  verdict: 'PASS' | 'FAIL' | 'UNCERTAIN',
  confidence: number,
): CascadeOutput {
  return {
    result: {
      axis,
      verdict,
      confidence,
      reasoning: 'provider judgment',
      objection: verdict === 'PASS' ? '' : 'noted',
      provider_outcome: 'served',
      provider_route: 'primary',
    },
    modelsUsed: ['serv:scripted'],
  };
}

function cascade(run: (axis: Axis) => CascadeOutput | Promise<CascadeOutput>): Cascade {
  return {
    async run(input) {
      return run(input.axis);
    },
  };
}

async function verify(axes: Axis[], run: (axis: Axis) => CascadeOutput | Promise<CascadeOutput>) {
  return runVerification({
    request: request(axes),
    cascade: cascade(run),
    sandboxCascade,
    requestId: 'dql_no_provider_answer',
    version: 'test',
  });
}

describe('no provider answer marker', () => {
  it('outage → UNCERTAIN, marker outage, aggregate is not ALLOW', async () => {
    const response = await verify(['intent'], () => {
      throw new CircuitAllOpenError('serv-nano', 'serv-swift', 'open', 'open', []);
    });
    expect(response.axes[0]?.verdict).toBe('UNCERTAIN');
    expect(response.axes[0]?.provider_outcome).toBe('circuit_rejected');
    expect(response.aggregate.verdict).not.toBe('ALLOW');
    expect(response.meta.no_provider_answer).toEqual({ reasons: ['outage'] });
  });

  it('HTTP 5xx → marker http_error', async () => {
    const response = await verify(['intent'], () => {
      throw new ProviderCallError('[llm-client] serv 503: unavailable', 'serv', 503);
    });
    expect(response.axes[0]?.verdict).toBe('UNCERTAIN');
    expect(response.axes[0]?.provider_outcome).toBe('provider_error');
    expect(response.aggregate.verdict).not.toBe('ALLOW');
    expect(response.meta.no_provider_answer).toEqual({ reasons: ['http_error'] });
  });

  it('deadline → marker deadline', async () => {
    const response = await verify(['intent'], () => {
      throw new DeadlineExceededError(
        '[llm-client] provider call budget exhausted',
        'serv',
        'call_budget',
      );
    });
    expect(response.axes[0]?.verdict).toBe('UNCERTAIN');
    expect(response.aggregate.verdict).not.toBe('ALLOW');
    expect(response.meta.no_provider_answer).toEqual({ reasons: ['deadline'] });
  });

  it('per-attempt timeout (AbortError cause on ProviderCallError) is deadline, not abort', async () => {
    const abort = new Error('The operation was aborted');
    abort.name = 'AbortError';
    const response = await verify(['intent'], () => {
      throw new ProviderCallError(
        '[llm-client] request timeout after 1000ms (aborted)',
        'serv',
        undefined,
        { cause: abort },
      );
    });
    expect(response.meta.no_provider_answer).toEqual({ reasons: ['deadline'] });
    expect(response.aggregate.verdict).not.toBe('ALLOW');
  });

  it('request abort (DeadlineExceededError.aborted) → marker abort', async () => {
    const abort = new Error('The operation was aborted');
    abort.name = 'AbortError';
    const response = await verify(['intent'], () => {
      throw new DeadlineExceededError(
        '[llm-client] request aborted before attempt 1',
        'serv',
        'request_deadline',
        { cause: abort, aborted: true },
      );
    });
    expect(response.axes[0]?.verdict).toBe('UNCERTAIN');
    expect(response.axes[0]?.provider_outcome).toBe('provider_error');
    expect(response.aggregate.verdict).not.toBe('ALLOW');
    expect(response.meta.no_provider_answer).toEqual({ reasons: ['abort'] });
  });

  it('raw AbortError → marker abort and provider_error (never ALLOW)', async () => {
    const response = await verify(['intent'], () => {
      const err = new Error('The operation was aborted');
      err.name = 'AbortError';
      throw err;
    });
    expect(response.axes[0]?.verdict).toBe('UNCERTAIN');
    expect(response.axes[0]?.provider_outcome).toBe('provider_error');
    expect(response.aggregate.verdict).not.toBe('ALLOW');
    expect(response.meta.no_provider_answer).toEqual({ reasons: ['abort'] });
  });

  it('genuine served UNCERTAIN has no marker (billable answer)', async () => {
    const response = await verify(['intent'], (axis) => served(axis, 'UNCERTAIN', 0.4));
    expect(response.axes[0]?.verdict).toBe('UNCERTAIN');
    expect(response.axes[0]?.provider_outcome).toBe('served');
    expect(response.meta.no_provider_answer).toBeUndefined();
  });

  it('served PASS and served FAIL have no marker', async () => {
    const allow = await verify(['intent'], (axis) => served(axis, 'PASS', 0.9));
    expect(allow.aggregate.verdict).toBe('ALLOW');
    expect(allow.meta.no_provider_answer).toBeUndefined();

    const block = await verify(['intent'], (axis) => served(axis, 'FAIL', 0.95));
    expect(block.aggregate.verdict).toBe('BLOCK');
    expect(block.meta.no_provider_answer).toBeUndefined();
  });

  it('one served UNCERTAIN plus one HTTP failure has no request marker', async () => {
    const response = await verify(['intent', 'scope'], (axis) => {
      if (axis === 'scope') {
        throw new ProviderCallError('[llm-client] serv 500: down', 'serv', 500);
      }
      return served(axis, 'UNCERTAIN', 0.42);
    });
    expect(response.axes.find((axis) => axis.axis === 'intent')?.verdict).toBe('UNCERTAIN');
    expect(response.axes.find((axis) => axis.axis === 'intent')?.provider_outcome).toBe('served');
    expect(response.meta.no_provider_answer).toBeUndefined();
    expect(response.aggregate.verdict).not.toBe('ALLOW');
  });

  it('mixed outage and HTTP 5xx lists both reasons, still not ALLOW', async () => {
    const response = await verify(['intent', 'scope'], (axis) => {
      if (axis === 'intent') {
        throw new CircuitAllOpenError('serv-nano', null, 'open', null, []);
      }
      throw new ProviderCallError('[llm-client] serv 502: bad gateway', 'serv', 502);
    });
    expect(response.axes.every((axis) => axis.verdict === 'UNCERTAIN')).toBe(true);
    expect(response.aggregate.verdict).not.toBe('ALLOW');
    expect(response.meta.no_provider_answer?.reasons).toEqual(['outage', 'http_error']);
  });
});
