import { describe, it, expect } from 'vitest';
import { runVerification } from './index.js';
import { StubCascade } from './cascade.js';
import { SandboxCascade } from './sandbox-cascade.js';
import type { Cascade, CascadeInput, CascadeOutput } from './cascade.js';
import type { AxisResult, DqlRequest } from '../types.js';

class ScriptedCascade implements Cascade {
  constructor(private readonly script: (axis: string) => AxisResult) {}
  async run(input: CascadeInput): Promise<CascadeOutput> {
    return { result: this.script(input.axis), modelsUsed: ['scripted'] };
  }
}

const req: Required<Omit<DqlRequest, 'context'>> & Pick<DqlRequest, 'context'> = {
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
});
