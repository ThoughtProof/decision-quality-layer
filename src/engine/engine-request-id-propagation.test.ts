/**
 * PR #12 (v0.4.3.1 §C.1): request-id propagation — discriminating test.
 *
 * The handler is the ONLY source of requestId. The engine must:
 *   - Set `DqlResponse.id` from the handler-provided input.requestId (verbatim).
 *   - Fork a CallContext per axis whose `ctx.requestId` also equals the input.
 *   - Never invent a second requestId.
 *
 * This test uses a cascade that captures the ctx it receives, then asserts:
 *
 *   input.requestId  ==  response.id  ==  every observed ctx.requestId
 *
 * If the engine were to autogenerate a requestId, this test would fail: the
 * captured ctx.requestId values would diverge from the input one.
 */

import { describe, it, expect } from 'vitest';
import { runVerification } from './index.js';
import { StubCascade } from './cascade.js';
import { SandboxCascade } from './sandbox-cascade.js';
import type { Cascade, CascadeInput, CascadeOutput } from './cascade.js';
import type { AxisResult, DqlRequest } from '../types.js';

class CaptureCtxCascade implements Cascade {
  public capturedCtxs: Array<CascadeInput['ctx']> = [];
  public capturedAxes: string[] = [];

  async run(input: CascadeInput): Promise<CascadeOutput> {
    this.capturedCtxs.push(input.ctx);
    this.capturedAxes.push(input.axis);
    const result: AxisResult = {
      axis: input.axis,
      verdict: 'PASS',
      confidence: 0.9,
      reasoning: 'capture-ctx',
      objection: '',
    };
    return { result, modelsUsed: ['capture'] };
  }
}

const req: Required<Omit<DqlRequest, 'context' | 'structured_context' | 'gate_mode'>> & Pick<DqlRequest, 'context' | 'structured_context' | 'gate_mode'> = {
  mandate: 'noop',
  proposed_action: 'noop',
  reasoning: 'noop',
  axes: ['intent', 'scope', 'risk', 'consistency', 'reversibility'],
  sandbox: false,
  context: undefined,
};

describe('PR #12 §C.1 — engine propagates handler-owned requestId only', () => {
  it('response.id and every ctx.requestId match input.requestId verbatim', async () => {
    const cascade = new CaptureCtxCascade();
    const sandbox = new SandboxCascade();

    const HANDLER_REQUEST_ID = 'dql_test_HANDLER_OWNED_1234';

    const response = await runVerification({
      request: req,
      cascade,
      sandboxCascade: sandbox,
      requestId: HANDLER_REQUEST_ID,
      version: '0.4.3.1-test',
    });

    // DqlResponse.id must equal the handler-provided id verbatim.
    expect(response.id).toBe(HANDLER_REQUEST_ID);

    // Every axis got a ctx populated with the same requestId.
    expect(cascade.capturedCtxs).toHaveLength(5);
    for (const ctx of cascade.capturedCtxs) {
      expect(ctx).toBeDefined();
      expect(ctx?.requestId).toBe(HANDLER_REQUEST_ID);
    }

    // The ctx.axis field mirrors the axis this call was for.
    for (let i = 0; i < cascade.capturedCtxs.length; i++) {
      expect(cascade.capturedCtxs[i]?.axis).toBe(cascade.capturedAxes[i]);
    }

    // Each ctx.callId is populated and non-empty.
    const callIds = cascade.capturedCtxs.map((c) => c?.callId);
    for (const id of callIds) {
      expect(typeof id).toBe('string');
      expect((id as string).length).toBeGreaterThan(3);
    }

    // callIds are unique within a single request (5 parallel axes, 5 different ids).
    const uniqueCallIds = new Set(callIds);
    expect(uniqueCallIds.size).toBe(5);
  });

  it('changing input.requestId changes response.id — no second internal source', async () => {
    const cascade = new CaptureCtxCascade();
    const sandbox = new SandboxCascade();

    const idA = 'dql_test_A_only';
    const idB = 'dql_test_B_only_totally_different';

    const respA = await runVerification({
      request: req,
      cascade,
      sandboxCascade: sandbox,
      requestId: idA,
      version: '0.4.3.1-test',
    });
    const respB = await runVerification({
      request: req,
      cascade,
      sandboxCascade: sandbox,
      requestId: idB,
      version: '0.4.3.1-test',
    });

    // Different input requestIds → different response.ids (verbatim).
    expect(respA.id).toBe(idA);
    expect(respB.id).toBe(idB);
    expect(respA.id).not.toBe(respB.id);

    // First 5 captured ctxs are for request A, next 5 for request B.
    const ctxsA = cascade.capturedCtxs.slice(0, 5);
    const ctxsB = cascade.capturedCtxs.slice(5, 10);
    for (const ctx of ctxsA) expect(ctx?.requestId).toBe(idA);
    for (const ctx of ctxsB) expect(ctx?.requestId).toBe(idB);
  });

  it('StubCascade ignores ctx silently (backward compatibility)', async () => {
    // The engine still populates ctx per axis, but StubCascade never reads it.
    // This asserts we did not break the general Cascade contract.
    const stub = new StubCascade();
    const sandbox = new SandboxCascade();

    const response = await runVerification({
      request: req,
      cascade: stub,
      sandboxCascade: sandbox,
      requestId: 'dql_test_stub_ok',
      version: '0.4.3.1-test',
    });

    expect(response.id).toBe('dql_test_stub_ok');
    expect(response.axes).toHaveLength(5);
  });
});
