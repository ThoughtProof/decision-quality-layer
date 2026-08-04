/**
 * Secondary-unavailable composition (engine↔aggregation) after the
 * primary-as-served product contract (demo 2026-07-21).
 *
 * Complements the §D6 whole-cascade tests in `engine-provider-outcome.test.ts`.
 * D6 covers "the ENTIRE cascade throws" (engine catch sets provenance). This
 * file covers: "primary SERVED a real judgment, secondary THROWS". The error
 * is caught INSIDE PotCliCascade.run — the cascade returns normally.
 *
 * Product contract (cascade-pot.ts):
 *   - Primary PASS/FAIL + secondary down → KEEP primary as-served.
 *     Do NOT destroy PASS→UNCERTAIN+provider_error (that made Guardian show
 *     INCOMPLETE on axes that already had a valid nano result).
 *   - Primary already UNCERTAIN + secondary down → escalate with
 *     provider_error | circuit_rejected (primary never served a real judgment).
 *
 * Discriminating cases:
 *   a  secondary ProviderCallError + primary PASS conf<0.7   → ALLOW (as-served)
 *   b  secondary ProviderCallError + primary PASS conf>=0.7  → ALLOW (as-served)
 *   c  generic secondary error + primary PASS                → ALLOW (as-served)
 *   d  primary FAIL conf 0.5–0.7 + secondary failure          → REVIEW, FAIL kept
 *   e  primary high-conf FAIL early-exit (secondary skipped)  → BLOCK
 *   f  both draws served                                      → unchanged
 *   g  CircuitAllOpenError secondary + primary PASS           → ALLOW (as-served)
 *   h  truth: secondary-unavailable note present; served retained on PASS
 *   i  primary UNCERTAIN + secondary ProviderCallError        → REVIEW via provenance
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

const REQ: Required<Omit<DqlRequest, 'context' | 'structured_context' | 'gate_mode'>> & Pick<DqlRequest, 'context' | 'structured_context' | 'gate_mode'> = {
  mandate: 'noop',
  proposed_action: 'noop',
  reasoning: 'noop',
  axes: ['intent'], // single axis isolates the composition behavior
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
      requestId: 'dql_primary_as_served',
      version: '0.4.3.1-test',
    }),
  };
}

describe('Primary as-served — secondary-unavailable composition (engine↔aggregation)', () => {
  it('a) secondary ProviderCallError + primary PASS conf<0.7 → ALLOW (as-served)', async () => {
    const { result } = run([
      { kind: 'served', verdict: 'PASS', confidence: 0.6 },
      { kind: 'provider-error', httpStatus: 401 },
    ]);
    const response = await result;
    const axis = response.axes[0]!;
    expect(axis.verdict).toBe('PASS');
    expect(axis.provider_outcome).toBe('served');
    expect(axis.provider_route).toBe('primary');
    expect(axis.reasoning).toMatch(/keeping primary/);
    expect(response.aggregate.verdict).toBe('ALLOW');
    expect(response.aggregate.rationale).toBe('All evaluated axes pass.');
  });

  it('b) secondary ProviderCallError + primary PASS conf>=0.7 → ALLOW (as-served)', async () => {
    const { result } = run([
      { kind: 'served', verdict: 'PASS', confidence: 0.85 },
      { kind: 'provider-error', httpStatus: 503 },
    ]);
    const response = await result;
    const axis = response.axes[0]!;
    expect(axis.verdict).toBe('PASS');
    expect(axis.provider_outcome).toBe('served');
    expect(response.aggregate.verdict).toBe('ALLOW');
    expect(response.aggregate.rationale).toBe('All evaluated axes pass.');
  });

  it('c) generic secondary error + primary PASS → ALLOW (as-served)', async () => {
    const { result } = run([
      { kind: 'served', verdict: 'PASS', confidence: 0.6 },
      { kind: 'generic-error' },
    ]);
    const response = await result;
    const axis = response.axes[0]!;
    expect(axis.verdict).toBe('PASS');
    expect(axis.provider_outcome).toBe('served');
    expect(axis.provider_route).toBe('primary');
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
    expect(axis.verdict).toBe('FAIL'); // secondary down must NOT weaken FAIL → UNCERTAIN
    expect(axis.confidence).toBe(0.6);
    expect(axis.provider_outcome).toBe('served');
    expect(response.aggregate.verdict).toBe('REVIEW'); // mid-conf FAIL rule
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

  it('g1) secondary CircuitAllOpenError attemptedRoutes=[] + primary PASS → ALLOW (as-served)', async () => {
    const { result } = run([
      { kind: 'served', verdict: 'PASS', confidence: 0.6 },
      { kind: 'circuit-all-open', attemptedRoutes: [] },
    ]);
    const response = await result;
    const axis = response.axes[0]!;
    expect(axis.verdict).toBe('PASS');
    expect(axis.provider_outcome).toBe('served');
    expect(axis.provider_route).toBe('primary');
    expect(response.aggregate.verdict).toBe('ALLOW');
  });

  it('g2) secondary CircuitAllOpenError attemptedRoutes=[primary] + primary PASS → ALLOW (as-served)', async () => {
    const { result } = run([
      { kind: 'served', verdict: 'PASS', confidence: 0.6 },
      { kind: 'circuit-all-open', attemptedRoutes: ['primary'] },
    ]);
    const response = await result;
    const axis = response.axes[0]!;
    expect(axis.verdict).toBe('PASS');
    expect(axis.provider_outcome).toBe('served');
    expect(response.aggregate.verdict).toBe('ALLOW');
  });

  it('h) truth: primary PASS retained as-served; secondary-unavailable note present', async () => {
    const { result } = run([
      { kind: 'served', verdict: 'PASS', confidence: 0.65 },
      { kind: 'provider-error', httpStatus: 401 },
    ]);
    const response = await result;
    const axis = response.axes[0]!;
    expect(axis.provider_outcome).toBe('served');
    expect(axis.verdict).toBe('PASS');
    expect(axis.reasoning).toMatch(/keeping primary|secondary error/);
    expect(response.aggregate.verdict).toBe('ALLOW');
    expect(response.aggregate.rationale).toBe('All evaluated axes pass.');
  });

  it('i) primary UNCERTAIN + secondary ProviderCallError → REVIEW via provider provenance', async () => {
    // Escalation path only: primary never served a real judgment.
    const { result } = run([
      { kind: 'served', verdict: 'UNCERTAIN', confidence: 0.4 },
      { kind: 'provider-error', httpStatus: 503 },
    ]);
    const response = await result;
    const axis = response.axes[0]!;
    expect(axis.verdict).toBe('UNCERTAIN');
    expect(axis.provider_outcome).toBe('provider_error');
    expect(response.aggregate.verdict).toBe('REVIEW');
    expect(response.aggregate.rationale).toMatch(/provider\/auth failure/);
  });
});
