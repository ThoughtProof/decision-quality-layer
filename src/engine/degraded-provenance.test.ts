/**
 * Issue #14 (VERTRAGSÄNDERUNG, Paul 2026-07-13):
 * Degraded-mode secondary-failure provenance — engine↔aggregation.
 *
 * Complements the §D6 whole-cascade tests in `engine-provider-outcome.test.ts`.
 * D6 covers "the ENTIRE cascade throws" (engine catch sets provenance). This
 * file covers the complementary composition path D6 did NOT: "primary SERVED,
 * secondary THROWS". There the error is caught INSIDE PotCliCascade.run — the
 * cascade returns normally, the engine's D6 catch never fires, and (pre-fix)
 * the degraded axis inherited provider_outcome='served', so aggregation Rule 2
 * saw no failure provenance and a PASS@<0.7 primary fell through to ALLOW.
 *
 * The fix classifies the secondary error from its STRUCTURED TYPE (never
 * message parsing) and emits provider_error | circuit_rejected on the degraded
 * axis, dropping the inherited 'served'. Aggregation Rule 2 then fails closed.
 *
 * Discriminating cases (issue #14 acceptance table a–i):
 *   a  secondary ProviderCallError + primary PASS conf<0.7   → REVIEW
 *   b  secondary ProviderCallError + primary PASS conf>=0.7  → REVIEW (via
 *      provenance, NOT confidence)
 *   c  generic (non-provider) secondary error                → baseline policy
 *      preserved (lone UNCERTAIN@<0.7 with no provenance → ALLOW)
 *   d  primary FAIL conf 0.5–0.7 + secondary failure          → REVIEW, FAIL
 *      not weakened
 *   e  primary high-conf FAIL early-exit (secondary skipped)  → BLOCK
 *   f  both draws served                                      → unchanged
 *   g  CircuitAllOpenError: attemptedRoutes=[] → circuit_rejected;
 *      attemptedRoutes=[primary] → provider_error; both REVIEW
 *   h  truth assertions: provider_outcome != 'served';
 *      rationale != 'All evaluated axes pass.'
 *   i  existing D6 tests remain green (asserted by the untouched suite)
 */

import { describe, it, expect } from 'vitest';
import { runVerification } from './index.js';
import { PotCliCascade } from './cascade-pot.js';
import { SandboxCascade } from './sandbox-cascade.js';
import {
  CircuitAllOpenError,
  ProviderCallError,
  type LlmClient,
  type LlmCallInput,
  type LlmCallOutput,
  type AttemptedRoute,
} from './llm-client.js';
import type { CallContext } from './call-context.js';
import type { DqlRequest } from '../types.js';

const REQ: Required<Omit<DqlRequest, 'context'>> & Pick<DqlRequest, 'context'> = {
  mandate: 'noop',
  proposed_action: 'noop',
  reasoning: 'noop',
  axes: ['intent'], // single axis isolates the degraded-composition behavior
  sandbox: false,
  context: undefined,
};

type Step =
  | { kind: 'served'; verdict: 'PASS' | 'FAIL' | 'UNCERTAIN'; confidence: number }
  | { kind: 'provider-error'; httpStatus?: number }
  | { kind: 'circuit-all-open'; attemptedRoutes: AttemptedRoute[] }
  | { kind: 'generic-error'; message?: string };

class ScriptedClient implements LlmClient {
  private index = 0;
  public callLog: string[] = [];
  constructor(private readonly plan: Step[]) {}

  async call(
    modelAlias: string,
    _input: LlmCallInput,
    _ctx?: CallContext,
  ): Promise<LlmCallOutput> {
    this.callLog.push(modelAlias);
    const step = this.plan[this.index++];
    if (!step) throw new Error(`[ScriptedClient] plan exhausted (alias=${modelAlias})`);
    switch (step.kind) {
      case 'served':
        return {
          raw: JSON.stringify({
            verdict: step.verdict,
            confidence: step.confidence,
            reasoning: 'scripted served',
            objection: step.verdict === 'PASS' ? '' : 'scripted objection',
          }),
          modelUsed: `scripted:${modelAlias}`,
          latencyMs: 1,
          providerRoute: 'primary',
        };
      case 'provider-error':
        throw new ProviderCallError(
          `[llm-client] serv ${step.httpStatus ?? 401}: scripted provider error`,
          'serv',
          step.httpStatus ?? 401,
        );
      case 'circuit-all-open':
        throw new CircuitAllOpenError(
          modelAlias,
          null,
          'scripted-primary-open',
          'scripted-fallback-open',
          step.attemptedRoutes,
        );
      case 'generic-error':
        throw new Error(step.message ?? 'scripted generic non-provider failure');
    }
  }
}

function run(plan: Step[]) {
  const client = new ScriptedClient(plan);
  const cascade = new PotCliCascade(client);
  return {
    client,
    result: runVerification({
      request: REQ,
      cascade,
      sandboxCascade: new SandboxCascade(),
      requestId: 'dql_issue14',
      version: '0.4.3.1-test',
    }),
  };
}

describe('Issue #14 — degraded-mode secondary-failure provenance (engine↔aggregation)', () => {
  it('a) secondary ProviderCallError + primary PASS conf<0.7 → REVIEW (not ALLOW)', async () => {
    const { result } = run([
      { kind: 'served', verdict: 'PASS', confidence: 0.6 },
      { kind: 'provider-error', httpStatus: 401 },
    ]);
    const response = await result;
    const axis = response.axes[0]!;
    expect(axis.verdict).toBe('UNCERTAIN'); // PASS degraded → UNCERTAIN
    expect(axis.provider_outcome).toBe('provider_error');
    expect(axis.provider_route).toBeUndefined();
    expect(response.aggregate.verdict).toBe('REVIEW');
    expect(response.aggregate.triggered_by).toEqual(['intent']);
    expect(response.aggregate.rationale).not.toBe('All evaluated axes pass.');
  });

  it('b) secondary ProviderCallError + primary PASS conf>=0.7 → REVIEW via PROVENANCE, not confidence', async () => {
    const { result } = run([
      { kind: 'served', verdict: 'PASS', confidence: 0.85 },
      { kind: 'provider-error', httpStatus: 503 },
    ]);
    const response = await result;
    const axis = response.axes[0]!;
    expect(axis.provider_outcome).toBe('provider_error');
    expect(response.aggregate.verdict).toBe('REVIEW');
    // Prove it is Rule 2 (provider provenance), NOT Rule 5 (high-conf UNCERTAIN):
    // Rule 2's rationale names a provider/auth failure; Rule 5's does not.
    expect(response.aggregate.rationale).toMatch(/provider\/auth failure/);
    expect(response.aggregate.rationale).not.toBe('All evaluated axes pass.');
  });

  it('c) generic (non-provider) secondary error → baseline preserved (no provenance, ALLOW for lone UNCERTAIN@<0.7)', async () => {
    const { result } = run([
      { kind: 'served', verdict: 'PASS', confidence: 0.6 },
      { kind: 'generic-error' },
    ]);
    const response = await result;
    const axis = response.axes[0]!;
    expect(axis.verdict).toBe('UNCERTAIN');
    // Deliberate policy: a generic error carries NO provider provenance (mirrors
    // the engine's §D6 negative discrimination), so Rule 2 does not fire.
    expect(axis.provider_outcome).toBeUndefined();
    // ...but it must still never claim 'served' (AC-2): route dropped too.
    expect(axis.provider_route).toBeUndefined();
    expect(response.aggregate.verdict).toBe('ALLOW');
    expect(response.aggregate.rationale).toBe('All evaluated axes pass.');
  });

  it('d) primary FAIL conf 0.5–0.7 + secondary failure → REVIEW and FAIL not weakened', async () => {
    const { result } = run([
      { kind: 'served', verdict: 'FAIL', confidence: 0.6 },
      { kind: 'provider-error', httpStatus: 500 },
    ]);
    const response = await result;
    const axis = response.axes[0]!;
    expect(axis.verdict).toBe('FAIL'); // degraded must NOT weaken FAIL → UNCERTAIN
    expect(axis.confidence).toBe(0.6);
    expect(axis.provider_outcome).toBe('provider_error');
    expect(response.aggregate.verdict).toBe('REVIEW');
  });

  it('e) primary high-conf FAIL early-exit (secondary skipped) → BLOCK, unchanged', async () => {
    const { client, result } = run([
      { kind: 'served', verdict: 'FAIL', confidence: 0.9 },
      // A secondary step exists but must never be consumed.
      { kind: 'provider-error' },
    ]);
    const response = await result;
    const axis = response.axes[0]!;
    expect(client.callLog).toEqual(['serv-nano']); // secondary never called
    expect(axis.verdict).toBe('FAIL');
    expect(axis.provider_outcome).toBe('served'); // clean early-exit, primary served
    expect(response.aggregate.verdict).toBe('BLOCK');
  });

  it('f) both draws served → unchanged (PASS+PASS → ALLOW, served)', async () => {
    const { result } = run([
      { kind: 'served', verdict: 'PASS', confidence: 0.9 },
      { kind: 'served', verdict: 'PASS', confidence: 0.8 },
    ]);
    const response = await result;
    const axis = response.axes[0]!;
    expect(axis.verdict).toBe('PASS');
    expect(axis.provider_outcome).toBe('served');
    expect(response.aggregate.verdict).toBe('ALLOW');
  });

  it('g1) secondary CircuitAllOpenError attemptedRoutes=[] → circuit_rejected, REVIEW', async () => {
    const { result } = run([
      { kind: 'served', verdict: 'PASS', confidence: 0.6 },
      { kind: 'circuit-all-open', attemptedRoutes: [] },
    ]);
    const response = await result;
    const axis = response.axes[0]!;
    expect(axis.provider_outcome).toBe('circuit_rejected');
    expect(axis.provider_route).toBeUndefined();
    expect(response.aggregate.verdict).toBe('REVIEW');
  });

  it('g2) secondary CircuitAllOpenError attemptedRoutes=[primary] → provider_error, REVIEW', async () => {
    const { result } = run([
      { kind: 'served', verdict: 'PASS', confidence: 0.6 },
      { kind: 'circuit-all-open', attemptedRoutes: ['primary'] },
    ]);
    const response = await result;
    const axis = response.axes[0]!;
    expect(axis.provider_outcome).toBe('provider_error');
    expect(axis.provider_route).toBeUndefined();
    expect(response.aggregate.verdict).toBe('REVIEW');
  });

  it('h) truth assertions: degraded axis never carries served; rationale is truthful', async () => {
    const { result } = run([
      { kind: 'served', verdict: 'PASS', confidence: 0.65 },
      { kind: 'provider-error', httpStatus: 401 },
    ]);
    const response = await result;
    const axis = response.axes[0]!;
    expect(axis.provider_outcome).not.toBe('served');
    expect(response.aggregate.rationale).not.toBe('All evaluated axes pass.');
  });
});
