import { describe, it, expect } from 'vitest';
import { parseAxisResponse, StubCascade, isConsistencyChecklistMatch, isMaterialImmediateSettle, isModelRefusal } from './cascade.js';

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

  it('defaults missing confidence on PASS (never PASS@0)', () => {
    const r = parseAxisResponse(
      'scope',
      '{"verdict":"PASS","reasoning":"in scope","objection":""}'
    );
    expect(r.verdict).toBe('PASS');
    expect(r.confidence).toBe(0.7);
  });

  it('floors explicit PASS confidence 0 to mid default', () => {
    const r = parseAxisResponse(
      'scope',
      '{"verdict":"PASS","confidence":0,"reasoning":"ok","objection":""}'
    );
    expect(r.verdict).toBe('PASS');
    expect(r.confidence).toBe(0.7);
  });

  it('maps model refusal to UNCERTAIN@0 with provider_error (not a judgment)', () => {
    const r = parseAxisResponse(
      'consistency',
      '{"verdict":"UNCERTAIN","confidence":0.86,"reasoning":"I can\'t share that.","objection":"I can\'t share that."}',
    );
    expect(r.verdict).toBe('UNCERTAIN');
    expect(r.confidence).toBe(0);
    expect(r.provider_outcome).toBe('provider_error');
    expect(r.objection).toMatch(/refusal/i);
    expect(r.objection).not.toMatch(/can'?t share/i);
  });

  it('maps mandate prompt-echo UNCERTAIN to low-conf incomplete (not Rule-5 REVIEW bait)', () => {
    const r = parseAxisResponse(
      'risk',
      JSON.stringify({
        verdict: 'UNCERTAIN',
        confidence: 0.78,
        reasoning:
          'The mandate states: "Book me a week in Mallorca in September, under €800". The user acknowledges: - Budget ceiling: €800 (explicit parameter) - Duration: one week - Destination: Mallorca',
        objection: '',
      }),
    );
    expect(r.verdict).toBe('UNCERTAIN');
    // Below aggregation Rule 5 threshold (0.7); no provider_outcome so Rule 2
    // does not force REVIEW either. Clean content axes can still ALLOW.
    expect(r.confidence).toBe(0.4);
    expect(r.provider_outcome).toBeUndefined();
    expect(r.reasoning).toMatch(/restated the mandate/i);
  });

  it('does not flag real risk analysis as prompt echo', () => {
    const r = parseAxisResponse(
      'risk',
      JSON.stringify({
        verdict: 'PASS',
        confidence: 0.78,
        reasoning:
          'Routine travel booking under a stated budget. Downside is limited to cancellation fees; risk profile matches a low-to-moderate stakes vacation purchase.',
        objection: '',
      }),
    );
    expect(r.verdict).toBe('PASS');
    expect(r.confidence).toBe(0.78);
    expect(r.provider_outcome).toBeUndefined();
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
    });
    expect(out.result.verdict).toBe('UNCERTAIN');
    expect(out.modelsUsed).toEqual(['stub']);
  });
});


describe('calib helpers FAR/FBR', () => {
  it('detects bare refusal objection alone', () => {
    expect(isModelRefusal("I can't share that.")).toBe(true);
    const r = parseAxisResponse(
      'reversibility',
      JSON.stringify({
        verdict: 'UNCERTAIN',
        confidence: 0.98,
        reasoning: 'Long analysis about payroll windows and history signals that is not itself a refusal.',
        objection: "I can't share that.",
      }),
    );
    expect(r.confidence).toBe(0);
    expect(r.provider_outcome).toBe('provider_error');
    expect(r.objection).toMatch(/refusal/i);
  });

  it('rewrites consistency checklist dump UNCERTAIN → PASS', () => {
    const dump = `# CONSISTENCY VERIFICATION

## STEP 1 — Direct Execution Check

**Mandate parameters:**
- Action: Draft a follow-up email
- Recipient: the customer

**Proposed action parameters:**
- action: email.create_draft ✓
- send_immediately: false ✓
- save_to: drafts_folder ✓

Checklist: Action match ✓ Recipient match ✓ No send ✓
`;
    expect(isConsistencyChecklistMatch(dump)).toBe(true);
    const r = parseAxisResponse(
      'consistency',
      JSON.stringify({
        verdict: 'UNCERTAIN',
        confidence: 0.86,
        reasoning: dump,
        objection: dump,
      }),
    );
    expect(r.verdict).toBe('PASS');
    expect(r.objection).toBe('');
  });

  it('floors material immediate settle reversibility conf to trigger REVIEW', () => {
    expect(
      isMaterialImmediateSettle(
        'Human confirmation is required before executing an immediate market sell that settles externally',
      ),
    ).toBe(true);
    const r = parseAxisResponse(
      'reversibility',
      JSON.stringify({
        verdict: 'UNCERTAIN',
        confidence: 0.55,
        reasoning: 'Immediate market order at material size.',
        objection:
          'Human confirmation is required before executing an immediate market sell that settles externally; no cancel window.',
      }),
    );
    expect(r.verdict).toBe('UNCERTAIN');
    expect(r.confidence).toBeGreaterThanOrEqual(0.75);
  });
});
