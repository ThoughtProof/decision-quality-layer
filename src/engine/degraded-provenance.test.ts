/**
 * Issue #24 (decouple primary-verdict preservation from provider-failure
 * provenance suppression) — restores the issue #14 fail-closed guarantee
 * while keeping the legitimate Guardian-UX verdict-preservation fix from
 * PR #22.
 *
 * Complements the §D6 whole-cascade tests in `engine-provider-outcome.test.ts`.
 * D6 covers "the ENTIRE cascade throws" (engine catch sets provenance). This
 * file covers the complementary composition path D6 did NOT: "primary
 * SERVED, secondary THROWS". There the error is caught INSIDE
 * PotCliCascade.run — the cascade returns normally, the engine's D6 catch
 * never fires.
 *
 * Product contract (cascade-pot.ts, post issue #24 fix):
 *   - Primary PASS/FAIL/UNCERTAIN + secondary real failure → KEEP the
 *     primary's verdict/confidence/reasoning (do NOT demote PASS/FAIL to
 *     UNCERTAIN — that was the legitimate Guardian-UX fix from PR #22,
 *     demo 2026-07-21) BUT attach truthful provider_error | circuit_rejected
 *     provenance via classifySecondaryFailure(), never 'served'.
 *   - Aggregation Rule 2 (src/aggregation.ts, untouched by this fix) then
 *     escalates ANY axis carrying that provenance to REVIEW-or-stricter,
 *     independent of confidence — this is what closes the fail-open gap.
 *   - Generic (non-provider) secondary errors carry NO provider provenance
 *     (mirrors the engine's §D6 negative discrimination) — verdict is still
 *     kept, but Rule 2 does not fire for those.
 *
 * Mapping to the original issue #14 acceptance table (pre-face93d7, PR #15,
 * commit f297e7e) — same discriminating cases, updated for verdict
 * preservation (axis verdict now stays PASS/FAIL instead of being demoted to
 * UNCERTAIN; the REVIEW/BLOCK/ALLOW outcome and provenance truthfulness
 * guarantees are unchanged):
 *   a  secondary ProviderCallError + primary PASS conf<0.7   → REVIEW, PASS kept
 *   b  secondary ProviderCallError + primary PASS conf>=0.7  → REVIEW via
 *      provenance (NOT confidence), PASS kept
 *   c  generic (non-provider) secondary error                → baseline policy
 *      preserved (PASS kept, no provenance → ALLOW)
 *   d  primary FAIL conf 0.5–0.7 + secondary failure          → REVIEW, FAIL
 *      not weakened
 *   e  primary high-conf FAIL early-exit (secondary skipped)  → BLOCK
 *   f  both draws served                                      → unchanged
 *   g1 CircuitAllOpenError attemptedRoutes=[] → circuit_rejected, REVIEW, PASS kept
 *   g2 CircuitAllOpenError attemptedRoutes=[primary] → provider_error, REVIEW, PASS kept
 *   h  truth assertions: degraded axis never carries 'served'; rationale is
 *      truthful (NEVER "All evaluated axes pass." when a real provider
 *      failure occurred)
 *   i  primary UNCERTAIN + secondary ProviderCallError        → REVIEW via
 *      provenance, verdict stays UNCERTAIN
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
      requestId: 'dql_issue24',
      version: '0.4.3.1-test',
    }),
  };
}

describe('Issue #24 — secondary-failure provenance decoupled from verdict preservation (engine↔aggregation)', () => {
  it('a) secondary ProviderCallError + primary PASS conf<0.7 → REVIEW, PASS kept (not ALLOW)', async () => {
    const { result } = run([
      { kind: 'served', verdict: 'PASS', confidence: 0.6 },
      { kind: 'provider-error', httpStatus: 401 },
    ]);
    const response = await result;
    const axis = response.axes[0]!;
    expect(axis.verdict).toBe('PASS'); // verdict preserved — NOT demoted to UNCERTAIN
    expect(axis.confidence).toBe(0.6);
    expect(axis.provider_outcome).toBe('provider_error');
    expect(response.aggregate.verdict).toBe('REVIEW');
    expect(response.aggregate.triggered_by).toEqual(['intent']);
    expect(response.aggregate.rationale).not.toBe('All evaluated axes pass.');
  });

  it('b) secondary ProviderCallError + primary PASS conf>=0.7 → REVIEW via PROVENANCE, not confidence; PASS kept', async () => {
    const { result } = run([
      { kind: 'served', verdict: 'PASS', confidence: 0.85 },
      { kind: 'provider-error', httpStatus: 503 },
    ]);
    const response = await result;
    const axis = response.axes[0]!;
    expect(axis.verdict).toBe('PASS');
    expect(axis.confidence).toBe(0.85);
    expect(axis.provider_outcome).toBe('provider_error');
    expect(response.aggregate.verdict).toBe('REVIEW');
    // Prove it is Rule 2 (provider provenance), NOT a confidence-driven rule:
    // Rule 2's rationale names a provider/auth failure.
    expect(response.aggregate.rationale).toMatch(/provider\/auth failure/);
    expect(response.aggregate.rationale).not.toBe('All evaluated axes pass.');
  });

  it('c) generic (non-provider) secondary error → baseline preserved (PASS kept, no provenance, ALLOW)', async () => {
    const { result } = run([
      { kind: 'served', verdict: 'PASS', confidence: 0.6 },
      { kind: 'generic-error' },
    ]);
    const response = await result;
    const axis = response.axes[0]!;
    expect(axis.verdict).toBe('PASS');
    // Deliberate policy: a generic (non-classifiable) error carries NO
    // provider provenance (mirrors the engine's §D6 negative discrimination),
    // so Rule 2 does not fire and the primary verdict stands as-is.
    expect(axis.provider_outcome).toBeUndefined();
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
    expect(axis.verdict).toBe('FAIL'); // secondary failure must NOT weaken FAIL → UNCERTAIN
    expect(axis.confidence).toBe(0.6);
    expect(axis.provider_outcome).toBe('provider_error');
    expect(response.aggregate.verdict).toBe('REVIEW'); // Rule 2 (provider provenance)
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

  it('g1) secondary CircuitAllOpenError attemptedRoutes=[] + primary PASS → circuit_rejected, REVIEW, PASS kept', async () => {
    const { result } = run([
      { kind: 'served', verdict: 'PASS', confidence: 0.6 },
      { kind: 'circuit-all-open', attemptedRoutes: [] },
    ]);
    const response = await result;
    const axis = response.axes[0]!;
    expect(axis.verdict).toBe('PASS');
    expect(axis.provider_outcome).toBe('circuit_rejected');
    expect(response.aggregate.verdict).toBe('REVIEW');
  });

  it('g2) secondary CircuitAllOpenError attemptedRoutes=[primary] + primary PASS → provider_error, REVIEW, PASS kept', async () => {
    const { result } = run([
      { kind: 'served', verdict: 'PASS', confidence: 0.6 },
      { kind: 'circuit-all-open', attemptedRoutes: ['primary'] },
    ]);
    const response = await result;
    const axis = response.axes[0]!;
    expect(axis.verdict).toBe('PASS');
    expect(axis.provider_outcome).toBe('provider_error');
    expect(response.aggregate.verdict).toBe('REVIEW');
  });

  it('h) truth: degraded axis never carries served; rationale is truthful (not "All evaluated axes pass.")', async () => {
    const { result } = run([
      { kind: 'served', verdict: 'PASS', confidence: 0.65 },
      { kind: 'provider-error', httpStatus: 401 },
    ]);
    const response = await result;
    const axis = response.axes[0]!;
    expect(axis.provider_outcome).not.toBe('served');
    expect(axis.verdict).toBe('PASS'); // verdict preservation still holds
    expect(response.aggregate.verdict).not.toBe('ALLOW');
    expect(response.aggregate.rationale).not.toBe('All evaluated axes pass.');
  });

  it('i) primary UNCERTAIN + secondary ProviderCallError → REVIEW via provider provenance, verdict stays UNCERTAIN', async () => {
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
