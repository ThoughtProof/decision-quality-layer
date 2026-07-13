/**
 * PR #12 (v0.4.3.1 §C.3-fix, Hermes 2026-07-11):
 * End-to-end engine tests for provider_outcome semantics.
 *
 * The client-level tests in `provider-route-semantics.test.ts` assert that
 * CircuitAllOpenError is thrown in the correct topologies and carries the
 * correct `attemptedRoutes` provenance. This file goes one level higher:
 * it drives the full `runVerification()` engine path and asserts what the
 * engine maps the error onto in the returned AxisResult.
 *
 * Contract under test:
 *
 *   attemptedRoutes = []   → AxisResult.provider_outcome === 'circuit_rejected'
 *   attemptedRoutes ≠ []   → AxisResult.provider_outcome === 'provider_error'
 *   served response        → provider_outcome === 'served', provider_route names it
 *
 * In every fail-closed case, `provider_route` MUST be absent — no route
 * ultimately served a response.
 *
 * Five discriminating cases are covered:
 *   1. Pre-existing OPEN + CPM=true               → circuit_rejected
 *   2. Current primary fetch trips + CPM=true     → provider_error
 *   3. Both circuits pre-existing OPEN            → circuit_rejected
 *   4. Primary trips + fallback pre-existing OPEN → provider_error
 *   5. Successful fallback                        → served (route=fallback)
 *
 * The engine talks to a real PotCliCascade whose LlmClient is programmable
 * so we can control exactly which provenance the error carries WITHOUT
 * spinning up a real HttpLlmClient / CircuitBreaker network.
 */

import { describe, it, expect } from 'vitest';
import { runVerification } from './index.js';
import { PotCliCascade } from './cascade-pot.js';
import { StubCascade } from './cascade.js';
import { SandboxCascade } from './sandbox-cascade.js';
import { CircuitAllOpenError, ProviderCallError } from './llm-client.js';
import type {
  LlmClient,
  LlmCallInput,
  LlmCallOutput,
  AttemptedRoute,
} from './llm-client.js';
import type { CallContext } from './call-context.js';
import type { DqlRequest } from '../types.js';

// Minimal request envelope for the engine.
const REQ: Required<Omit<DqlRequest, 'context'>> & Pick<DqlRequest, 'context'> = {
  mandate: 'noop',
  proposed_action: 'noop',
  reasoning: 'noop',
  axes: ['intent'], // single axis is enough — this tests error mapping, not aggregation
  sandbox: false,
  context: undefined,
};

/**
 * Programmable LlmClient. `.plan` is a list of per-call outcomes; each `call`
 * consumes one entry. When exhausted, throws to make missing plans loud.
 */
type ScriptedOutcome =
  | { kind: 'ok'; providerRoute: 'primary' | 'fallback' }
  | { kind: 'fail-closed'; attemptedRoutes: AttemptedRoute[] }
  // Simulates a single provider interaction that failed (e.g. HTTP 401) WITHOUT
  // tripping the breaker — the exact D6 case. A real HttpLlmClient rethrows a
  // ProviderCallError here; the cascade propagates it to the engine.
  | { kind: 'provider-error'; httpStatus?: number; message?: string };

class ScriptedClient implements LlmClient {
  private index = 0;
  public callLog: Array<{ modelAlias: string; ctxRequestId: string | undefined }> = [];
  constructor(private readonly plan: ScriptedOutcome[]) {}

  async call(
    modelAlias: string,
    _input: LlmCallInput,
    ctx?: CallContext,
  ): Promise<LlmCallOutput> {
    this.callLog.push({ modelAlias, ctxRequestId: ctx?.requestId });
    const step = this.plan[this.index++];
    if (!step) {
      throw new Error(
        `[ScriptedClient] plan exhausted at call #${this.index} (alias=${modelAlias})`,
      );
    }
    if (step.kind === 'fail-closed') {
      // Primary reason is fixed for readability; the field the engine
      // depends on is `attemptedRoutes`.
      throw new CircuitAllOpenError(
        modelAlias,
        null,
        'scripted-primary-open',
        'scripted-fallback-open',
        step.attemptedRoutes,
      );
    }
    if (step.kind === 'provider-error') {
      throw new ProviderCallError(
        step.message ?? `[llm-client] serv ${step.httpStatus ?? 401}: scripted provider error`,
        'serv',
        step.httpStatus ?? 401,
      );
    }
    // ok case: parseable PASS response.
    return {
      raw: 'VERDICT: PASS\nCONFIDENCE: 0.9\nREASONING: scripted ok\nOBJECTIONS: none',
      modelUsed: `scripted-${step.providerRoute}`,
      latencyMs: 1,
      providerRoute: step.providerRoute,
    };
  }
}

/** Build a cascade wired to the scripted client. */
function makeCascade(plan: ScriptedOutcome[]) {
  const client = new ScriptedClient(plan);
  const cascade = new PotCliCascade(client);
  return { cascade, client };
}

describe('PR #12 §C.3-fix — engine maps CircuitAllOpenError provenance to provider_outcome', () => {
  it('Case 1 — pre-existing OPEN + CPM=true → provider_outcome=circuit_rejected (no fetch attributed)', async () => {
    // Cascade issues primary first. attemptedRoutes=[] means the client
    // rejected before any provider fetch was started.
    const { cascade, client } = makeCascade([
      { kind: 'fail-closed', attemptedRoutes: [] },
    ]);
    const response = await runVerification({
      request: REQ,
      cascade,
      sandboxCascade: new SandboxCascade(),
      requestId: 'dql_c1_test_case1',
      version: '0.4.3.1-test',
    });

    const axis = response.axes[0]!;
    expect(axis.verdict).toBe('UNCERTAIN');
    expect(axis.confidence).toBe(0);
    expect(axis.provider_outcome).toBe('circuit_rejected');
    expect(axis.provider_route).toBeUndefined();
    // Engine reached the client exactly once (single axis, single alias
    // attempt before the error).
    expect(client.callLog.length).toBe(1);
  });

  it('Case 2 — current primary fetch trips + CPM=true → provider_outcome=provider_error', async () => {
    // attemptedRoutes=['primary'] means the primary WAS fetched and its
    // failure is what tripped the breaker; CPM disabled fallback → fail-closed.
    const { cascade } = makeCascade([
      { kind: 'fail-closed', attemptedRoutes: ['primary'] },
    ]);
    const response = await runVerification({
      request: REQ,
      cascade,
      sandboxCascade: new SandboxCascade(),
      requestId: 'dql_c1_test_case2',
      version: '0.4.3.1-test',
    });

    const axis = response.axes[0]!;
    expect(axis.verdict).toBe('UNCERTAIN');
    expect(axis.provider_outcome).toBe('provider_error');
    expect(axis.provider_route).toBeUndefined();
  });

  it('Case 3 — both circuits pre-existing OPEN → provider_outcome=circuit_rejected', async () => {
    // Neither primary nor fallback was fetched; attemptedRoutes=[].
    const { cascade } = makeCascade([
      { kind: 'fail-closed', attemptedRoutes: [] },
    ]);
    const response = await runVerification({
      request: REQ,
      cascade,
      sandboxCascade: new SandboxCascade(),
      requestId: 'dql_c1_test_case3',
      version: '0.4.3.1-test',
    });

    const axis = response.axes[0]!;
    expect(axis.provider_outcome).toBe('circuit_rejected');
    expect(axis.provider_route).toBeUndefined();
  });

  it('Case 4 — primary trips + fallback pre-existing OPEN → provider_outcome=provider_error', async () => {
    // Primary was actually fetched and failed; fallback breaker was already
    // OPEN so no fallback fetch. attemptedRoutes=['primary'].
    const { cascade } = makeCascade([
      { kind: 'fail-closed', attemptedRoutes: ['primary'] },
    ]);
    const response = await runVerification({
      request: REQ,
      cascade,
      sandboxCascade: new SandboxCascade(),
      requestId: 'dql_c1_test_case4',
      version: '0.4.3.1-test',
    });

    const axis = response.axes[0]!;
    expect(axis.provider_outcome).toBe('provider_error');
    expect(axis.provider_route).toBeUndefined();
  });

  it('Case 5 — successful fallback → provider_outcome=served, provider_route=fallback', async () => {
    // Cascade runs primary first (PotCliCascade); we script it to return
    // OK via the fallback route. Primary early-exit on FAIL is not triggered
    // because the outcome is PASS with high confidence, so secondary is also
    // called — that too returns via fallback.
    const { cascade } = makeCascade([
      { kind: 'ok', providerRoute: 'fallback' }, // primary alias call → served by fallback
      { kind: 'ok', providerRoute: 'fallback' }, // secondary alias call → served by fallback
    ]);
    const response = await runVerification({
      request: REQ,
      cascade,
      sandboxCascade: new SandboxCascade(),
      requestId: 'dql_c1_test_case5',
      version: '0.4.3.1-test',
    });

    const axis = response.axes[0]!;
    // The cascade produced a proper PASS via fallback route.
    expect(axis.provider_route).toBe('fallback');
    expect(axis.provider_outcome).toBe('served');
  });

  it('Case 6 (happy path) — successful primary → provider_outcome=served, provider_route=primary', async () => {
    const { cascade } = makeCascade([
      { kind: 'ok', providerRoute: 'primary' }, // primary alias
      { kind: 'ok', providerRoute: 'primary' }, // secondary alias
    ]);
    const response = await runVerification({
      request: REQ,
      cascade,
      sandboxCascade: new SandboxCascade(),
      requestId: 'dql_c1_test_case6',
      version: '0.4.3.1-test',
    });

    const axis = response.axes[0]!;
    expect(axis.provider_route).toBe('primary');
    expect(axis.provider_outcome).toBe('served');
  });

  it('Stub / non-provider errors still map to UNCERTAIN with NO provider_outcome (baseline preserved)', async () => {
    // A stub cascade that just throws a plain Error must produce
    // UNCERTAIN@0 WITHOUT any provider_outcome — this is not a
    // circuit-breaker path.
    class ThrowingCascade extends StubCascade {
      override async run(_input: import('./cascade.js').CascadeInput): Promise<import('./cascade.js').CascadeOutput> {
        throw new Error('unrelated failure');
      }
    }
    const response = await runVerification({
      request: REQ,
      cascade: new ThrowingCascade(),
      sandboxCascade: new SandboxCascade(),
      requestId: 'dql_c1_test_baseline',
      version: '0.4.3.1-test',
    });

    const axis = response.axes[0]!;
    expect(axis.verdict).toBe('UNCERTAIN');
    expect(axis.confidence).toBe(0);
    expect(axis.provider_outcome).toBeUndefined();
    expect(axis.provider_route).toBeUndefined();
  });
});

describe('§D6-fix — engine↔aggregation: a single provider-failed axis fails CLOSED (never ALLOW)', () => {
  it('HTTP 401 (ProviderCallError, breaker NOT tripped) → axis provider_error AND aggregate REVIEW', async () => {
    const { cascade } = makeCascade([
      { kind: 'provider-error', httpStatus: 401 },
    ]);
    const response = await runVerification({
      request: REQ,
      cascade,
      sandboxCascade: new SandboxCascade(),
      requestId: 'dql_d6_http401',
      version: '0.4.3.1-test',
    });

    const axis = response.axes[0]!;
    expect(axis.verdict).toBe('UNCERTAIN');
    expect(axis.confidence).toBe(0);
    expect(axis.provider_outcome).toBe('provider_error');
    // The regression this fix closes: the aggregate MUST NOT be ALLOW.
    expect(response.aggregate.verdict).toBe('REVIEW');
    expect(response.aggregate.triggered_by).toEqual(['intent']);
    expect(response.aggregate.rationale).not.toBe('All evaluated axes pass.');
  });

  it('CircuitAllOpen provider_error variant (attemptedRoutes=[primary]) → aggregate REVIEW', async () => {
    const { cascade } = makeCascade([
      { kind: 'fail-closed', attemptedRoutes: ['primary'] },
    ]);
    const response = await runVerification({
      request: REQ,
      cascade,
      sandboxCascade: new SandboxCascade(),
      requestId: 'dql_d6_cao_provider',
      version: '0.4.3.1-test',
    });
    expect(response.axes[0]!.provider_outcome).toBe('provider_error');
    expect(response.aggregate.verdict).toBe('REVIEW');
  });

  it('CircuitAllOpen circuit_rejected variant (attemptedRoutes=[]) → aggregate REVIEW', async () => {
    const { cascade } = makeCascade([
      { kind: 'fail-closed', attemptedRoutes: [] },
    ]);
    const response = await runVerification({
      request: REQ,
      cascade,
      sandboxCascade: new SandboxCascade(),
      requestId: 'dql_d6_cao_rejected',
      version: '0.4.3.1-test',
    });
    expect(response.axes[0]!.provider_outcome).toBe('circuit_rejected');
    expect(response.aggregate.verdict).toBe('REVIEW');
  });

  it('NEGATIVE: a non-provider plain-Error axis still aggregates to ALLOW (deliberate policy preserved)', async () => {
    class ThrowingCascade extends StubCascade {
      override async run(_input: import('./cascade.js').CascadeInput): Promise<import('./cascade.js').CascadeOutput> {
        throw new Error('unrelated non-provider failure');
      }
    }
    const response = await runVerification({
      request: REQ,
      cascade: new ThrowingCascade(),
      sandboxCascade: new SandboxCascade(),
      requestId: 'dql_d6_negative',
      version: '0.4.3.1-test',
    });
    expect(response.axes[0]!.provider_outcome).toBeUndefined();
    // No provider provenance → Rule 2 does not fire; single UNCERTAIN@0 falls
    // through to ALLOW exactly as before the fix.
    expect(response.aggregate.verdict).toBe('ALLOW');
  });
});
