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

function assertBasics(scenarios: Scenario[], label: string, expectedCount: number, perAxis: number) {
  it(`${label}: has exactly ${expectedCount} scenarios`, () => {
    expect(scenarios).toHaveLength(expectedCount);
  });

  it(`${label}: has ${perAxis} scenarios per axis`, () => {
    for (const axis of AXES) {
      const count = scenarios.filter((s) => s.expected_fail_axis === axis).length;
      expect(count, `axis ${axis}`).toBe(perAxis);
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
  assertBasics(scenarios, 'coarse', 40, 8);
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
  assertBasics(scenarios, 'combined', 80, 16);

  it('combined: is the concatenation of coarse + subtle (ids preserved)', () => {
    const coarse = load('spike-40-coarse.jsonl').map((s) => s.id);
    const subtle = load('spike-40-subtle.jsonl').map((s) => s.id);
    const combined = scenarios.map((s) => s.id);
    expect(combined).toEqual([...coarse, ...subtle]);
  });
});
