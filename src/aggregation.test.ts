import { describe, it, expect } from 'vitest';
import { aggregate } from './aggregation.js';
import type { AxisResult, Axis, AxisVerdict } from './types.js';

function ax(axis: Axis, verdict: AxisVerdict, confidence = 0.9): AxisResult {
  return {
    axis,
    verdict,
    confidence,
    reasoning: 'test',
    objection: verdict === 'PASS' ? '' : 'test objection',
  };
}

/** UNCERTAIN@confidence=0 axis carrying structured provider provenance. */
function providerFailedAx(
  axis: Axis,
  outcome: 'provider_error' | 'circuit_rejected',
): AxisResult {
  return {
    axis,
    verdict: 'UNCERTAIN',
    confidence: 0,
    reasoning: 'provider failure',
    objection: 'provider failure',
    provider_outcome: outcome,
  };
}

describe('aggregate', () => {
  it('returns ALLOW when every axis passes', () => {
    const r = aggregate([
      ax('intent', 'PASS'),
      ax('scope', 'PASS'),
      ax('risk', 'PASS'),
      ax('consistency', 'PASS'),
      ax('reversibility', 'PASS'),
    ]);
    expect(r.verdict).toBe('ALLOW');
    expect(r.triggered_by).toEqual([]);
  });

  it('returns BLOCK when any axis FAILs with high confidence', () => {
    const r = aggregate([
      ax('intent', 'PASS'),
      ax('scope', 'FAIL', 0.9),
      ax('risk', 'PASS'),
      ax('consistency', 'PASS'),
      ax('reversibility', 'PASS'),
    ]);
    expect(r.verdict).toBe('BLOCK');
    expect(r.triggered_by).toEqual(['scope']);
    expect(r.confidence).toBe(0.9);
  });

  it('returns REVIEW on mid-confidence FAIL', () => {
    const r = aggregate([
      ax('intent', 'PASS'),
      ax('scope', 'FAIL', 0.6),
      ax('risk', 'PASS'),
      ax('consistency', 'PASS'),
      ax('reversibility', 'PASS'),
    ]);
    expect(r.verdict).toBe('REVIEW');
    expect(r.triggered_by).toEqual(['scope']);
  });

  it('returns REVIEW on two UNCERTAINs even without any FAIL', () => {
    const r = aggregate([
      ax('intent', 'PASS'),
      ax('scope', 'UNCERTAIN', 0.5),
      ax('risk', 'UNCERTAIN', 0.5),
      ax('consistency', 'PASS'),
      ax('reversibility', 'PASS'),
    ]);
    expect(r.verdict).toBe('REVIEW');
    expect(r.triggered_by).toEqual(['scope', 'risk']);
  });

  it('returns REVIEW on single high-confidence UNCERTAIN', () => {
    const r = aggregate([
      ax('intent', 'PASS'),
      ax('scope', 'PASS'),
      ax('risk', 'UNCERTAIN', 0.85),
      ax('consistency', 'PASS'),
      ax('reversibility', 'PASS'),
    ]);
    expect(r.verdict).toBe('REVIEW');
    expect(r.triggered_by).toEqual(['risk']);
  });

  it('BLOCK takes precedence over UNCERTAIN', () => {
    const r = aggregate([
      ax('intent', 'FAIL', 0.9),
      ax('scope', 'UNCERTAIN', 0.9),
      ax('risk', 'UNCERTAIN', 0.9),
      ax('consistency', 'PASS'),
      ax('reversibility', 'PASS'),
    ]);
    expect(r.verdict).toBe('BLOCK');
    expect(r.triggered_by).toEqual(['intent']);
  });

  it('multiple high-confidence FAILs all appear in triggered_by', () => {
    const r = aggregate([
      ax('intent', 'FAIL', 0.9),
      ax('scope', 'FAIL', 0.8),
      ax('risk', 'PASS'),
      ax('consistency', 'PASS'),
      ax('reversibility', 'PASS'),
    ]);
    expect(r.verdict).toBe('BLOCK');
    expect(r.triggered_by).toEqual(['intent', 'scope']);
    expect(r.confidence).toBe(0.9);
  });

  it('ALLOW confidence is the min PASS confidence', () => {
    const r = aggregate([
      ax('intent', 'PASS', 0.95),
      ax('scope', 'PASS', 0.72),
      ax('risk', 'PASS', 0.88),
      ax('consistency', 'PASS', 0.91),
      ax('reversibility', 'PASS', 0.85),
    ]);
    expect(r.verdict).toBe('ALLOW');
    expect(r.confidence).toBe(0.72);
  });

  it('empty axis list returns REVIEW', () => {
    const r = aggregate([]);
    expect(r.verdict).toBe('REVIEW');
    expect(r.confidence).toBe(0);
  });

  // ---- VERTRAGSÄNDERUNG §D6-fix: provider/auth failure escalation ----------

  it('single provider_error UNCERTAIN@0 → REVIEW (not ALLOW), truthful rationale', () => {
    const r = aggregate([
      ax('intent', 'PASS'),
      ax('scope', 'PASS'),
      providerFailedAx('risk', 'provider_error'),
      ax('consistency', 'PASS'),
      ax('reversibility', 'PASS'),
    ]);
    expect(r.verdict).toBe('REVIEW');
    expect(r.triggered_by).toEqual(['risk']);
    expect(r.rationale).toContain('risk');
    expect(r.rationale).not.toBe('All evaluated axes pass.');
    expect(r.rationale).toMatch(/could not be evaluated|provider/i);
  });

  it('single circuit_rejected UNCERTAIN@0 → REVIEW (not ALLOW)', () => {
    const r = aggregate([
      ax('intent', 'PASS'),
      providerFailedAx('scope', 'circuit_rejected'),
      ax('risk', 'PASS'),
      ax('consistency', 'PASS'),
      ax('reversibility', 'PASS'),
    ]);
    expect(r.verdict).toBe('REVIEW');
    expect(r.triggered_by).toEqual(['scope']);
    expect(r.rationale).not.toBe('All evaluated axes pass.');
  });

  it('NEGATIVE DISCRIMINATION: single UNCERTAIN@0 WITHOUT provider provenance still ALLOWs (policy preserved)', () => {
    const r = aggregate([
      ax('intent', 'PASS'),
      ax('scope', 'PASS'),
      ax('risk', 'UNCERTAIN', 0), // no provider_outcome → deliberate pre-fix policy
      ax('consistency', 'PASS'),
      ax('reversibility', 'PASS'),
    ]);
    expect(r.verdict).toBe('ALLOW');
    expect(r.triggered_by).toEqual([]);
  });

  it("NEGATIVE DISCRIMINATION: provider_outcome==='served' is NOT a failure (does not escalate)", () => {
    const served: AxisResult = {
      axis: 'risk',
      verdict: 'PASS',
      confidence: 0.9,
      reasoning: 'ok',
      objection: '',
      provider_outcome: 'served',
      provider_route: 'primary',
    };
    const r = aggregate([
      ax('intent', 'PASS'),
      ax('scope', 'PASS'),
      served,
      ax('consistency', 'PASS'),
      ax('reversibility', 'PASS'),
    ]);
    expect(r.verdict).toBe('ALLOW');
  });

  it('high-confidence FAIL still BLOCKs even when another axis had a provider failure (BLOCK precedence)', () => {
    const r = aggregate([
      ax('intent', 'FAIL', 0.9),
      providerFailedAx('scope', 'provider_error'),
      ax('risk', 'PASS'),
      ax('consistency', 'PASS'),
      ax('reversibility', 'PASS'),
    ]);
    expect(r.verdict).toBe('BLOCK');
    expect(r.triggered_by).toEqual(['intent']);
  });

  // ---- Suite v1 Item 3: REVIEW middle-lane ---------------------------------

  it('Item 3 middle-lane: content clean + only reversibility FAIL → REVIEW (not BLOCK)', () => {
    const r = aggregate([
      ax('intent', 'PASS'),
      ax('scope', 'PASS'),
      ax('risk', 'PASS'),
      ax('consistency', 'PASS'),
      ax('reversibility', 'FAIL', 0.86),
    ]);
    expect(r.verdict).toBe('REVIEW');
    expect(r.triggered_by).toEqual(['reversibility']);
    expect(r.rationale).toMatch(/Human confirmation|go-button|REVIEW/i);
    expect(r.rationale).not.toMatch(/^Blocked on/);
  });

  it('Item 3 middle-lane: content clean + risk+reversibility FAIL → REVIEW', () => {
    const r = aggregate([
      ax('intent', 'PASS'),
      ax('scope', 'PASS'),
      ax('risk', 'FAIL', 0.78),
      ax('consistency', 'PASS'),
      ax('reversibility', 'FAIL', 0.86),
    ]);
    expect(r.verdict).toBe('REVIEW');
    expect(r.triggered_by).toEqual(['risk', 'reversibility']);
  });

  it('Item 3: content-broken scope FAIL still BLOCKs (not middle-lane)', () => {
    const r = aggregate([
      ax('intent', 'PASS'),
      ax('scope', 'FAIL', 0.9),
      ax('risk', 'PASS'),
      ax('consistency', 'PASS'),
      ax('reversibility', 'PASS'),
    ]);
    expect(r.verdict).toBe('BLOCK');
    expect(r.triggered_by).toEqual(['scope']);
    expect(r.rationale).toMatch(/content-axis/i);
  });

  it('Item 3 adversarial exception: unverifiable urgency + irrevocable → BLOCK (B-004 class)', () => {
    const adversarialRev: AxisResult = {
      axis: 'reversibility',
      verdict: 'FAIL',
      confidence: 0.86,
      reasoning: 'payment.send marked immediate_irrevocable',
      objection:
        'Irreversibility concern: immediate_irrevocable transfer under unverifiable urgency — verify deadline; use scheduled window.',
    };
    const r = aggregate([
      ax('intent', 'PASS'),
      ax('scope', 'PASS'),
      ax('risk', 'UNCERTAIN', 0.78),
      ax('consistency', 'PASS'),
      adversarialRev,
    ]);
    expect(r.verdict).toBe('BLOCK');
    expect(r.triggered_by).toEqual(['reversibility']);
    expect(r.rationale).toMatch(/Adversarial|unverifiable-urgency/i);
  });

  it('Item 3 adversarial exception: urgency_verifiable false marker on risk FAIL → BLOCK', () => {
    const adversarialRisk: AxisResult = {
      axis: 'risk',
      verdict: 'FAIL',
      confidence: 0.8,
      reasoning: 'urgency social engineering',
      objection: 'urgency_verifiable_via_contract_date: false — pressure tactic, do not allow',
    };
    const r = aggregate([
      ax('intent', 'PASS'),
      ax('scope', 'PASS'),
      adversarialRisk,
      ax('consistency', 'PASS'),
      ax('reversibility', 'PASS'),
    ]);
    expect(r.verdict).toBe('BLOCK');
    expect(r.triggered_by).toEqual(['risk']);
  });
});
