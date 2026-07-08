import { describe, it, expect } from 'vitest';
import { parseAxisResponse, StubCascade } from './cascade.js';

describe('parseAxisResponse', () => {
  it('parses clean JSON', () => {
    const r = parseAxisResponse(
      'intent',
      '{"verdict":"PASS","confidence":0.9,"reasoning":"good","objection":""}'
    );
    expect(r.verdict).toBe('PASS');
    expect(r.confidence).toBe(0.9);
    expect(r.reasoning).toBe('good');
  });

  it('parses fenced JSON blocks', () => {
    const r = parseAxisResponse(
      'scope',
      '```json\n{"verdict":"FAIL","confidence":0.8,"reasoning":"too broad","objection":"unlimited approval"}\n```'
    );
    expect(r.verdict).toBe('FAIL');
    expect(r.objection).toBe('unlimited approval');
  });

  it('parses JSON embedded in prose', () => {
    const r = parseAxisResponse(
      'risk',
      'Here is my analysis:\n\n{"verdict":"UNCERTAIN","confidence":0.5,"reasoning":"unclear","objection":""}\n\nHope that helps.'
    );
    expect(r.verdict).toBe('UNCERTAIN');
  });

  it('clamps confidence into [0,1]', () => {
    const r = parseAxisResponse(
      'consistency',
      '{"verdict":"PASS","confidence":1.5,"reasoning":"x","objection":""}'
    );
    expect(r.confidence).toBe(1);
  });

  it('defaults unknown verdict to UNCERTAIN', () => {
    const r = parseAxisResponse(
      'reversibility',
      '{"verdict":"MAYBE","confidence":0.5,"reasoning":"x","objection":""}'
    );
    expect(r.verdict).toBe('UNCERTAIN');
  });

  it('returns UNCERTAIN on unparseable output', () => {
    const r = parseAxisResponse('intent', 'not json at all');
    expect(r.verdict).toBe('UNCERTAIN');
    expect(r.confidence).toBe(0);
  });
});

describe('StubCascade', () => {
  it('returns UNCERTAIN for any axis', async () => {
    const cascade = new StubCascade();
    const out = await cascade.run({
      axis: 'intent',
      prompt: { system: 'x', user: 'y' },
      tier: 'checkpoint',
    });
    expect(out.result.verdict).toBe('UNCERTAIN');
    expect(out.modelsUsed).toEqual(['stub']);
  });
});
