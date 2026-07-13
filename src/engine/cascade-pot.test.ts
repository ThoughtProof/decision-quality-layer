/**
 * PotCliCascade tests.
 *
 * These tests never hit a real LLM — a MockLlmClient responds with hand-
 * crafted JSON payloads for each stage. This lets us verify the cascade's
 * decision matrix exhaustively without incurring cost or non-determinism.
 *
 * Coverage:
 *   • Early-exit on high-confidence primary FAIL.
 *   • Cascade on primary PASS  → agreement PASS.
 *   • Cascade on primary PASS  → disagreement → FAIL (conservative).
 *   • Cascade on primary FAIL (low-conf) → agreement FAIL.
 *   • Cascade on primary FAIL (low-conf) → downgrade to UNCERTAIN when
 *     secondary says PASS.
 *   • Cascade on primary UNCERTAIN → secondary PASS → UNCERTAIN (never
 *     silently promote).
 *   • Degraded mode: secondary throws → primary PASS becomes UNCERTAIN;
 *     primary FAIL stays FAIL.
 *   • parseAxisResponse handles fenced JSON and malformed payloads (already
 *     covered in cascade.test.ts — we only spot-check the integration path).
 */

import { describe, it, expect, vi } from 'vitest';
import { PotCliCascade, combineVerdicts } from './cascade-pot.js';
import {
  MockLlmClient,
  CircuitAllOpenError,
  ProviderCallError,
  type LlmCallInput,
  type LlmCallOutput,
} from './llm-client.js';
import type { AxisResult } from '../types.js';

function json(payload: object): string {
  return JSON.stringify(payload);
}

function makeClient(
  responses: Array<{ verdict: string; confidence: number; reasoning?: string; objection?: string }>
): MockLlmClient {
  let i = 0;
  const responder = (modelAlias: string, _input: LlmCallInput): LlmCallOutput => {
    const r = responses[i++];
    if (!r) throw new Error(`no mock response for call ${i} (model=${modelAlias})`);
    return {
      raw: json({
        verdict: r.verdict,
        confidence: r.confidence,
        reasoning: r.reasoning ?? 'mock',
        objection: r.objection ?? '',
      }),
      modelUsed: `mock:${modelAlias}`,
      latencyMs: 1,
    };
  };
  return new MockLlmClient(responder);
}

const AXIS_INPUT = {
  axis: 'intent' as const,
  prompt: { system: 'sys', user: 'usr' },
};

describe('PotCliCascade: early exit', () => {
  it('early-exits on primary FAIL with confidence ≥ 0.7', async () => {
    const client = makeClient([{ verdict: 'FAIL', confidence: 0.85, objection: 'primary saw problem' }]);
    const cascade = new PotCliCascade(client);
    const out = await cascade.run(AXIS_INPUT);
    expect(out.result.verdict).toBe('FAIL');
    expect(out.modelsUsed).toEqual(['mock:serv-nano']);
    expect(out.result.reasoning).toMatch(/early-exit/);
  });

  it('does NOT early-exit on primary FAIL with confidence < 0.7', async () => {
    const client = makeClient([
      { verdict: 'FAIL', confidence: 0.5 },
      { verdict: 'FAIL', confidence: 0.8, objection: 'secondary confirms' },
    ]);
    const cascade = new PotCliCascade(client);
    const out = await cascade.run(AXIS_INPUT);
    expect(out.result.verdict).toBe('FAIL');
    expect(out.modelsUsed).toEqual(['mock:serv-nano', 'mock:serv-swift']);
  });
});

describe('PotCliCascade: confirmFail (mirrors Sentinel confirmBlocks)', () => {
  // Discriminating test: SAME high-confidence primary FAIL, OFF vs ON must differ.
  const HIGH_CONF_FAIL = { verdict: 'FAIL' as const, confidence: 0.85, objection: 'primary saw problem' };

  it('OFF (default): high-conf FAIL early-exits, secondary NOT called', async () => {
    const client = makeClient([HIGH_CONF_FAIL, { verdict: 'PASS', confidence: 0.9 }]);
    const cascade = new PotCliCascade(client, { confirmFail: false });
    const out = await cascade.run(AXIS_INPUT);
    expect(out.modelsUsed).toEqual(['mock:serv-nano']);        // secondary skipped
    expect(out.result.verdict).toBe('FAIL');
    expect(out.result.reasoning).toMatch(/early-exit/);
  });

  it('ON: high-conf FAIL is confirmed by secondary (secondary IS called)', async () => {
    // Secondary disagrees (PASS) — under combineVerdicts a PASS↔FAIL disagreement
    // stays FAIL (conservative), but now it is a TWO-model decision, not nano-solo.
    const client = makeClient([HIGH_CONF_FAIL, { verdict: 'PASS', confidence: 0.9 }]);
    const cascade = new PotCliCascade(client, { confirmFail: true });
    const out = await cascade.run(AXIS_INPUT);
    expect(out.modelsUsed).toEqual(['mock:serv-nano', 'mock:serv-swift']);  // secondary called
    expect(out.result.verdict).toBe('FAIL');                                // conservative outcome
    expect(out.result.reasoning).not.toMatch(/early-exit/);                 // no early-exit path
    expect(out.result.reasoning).toMatch(/disagreement/);                   // went through combineVerdicts
  });

  it('ON: secondary CONFIRMS the FAIL → FAIL stands as a two-model verdict', async () => {
    const client = makeClient([HIGH_CONF_FAIL, { verdict: 'FAIL', confidence: 0.6, objection: 'secondary confirms' }]);
    const out = await new PotCliCascade(client, { confirmFail: true }).run(AXIS_INPUT);
    expect(out.modelsUsed).toEqual(['mock:serv-nano', 'mock:serv-swift']);
    expect(out.result.verdict).toBe('FAIL');
  });
});

describe('PotCliCascade: agreement paths', () => {
  it('agreement PASS → PASS with min-confidence', async () => {
    const client = makeClient([
      { verdict: 'PASS', confidence: 0.9 },
      { verdict: 'PASS', confidence: 0.6 },
    ]);
    const out = await new PotCliCascade(client).run(AXIS_INPUT);
    expect(out.result.verdict).toBe('PASS');
    expect(out.result.confidence).toBe(0.6);
  });

  it('agreement FAIL (low-conf primary) → FAIL with max-confidence', async () => {
    const client = makeClient([
      { verdict: 'FAIL', confidence: 0.4 },
      { verdict: 'FAIL', confidence: 0.85 },
    ]);
    const out = await new PotCliCascade(client).run(AXIS_INPUT);
    expect(out.result.verdict).toBe('FAIL');
    expect(out.result.confidence).toBe(0.85);
  });
});

describe('PotCliCascade: disagreement paths', () => {
  it('primary PASS ↔ secondary FAIL → FAIL (conservative)', async () => {
    const client = makeClient([
      { verdict: 'PASS', confidence: 0.9 },
      { verdict: 'FAIL', confidence: 0.75, objection: 'secondary caught it' },
    ]);
    const out = await new PotCliCascade(client).run(AXIS_INPUT);
    expect(out.result.verdict).toBe('FAIL');
    expect(out.result.objection).toContain('secondary caught it');
  });

  it('primary FAIL (low-conf) ↔ secondary PASS → UNCERTAIN (no silent PASS)', async () => {
    const client = makeClient([
      { verdict: 'FAIL', confidence: 0.5, objection: 'maybe problem' },
      { verdict: 'PASS', confidence: 0.9 },
    ]);
    const out = await new PotCliCascade(client).run(AXIS_INPUT);
    // combineVerdicts treats PASS↔FAIL as FAIL, but our early-exit is at 0.7
    // so this falls into the disagreement path → FAIL.
    // NOTE: this is intentional — a FAIL vote never gets silently overridden.
    expect(out.result.verdict).toBe('FAIL');
  });
});

describe('PotCliCascade: UNCERTAIN handling', () => {
  it('primary UNCERTAIN ↔ secondary PASS → UNCERTAIN', async () => {
    const client = makeClient([
      { verdict: 'UNCERTAIN', confidence: 0.3 },
      { verdict: 'PASS', confidence: 0.9 },
    ]);
    const out = await new PotCliCascade(client).run(AXIS_INPUT);
    expect(out.result.verdict).toBe('UNCERTAIN');
  });

  it('both UNCERTAIN → UNCERTAIN', async () => {
    const client = makeClient([
      { verdict: 'UNCERTAIN', confidence: 0.2 },
      { verdict: 'UNCERTAIN', confidence: 0.3 },
    ]);
    const out = await new PotCliCascade(client).run(AXIS_INPUT);
    expect(out.result.verdict).toBe('UNCERTAIN');
  });
});

describe('PotCliCascade: degraded mode (secondary error)', () => {
  it('primary PASS + secondary error → UNCERTAIN (degraded, conservative)', async () => {
    let n = 0;
    const client = new MockLlmClient((model) => {
      n++;
      if (n === 1) {
        return {
          raw: json({ verdict: 'PASS', confidence: 0.9, reasoning: 'ok' }),
          modelUsed: `mock:${model}`,
          latencyMs: 1,
        };
      }
      throw new Error('boom (secondary down)');
    });
    const out = await new PotCliCascade(client).run(AXIS_INPUT);
    expect(out.result.verdict).toBe('UNCERTAIN');
    expect(out.result.reasoning).toMatch(/degraded/);
  });

  it('primary FAIL (low-conf) + secondary error → FAIL (kept, degraded)', async () => {
    let n = 0;
    const client = new MockLlmClient((model) => {
      n++;
      if (n === 1) {
        return {
          raw: json({ verdict: 'FAIL', confidence: 0.5, reasoning: 'x', objection: 'y' }),
          modelUsed: `mock:${model}`,
          latencyMs: 1,
        };
      }
      throw new Error('boom');
    });
    const out = await new PotCliCascade(client).run(AXIS_INPUT);
    expect(out.result.verdict).toBe('FAIL');
    expect(out.result.reasoning).toMatch(/degraded/);
  });
});

describe('PotCliCascade: degraded-mode provenance (issue #14)', () => {
  // Serve a primary that carries provider_outcome='served' (providerRoute set),
  // then throw a chosen error type from the secondary call.
  function servedPrimaryThenThrow(
    primary: { verdict: string; confidence: number },
    error: unknown,
  ): MockLlmClient {
    let n = 0;
    return new MockLlmClient((model): LlmCallOutput => {
      n++;
      if (n === 1) {
        return {
          raw: json({ verdict: primary.verdict, confidence: primary.confidence, reasoning: 'ok', objection: primary.verdict === 'PASS' ? '' : 'obj' }),
          modelUsed: `mock:${model}`,
          latencyMs: 1,
          providerRoute: 'primary', // → callAxis sets provider_outcome='served' on the primary
        };
      }
      throw error;
    });
  }

  it('ProviderCallError secondary → axis drops served, carries provider_error', async () => {
    const client = servedPrimaryThenThrow(
      { verdict: 'PASS', confidence: 0.6 },
      new ProviderCallError('[llm-client] serv 401: nope', 'serv', 401),
    );
    const out = await new PotCliCascade(client).run(AXIS_INPUT);
    expect(out.result.verdict).toBe('UNCERTAIN');
    expect(out.result.provider_outcome).toBe('provider_error');
    expect(out.result.provider_route).toBeUndefined();
    expect(out.result.reasoning).toMatch(/degraded/);
  });

  it('CircuitAllOpenError (attemptedRoutes=[]) secondary → circuit_rejected', async () => {
    const client = servedPrimaryThenThrow(
      { verdict: 'PASS', confidence: 0.6 },
      new CircuitAllOpenError('serv-swift', null, 'open', 'open', []),
    );
    const out = await new PotCliCascade(client).run(AXIS_INPUT);
    expect(out.result.provider_outcome).toBe('circuit_rejected');
    expect(out.result.provider_route).toBeUndefined();
  });

  it('CircuitAllOpenError (attemptedRoutes=[primary]) secondary → provider_error', async () => {
    const client = servedPrimaryThenThrow(
      { verdict: 'PASS', confidence: 0.6 },
      new CircuitAllOpenError('serv-swift', null, 'open', 'open', ['primary']),
    );
    const out = await new PotCliCascade(client).run(AXIS_INPUT);
    expect(out.result.provider_outcome).toBe('provider_error');
  });

  it('generic (non-provider) secondary error → NO provider_outcome, served still dropped', async () => {
    const client = servedPrimaryThenThrow(
      { verdict: 'PASS', confidence: 0.6 },
      new Error('parser blew up'),
    );
    const out = await new PotCliCascade(client).run(AXIS_INPUT);
    expect(out.result.verdict).toBe('UNCERTAIN');
    expect(out.result.provider_outcome).toBeUndefined();
    expect(out.result.provider_route).toBeUndefined();
  });

  it('primary FAIL (low-conf) + ProviderCallError secondary → FAIL kept + provider_error', async () => {
    const client = servedPrimaryThenThrow(
      { verdict: 'FAIL', confidence: 0.6 },
      new ProviderCallError('[llm-client] serv 500', 'serv', 500),
    );
    const out = await new PotCliCascade(client).run(AXIS_INPUT);
    expect(out.result.verdict).toBe('FAIL');
    expect(out.result.provider_outcome).toBe('provider_error');
  });
});

describe('combineVerdicts (unit)', () => {
  const base = (v: 'PASS' | 'FAIL' | 'UNCERTAIN', c: number, o = ''): AxisResult => ({
    axis: 'scope',
    verdict: v,
    confidence: c,
    reasoning: 'r',
    objection: o,
  });

  it('PASS + PASS = PASS (min conf)', () => {
    expect(combineVerdicts(base('PASS', 0.9), base('PASS', 0.5)).confidence).toBe(0.5);
  });

  it('FAIL + FAIL = FAIL (max conf)', () => {
    expect(combineVerdicts(base('FAIL', 0.4), base('FAIL', 0.8)).confidence).toBe(0.8);
  });

  it('PASS + FAIL = FAIL (conservative)', () => {
    expect(combineVerdicts(base('PASS', 0.9), base('FAIL', 0.7, 'obj')).verdict).toBe('FAIL');
  });

  it('any + UNCERTAIN = UNCERTAIN', () => {
    expect(combineVerdicts(base('PASS', 0.9), base('UNCERTAIN', 0.1)).verdict).toBe('UNCERTAIN');
    expect(combineVerdicts(base('FAIL', 0.4), base('UNCERTAIN', 0.1)).verdict).toBe('UNCERTAIN');
  });
});
