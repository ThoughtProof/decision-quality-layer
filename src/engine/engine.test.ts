import { describe, it, expect } from 'vitest';
import { runVerification } from './index.js';
import { StubCascade } from './cascade.js';
import { SandboxCascade } from './sandbox-cascade.js';
import { CircuitAllOpenError } from './llm-client.js';
import type { Cascade, CascadeInput, CascadeOutput } from './cascade.js';
import type { AxisResult, DqlRequest } from '../types.js';

class ScriptedCascade implements Cascade {
  constructor(private readonly script: (axis: string) => AxisResult) {}
  async run(input: CascadeInput): Promise<CascadeOutput> {
    return { result: this.script(input.axis), modelsUsed: ['scripted'] };
  }
}

const req: Required<Omit<DqlRequest, 'context' | 'structured_context' | 'gate_mode'>> & Pick<DqlRequest, 'context' | 'structured_context' | 'gate_mode'> = {
  mandate: 'Swap 100 USDC to ETH',
  proposed_action: 'Approve USDC and swap',
  reasoning: 'User asked for it',
  axes: ['intent', 'scope', 'risk', 'consistency', 'reversibility'],
  sandbox: false,
  context: undefined,
};

const sandbox = new SandboxCascade();

describe('runVerification', () => {
  it('returns ALLOW when all axes PASS', async () => {
    const cascade = new ScriptedCascade((axis) => ({
      axis: axis as AxisResult['axis'],
      verdict: 'PASS',
      confidence: 0.9,
      reasoning: 'ok',
      objection: '',
    }));

    const out = await runVerification({
      request: req,
      cascade,
      sandboxCascade: sandbox,
      requestId: 'test_1',
      version: '0.1.0',
    });

    expect(out.aggregate.verdict).toBe('ALLOW');
    expect(out.axes).toHaveLength(5);
    expect(out.meta.axes_evaluated).toEqual(req.axes);
    expect(out.meta.sandbox).toBe(false);
  });

  it('returns BLOCK when one axis high-confidence FAILs', async () => {
    const cascade = new ScriptedCascade((axis) => ({
      axis: axis as AxisResult['axis'],
      verdict: axis === 'scope' ? 'FAIL' : 'PASS',
      confidence: 0.9,
      reasoning: 'x',
      objection: axis === 'scope' ? 'over-broad approval' : '',
    }));

    const out = await runVerification({
      request: req,
      cascade,
      sandboxCascade: sandbox,
      requestId: 'test_2',
      version: '0.1.0',
    });

    expect(out.aggregate.verdict).toBe('BLOCK');
    expect(out.aggregate.triggered_by).toEqual(['scope']);
  });

  it('maps cascade errors to UNCERTAIN axis results', async () => {
    const cascade: Cascade = {
      async run(input: CascadeInput): Promise<CascadeOutput> {
        if (input.axis === 'risk') throw new Error('model 503');
        return {
          result: {
            axis: input.axis,
            verdict: 'PASS',
            confidence: 0.9,
            reasoning: 'ok',
            objection: '',
          },
          modelsUsed: ['ok'],
        };
      },
    };

    const out = await runVerification({
      request: req,
      cascade,
      sandboxCascade: sandbox,
      requestId: 'test_3',
      version: '0.1.0',
    });

    const risk = out.axes.find((a) => a.axis === 'risk')!;
    expect(risk.verdict).toBe('UNCERTAIN');
    expect(risk.objection).toContain('model 503');
    // 1 UNCERTAIN at conf 0 (not high-conf, not ≥2) → falls through to ALLOW
    expect(out.aggregate.verdict).toBe('ALLOW');
  });

  it('routes to sandbox cascade when sandbox=true, marks meta.sandbox', async () => {
    const cascade = new StubCascade(); // should NOT be used when sandbox=true
    const out = await runVerification({
      request: { ...req, sandbox: true },
      cascade,
      sandboxCascade: sandbox,
      requestId: 'test_4',
      version: '0.1.0',
    });

    expect(out.meta.sandbox).toBe(true);
    expect(out.meta.models_used).toContain('sandbox');
    expect(out.meta.models_used).not.toContain('stub');
    expect(out.axes).toHaveLength(5);
  });

  it('sandbox cascade is deterministic for identical inputs', async () => {
    const a = await runVerification({
      request: { ...req, sandbox: true },
      cascade: new StubCascade(),
      sandboxCascade: sandbox,
      requestId: 'test_5a',
      version: '0.1.0',
    });
    const b = await runVerification({
      request: { ...req, sandbox: true },
      cascade: new StubCascade(),
      sandboxCascade: sandbox,
      requestId: 'test_5b',
      version: '0.1.0',
    });
    const aVerdicts = a.axes.map((x) => x.verdict + ':' + x.confidence).join('|');
    const bVerdicts = b.axes.map((x) => x.verdict + ':' + x.confidence).join('|');
    expect(aVerdicts).toBe(bVerdicts);
  });

  it('maps CircuitAllOpenError to UNCERTAIN@0 with a fail-closed objection (PR #10)', async () => {
    // Simulate a full-provider outage: cascade always throws CircuitAllOpenError.
    const outageCascade: Cascade = {
      async run(): Promise<CascadeOutput> {
        throw new CircuitAllOpenError(
          'serv-nano',
          'serv-swift',
          'failure rate 100% ≥ 50% over 5 samples',
          'failure rate 100% ≥ 50% over 5 samples'
        );
      },
    };

    const out = await runVerification({
      request: req,
      cascade: outageCascade,
      sandboxCascade: sandbox,
      requestId: 'test_outage',
      version: '0.1.0',
    });

    // Every axis must be UNCERTAIN@0 with the fail-closed marker in objection.
    // v0.4.3.1 (§C.3): provider_route is undefined (no route served) and
    // provider_outcome is 'circuit_rejected' (circuit-breaker rejected the call).
    for (const axis of out.axes) {
      expect(axis.verdict).toBe('UNCERTAIN');
      expect(axis.confidence).toBe(0);
      expect(axis.objection).toMatch(/Provider outage/);
      expect(axis.objection).toMatch(/circuit-open/);
      expect(axis.provider_route).toBeUndefined();
      expect(axis.provider_outcome).toBe('circuit_rejected');
    }

    // Aggregate must NOT be ALLOW under provider outage. UNCERTAIN axes can
    // only aggregate to REVIEW or BLOCK — that is the fail-closed contract.
    expect(out.aggregate.verdict).not.toBe('ALLOW');
  });

  // ── ADR-0020 structural pre-check ──────────────────────────────────────

  it('attaches silent structural field by default (no structured_context)', async () => {
    let cascadeCalls = 0;
    const cascade = new ScriptedCascade((axis) => {
      cascadeCalls += 1;
      return {
        axis: axis as AxisResult['axis'],
        verdict: 'PASS',
        confidence: 0.9,
        reasoning: 'ok',
        objection: '',
      };
    });

    const out = await runVerification({
      request: req,
      cascade,
      sandboxCascade: sandbox,
      requestId: 'test_struct_silent',
      version: '0.1.0',
    });

    expect(out.structural).toBeDefined();
    expect(out.structural!.silent).toBe(true);
    expect(out.structural!.mode).toBe('shadow');
    expect(out.structural!.would_block).toBe(false);
    expect(out.structural!.enforced).toBe(false);
    expect(cascadeCalls).toBe(5);
    expect(out.aggregate.verdict).toBe('ALLOW');
  });

  it('shadow mode detects amount overshoot but still runs cascade', async () => {
    let cascadeCalls = 0;
    const cascade = new ScriptedCascade((axis) => {
      cascadeCalls += 1;
      return {
        axis: axis as AxisResult['axis'],
        verdict: 'PASS',
        confidence: 0.9,
        reasoning: 'ok',
        objection: '',
      };
    });

    const out = await runVerification({
      request: {
        ...req,
        gate_mode: 'shadow',
        structured_context: {
          granted: { max_amount: 100, amount_currency: 'EUR' },
          proposed: { amount: 1000, amount_currency: 'EUR' },
        },
      },
      cascade,
      sandboxCascade: sandbox,
      requestId: 'test_struct_shadow',
      version: '0.1.0',
    });

    expect(out.structural!.would_block).toBe(true);
    expect(out.structural!.enforced).toBe(false);
    expect(out.structural!.violations.map((v) => v.kind)).toEqual(['amount_overshoot']);
    // Cascade still ran — shadow does not gate.
    expect(cascadeCalls).toBe(5);
    // Scripted cascade all-PASS → ALLOW despite structural would_block.
    expect(out.aggregate.verdict).toBe('ALLOW');
  });

  it('enforce mode short-circuits cascade on hard violation → BLOCK', async () => {
    let cascadeCalls = 0;
    const cascade = new ScriptedCascade((axis) => {
      cascadeCalls += 1;
      return {
        axis: axis as AxisResult['axis'],
        verdict: 'PASS',
        confidence: 0.9,
        reasoning: 'should not run',
        objection: '',
      };
    });

    const out = await runVerification({
      request: {
        ...req,
        gate_mode: 'enforce',
        structured_context: {
          granted: { max_amount: 200, recipient: 'alice' },
          proposed: { amount: 2000, recipient: 'mallory' },
        },
      },
      cascade,
      sandboxCascade: sandbox,
      requestId: 'test_struct_enforce',
      version: '0.1.0',
    });

    expect(cascadeCalls).toBe(0);
    expect(out.structural!.enforced).toBe(true);
    expect(out.structural!.would_block).toBe(true);
    expect(out.aggregate.verdict).toBe('BLOCK');
    expect(out.meta.models_used).toEqual([]);
    const scope = out.axes.find((a) => a.axis === 'scope')!;
    expect(scope.verdict).toBe('FAIL');
    expect(scope.confidence).toBe(1);
    expect(scope.objection.length).toBeGreaterThan(0);

    // Probe 2 / MAJOR-1 fix: skipped axes are UNCERTAIN@0 — never fabricated PASS.
    const skipped = out.axes.filter((a) => a.axis !== 'scope');
    expect(skipped.length).toBeGreaterThan(0);
    for (const a of skipped) {
      expect(a.verdict).toBe('UNCERTAIN');
      expect(a.confidence).toBe(0);
      expect(a.reasoning).toMatch(/skipped — structural enforce short-circuit/);
      expect(a.provider_outcome).toBeUndefined();
      expect(a.verdict).not.toBe('PASS');
    }
  });

  it('enforce mode with clean structured_context still runs cascade', async () => {
    let cascadeCalls = 0;
    const cascade = new ScriptedCascade((axis) => {
      cascadeCalls += 1;
      return {
        axis: axis as AxisResult['axis'],
        verdict: 'PASS',
        confidence: 0.9,
        reasoning: 'ok',
        objection: '',
      };
    });

    const out = await runVerification({
      request: {
        ...req,
        gate_mode: 'enforce',
        structured_context: {
          granted: { max_amount: 500, recipient: 'alice' },
          proposed: { amount: 200, recipient: 'Alice' },
        },
      },
      cascade,
      sandboxCascade: sandbox,
      requestId: 'test_struct_enforce_clean',
      version: '0.1.0',
    });

    expect(cascadeCalls).toBe(5);
    expect(out.structural!.would_block).toBe(false);
    expect(out.structural!.enforced).toBe(false);
    expect(out.aggregate.verdict).toBe('ALLOW');
  });
});
