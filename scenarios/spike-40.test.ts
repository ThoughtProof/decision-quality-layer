/**
 * Meta-test for scenarios/spike-40.jsonl.
 *
 * This test is hermetic (no LLM calls) — it only validates the JSONL file's
 * structure so a bad edit doesn't silently break the regression runner.
 * The runner itself lives in `scripts/run-spike-scenarios.mjs` and is
 * invoked via `npm run scenarios:spike` (off-CI, costs real money).
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { validateVerifyRequest } from '../src/validation.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const scenarioPath = resolve(__dirname, 'spike-40.jsonl');

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

const scenarios: Scenario[] = readFileSync(scenarioPath, 'utf8')
  .split('\n')
  .filter((l) => l.trim())
  .map((l) => JSON.parse(l) as Scenario);

const AXES = ['intent', 'scope', 'risk', 'consistency', 'reversibility'] as const;

describe('spike-40 JSONL', () => {
  it('has exactly 40 scenarios', () => {
    expect(scenarios).toHaveLength(40);
  });

  it('has 8 scenarios per axis', () => {
    for (const axis of AXES) {
      const count = scenarios.filter((s) => s.expected_fail_axis === axis).length;
      expect(count, `axis ${axis}`).toBe(8);
    }
  });

  it('every scenario has a unique id', () => {
    const ids = scenarios.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('every scenario has a non-empty mandate, proposed_action, and note', () => {
    for (const s of scenarios) {
      expect(s.request.mandate.trim().length, `${s.id} mandate`).toBeGreaterThan(0);
      expect(s.request.proposed_action.trim().length, `${s.id} proposed_action`).toBeGreaterThan(0);
      expect(s.note.trim().length, `${s.id} note`).toBeGreaterThan(0);
    }
  });

  it('every scenario request passes DQL request validation', () => {
    for (const s of scenarios) {
      const v = validateVerifyRequest(s.request);
      const detail = v.valid ? '' : v.errors.join(', ');
      expect(v.valid, `${s.id}: ${detail}`).toBe(true);
    }
  });

  it('every scenario asks for all 5 axes', () => {
    for (const s of scenarios) {
      expect(s.request.axes.sort()).toEqual([...AXES].sort());
    }
  });
});
