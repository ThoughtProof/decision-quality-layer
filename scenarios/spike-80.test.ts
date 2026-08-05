/**
 * Meta-tests for the regression scenario JSONL files.
 *
 * Hermetic (no LLM calls) — validates JSONL structure so a bad edit doesn't
 * silently break the runner. The paid runners are:
 *   • `npm run scenarios:spike-coarse` (40 cases)
 *   • `npm run scenarios:spike-subtle` (40 cases)
 *   • `npm run scenarios:spike-80`     (80 cases)
 *   • `npm run scenarios:spike-80-live` (80 cases against dql.thoughtproof.ai)
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { validateVerifyRequest } from '../src/validation.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

interface Scenario {
  id: string;
  expected_fail_axis: 'intent' | 'scope' | 'risk' | 'consistency' | 'reversibility';
  /** Prior designed axis before honest relabel (Issue #26 option 3). */
  expected_v1_fail_axis?: 'intent' | 'scope' | 'risk' | 'consistency' | 'reversibility';
  note: string;
  request: {
    mandate: string;
    proposed_action: string;
    reasoning: string;
    context?: string;
    axes: string[];
  };
}

const AXES = ['intent', 'scope', 'risk', 'consistency', 'reversibility'] as const;

function load(file: string): Scenario[] {
  return readFileSync(resolve(__dirname, file), 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as Scenario);
}

type PerAxis = number | Record<(typeof AXES)[number], number>;

function assertBasics(
  scenarios: Scenario[],
  label: string,
  expectedCount: number,
  perAxis: PerAxis,
) {
  it(`${label}: has exactly ${expectedCount} scenarios`, () => {
    expect(scenarios).toHaveLength(expectedCount);
  });

  it(`${label}: has expected per-axis counts`, () => {
    for (const axis of AXES) {
      const count = scenarios.filter((s) => s.expected_fail_axis === axis).length;
      const want = typeof perAxis === 'number' ? perAxis : perAxis[axis];
      expect(count, `axis ${axis}`).toBe(want);
    }
  });

  it(`${label}: every scenario has a unique id`, () => {
    const ids = scenarios.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it(`${label}: every scenario has a non-empty mandate, proposed_action, and note`, () => {
    for (const s of scenarios) {
      expect(s.request.mandate.trim().length, `${s.id} mandate`).toBeGreaterThan(0);
      expect(s.request.proposed_action.trim().length, `${s.id} proposed_action`).toBeGreaterThan(0);
      expect(s.note.trim().length, `${s.id} note`).toBeGreaterThan(0);
    }
  });

  it(`${label}: every scenario request passes DQL request validation`, () => {
    for (const s of scenarios) {
      const v = validateVerifyRequest(s.request);
      const detail = v.valid ? '' : v.errors.join(', ');
      expect(v.valid, `${s.id}: ${detail}`).toBe(true);
    }
  });

  it(`${label}: every scenario asks for all 5 axes`, () => {
    for (const s of scenarios) {
      expect(s.request.axes.sort()).toEqual([...AXES].sort());
    }
  });
}

describe('spike-40-coarse JSONL', () => {
  const scenarios = load('spike-40-coarse.jsonl');
  // rev-06 relabeled reversibility → risk (#26 option 3); expected_v1 preserved
  assertBasics(scenarios, 'coarse', 40, {
    intent: 8,
    scope: 8,
    risk: 9,
    consistency: 8,
    reversibility: 7,
  });
});

describe('spike-40-subtle JSONL', () => {
  const scenarios = load('spike-40-subtle.jsonl');
  assertBasics(scenarios, 'subtle', 40, 8);

  it('subtle: every scenario has non-empty reasoning (not the coarse placeholder)', () => {
    for (const s of scenarios) {
      expect(s.request.reasoning.trim().length, `${s.id} reasoning`).toBeGreaterThan(20);
      expect(s.request.reasoning).not.toContain('no separate agent reasoning was captured');
    }
  });
});

describe('spike-80 JSONL', () => {
  const scenarios = load('spike-80.jsonl');
  assertBasics(scenarios, 'combined', 80, {
    intent: 16,
    scope: 16,
    risk: 17,
    consistency: 16,
    reversibility: 15,
  });

  it('combined: is the concatenation of coarse + subtle (ids preserved)', () => {
    const coarse = load('spike-40-coarse.jsonl').map((s) => s.id);
    const subtle = load('spike-40-subtle.jsonl').map((s) => s.id);
    const combined = scenarios.map((s) => s.id);
    expect(combined).toEqual([...coarse, ...subtle]);
  });

  it('rev-06 is risk-primary with expected_v1=reversibility (#26 option 3)', () => {
    const rev06 = scenarios.find((s) => s.id === 'rev-06');
    expect(rev06).toBeTruthy();
    expect(rev06!.expected_fail_axis).toBe('risk');
    expect(rev06!.expected_v1_fail_axis).toBe('reversibility');
    expect(rev06!.note.toLowerCase()).toMatch(/relabel|expected_v1|risk/);
  });
});

describe('spike-material-ops-neighbors JSONL (Issue #26 class fixtures)', () => {
  const scenarios = load('spike-material-ops-neighbors.jsonl');

  it('has ≥2 class fixtures with unique ids', () => {
    expect(scenarios.length).toBeGreaterThanOrEqual(2);
    const ids = scenarios.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('includes DNS unacked + TTL-acked controls and S4/S5 guards', () => {
    const ids = new Set(scenarios.map((s) => s.id));
    expect(ids.has('matops-dns-ttl-unacked')).toBe(true);
    expect(ids.has('matops-dns-ttl-acked')).toBe(true);
    expect(ids.has('matops-migrate-rollback')).toBe(true);
    expect(ids.has('matops-greeting-low')).toBe(true);
  });

  it('every scenario request passes DQL request validation', () => {
    for (const s of scenarios) {
      const v = validateVerifyRequest(s.request);
      const detail = v.valid ? '' : v.errors.join(', ');
      expect(v.valid, `${s.id}: ${detail}`).toBe(true);
    }
  });

  it('every scenario asks for all 5 axes and expects risk', () => {
    for (const s of scenarios) {
      expect(s.expected_fail_axis).toBe('risk');
      expect(s.request.axes.sort()).toEqual([...AXES].sort());
    }
  });
});

describe('spike-consistency-neighbors JSONL (Issue #26 class fixtures)', () => {
  const scenarios = load('spike-consistency-neighbors.jsonl');

  it('has ≥2 class fixtures with unique ids', () => {
    expect(scenarios.length).toBeGreaterThanOrEqual(2);
    const ids = scenarios.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('includes Class-B priority-mismatch + coherent-direct control', () => {
    const ids = new Set(scenarios.map((s) => s.id));
    expect(ids.has('cns-neighbor-priority-mismatch')).toBe(true);
    expect(ids.has('cns-neighbor-coherent-direct')).toBe(true);
  });

  it('every scenario request passes DQL request validation', () => {
    for (const s of scenarios) {
      const v = validateVerifyRequest(s.request);
      const detail = v.valid ? '' : v.errors.join(', ');
      expect(v.valid, `${s.id}: ${detail}`).toBe(true);
    }
  });

  it('every scenario asks for all 5 axes and expects consistency', () => {
    for (const s of scenarios) {
      expect(s.expected_fail_axis).toBe('consistency');
      expect(s.request.axes.sort()).toEqual([...AXES].sort());
    }
  });

  it('Class-B neighbor notes a priority↔action break; control notes precision/PASS intent', () => {
    const mismatch = scenarios.find((s) => s.id === 'cns-neighbor-priority-mismatch');
    const control = scenarios.find((s) => s.id === 'cns-neighbor-coherent-direct');
    expect(mismatch?.note.toLowerCase()).toMatch(/priority|speed|contradict|mismatch|logical break/);
    expect(control?.note.toLowerCase()).toMatch(/pass|precision|control|direct/);
    // Fresh surface — not a copy of locked spike-80 CDN/laptop ids
    expect(mismatch?.id).not.toMatch(/subtle-con|cns-0/);
    expect(JSON.stringify(mismatch?.request)).not.toMatch(/FastCDN|Latitude 5450/i);
  });
});

describe('spike-risk-neighbors JSONL (Issue #26 class fixtures)', () => {
  const scenarios = load('spike-risk-neighbors.jsonl');

  it('has ≥2 class fixtures with unique ids', () => {
    expect(scenarios.length).toBeGreaterThanOrEqual(2);
    const ids = scenarios.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('includes hidden-lockin recall + routine-pass control', () => {
    const ids = new Set(scenarios.map((s) => s.id));
    expect(ids.has('rsk-neighbor-hidden-lockin')).toBe(true);
    expect(ids.has('rsk-neighbor-routine-pass')).toBe(true);
  });

  it('every scenario request passes DQL request validation', () => {
    for (const s of scenarios) {
      const v = validateVerifyRequest(s.request);
      const detail = v.valid ? '' : v.errors.join(', ');
      expect(v.valid, `${s.id}: ${detail}`).toBe(true);
    }
  });

  it('every scenario asks for all 5 axes and expects risk', () => {
    for (const s of scenarios) {
      expect(s.expected_fail_axis).toBe('risk');
      expect(s.request.axes.sort()).toEqual([...AXES].sort());
    }
  });

  it('Recall notes lock-in trap; control notes history/PASS precision', () => {
    const lockin = scenarios.find((s) => s.id === 'rsk-neighbor-hidden-lockin');
    const control = scenarios.find((s) => s.id === 'rsk-neighbor-routine-pass');
    expect(lockin?.note.toLowerCase()).toMatch(/lock-in|non-refundable|auto-renew|trap|recall/);
    expect(control?.note.toLowerCase()).toMatch(/pass|history|precision|control|renewal/);
    // Fresh surface — not a copy of locked spike-80 residual ids
    expect(lockin?.id).not.toMatch(/subtle-rsk|rsk-0/);
    expect(JSON.stringify(lockin?.request)).not.toMatch(/FastPM|AAPL|Sarah Chen|#general/i);
    // Control carries history-as-evidence fields
    expect(control?.request.context ?? '').toMatch(/past_renewals|amount_variance_from_history/i);
  });
});


