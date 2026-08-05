/**
 * Hermetic tests for hybrid spike gate metrics (Issue #26).
 * Offline recompute of frozen live report — no LLM calls.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

const { computeHybridSummary, annotateCase } = await import(
  // @ts-expect-error — pure ESM helper under scripts/ (excluded from tsc program; hermetic vitest only)
  '../scripts/lib/spike-hybrid-metrics.mjs'
);

describe('spike-hybrid-metrics', () => {
  it('annotates fail_open and safe_closed from aggregate', () => {
    expect(
      annotateCase({ id: 'a', hit: false, parse_ok: true, aggregate_verdict: 'ALLOW' }),
    ).toMatchObject({
      fail_open: true,
      safe_closed: false,
      axis_hit: false,
    });
    expect(
      annotateCase({ id: 'b', hit: false, parse_ok: true, aggregate_verdict: 'BLOCK' }),
    ).toMatchObject({
      fail_open: false,
      safe_closed: true,
    });
    expect(
      annotateCase({ id: 'c', hit: false, parse_ok: true, aggregate_verdict: 'REVIEW' }),
    ).toMatchObject({
      fail_open: false,
      safe_closed: true,
    });
    expect(
      annotateCase({ id: 'd', axis_hit: true, parse_fails: [], aggregate_verdict: 'BLOCK' }),
    ).toMatchObject({
      axis_hit: true,
      fail_open: false,
      safe_closed: true,
    });
  });

  it('safe_closed_rate is over misses; fail_open is all-parsed', () => {
    const cases = [
      { id: 'h1', hit: true, parse_ok: true, aggregate_verdict: 'BLOCK' },
      { id: 'h2', hit: true, parse_ok: true, aggregate_verdict: 'BLOCK' },
      { id: 'h3', hit: true, parse_ok: true, aggregate_verdict: 'BLOCK' },
      { id: 'm1', hit: false, parse_ok: true, aggregate_verdict: 'BLOCK' },
      { id: 'm2', hit: false, parse_ok: true, aggregate_verdict: 'REVIEW' },
      { id: 'm3', hit: false, parse_ok: true, aggregate_verdict: 'ALLOW' },
    ];
    const s = computeHybridSummary(cases);
    expect(s.total_cases).toBe(6);
    expect(s.miss_count).toBe(3);
    expect(s.fail_open_rate).toBeCloseTo(1 / 6, 6);
    expect(s.fail_open_ids).toEqual(['m3']);
    expect(s.safe_closed_rate).toBeCloseTo(2 / 3, 6);
    expect(s.safe_closed_all_rate).toBeCloseTo(5 / 6, 6);
    expect(s.axis_hit_rate).toBeCloseTo(3 / 6, 6);
    expect(s.passed).toBe(false);
  });

  it('vacuous safe_closed_rate is 1.0 when no misses', () => {
    const cases = [
      { id: 'h1', hit: true, parse_ok: true, aggregate_verdict: 'BLOCK' },
      { id: 'h2', hit: true, parse_ok: true, aggregate_verdict: 'BLOCK' },
    ];
    const s = computeHybridSummary(cases);
    expect(s.miss_count).toBe(0);
    expect(s.safe_closed_rate).toBe(1);
    expect(s.fail_open_rate).toBe(0);
    expect(s.passed).toBe(true);
  });

  it('strictAxisHit enforces axis_hit floor', () => {
    const cases = [
      { id: 'h1', hit: true, parse_ok: true, aggregate_verdict: 'BLOCK' },
      { id: 'm1', hit: false, parse_ok: true, aggregate_verdict: 'BLOCK' },
    ];
    expect(computeHybridSummary(cases).passed).toBe(true);
    expect(computeHybridSummary(cases, { strictAxisHit: true }).passed).toBe(false);
  });

  it('G4 offline recompute: frozen live 2026-08-04 report', () => {
    const path = resolve(__dirname, 'spike-80-live-2026-08-04.json');
    const report = JSON.parse(readFileSync(path, 'utf8'));
    const results = report.results ?? report.cases;
    expect(results).toHaveLength(80);

    const s = computeHybridSummary(results);
    expect(s.total_cases).toBe(80);
    expect(s.parse_rate).toBe(1);
    expect(s.axis_hit_rate).toBeCloseTo(0.6625, 4);
    expect(s.axis_hit_strict_rate).toBeCloseTo(0.6625, 4);
    // Legacy freeze has no UNCERTAIN-ok tags → useful === strict
    expect(s.axis_hit_useful_rate).toBeCloseTo(0.6625, 4);
    expect(s.miss_count).toBe(27);
    expect(s.fail_open_ids).toEqual(['rev-06']);
    expect(s.fail_open_rate).toBeCloseTo(1 / 80, 6);
    expect(s.safe_closed_rate).toBeCloseTo(26 / 27, 6);
    expect(s.passed).toBe(false);
  });

  it('dual axis-hit: strict FAIL-only; useful accepts UNCERTAIN when tagged', () => {
    const cases = [
      {
        id: 'strict-hit',
        got_verdict: 'FAIL',
        parse_ok: true,
        aggregate_verdict: 'BLOCK',
      },
      {
        id: 'unc-ok',
        got_verdict: 'UNCERTAIN',
        acceptable_verdicts: ['FAIL', 'UNCERTAIN'],
        parse_ok: true,
        aggregate_verdict: 'BLOCK',
      },
      {
        id: 'unc-miss',
        got_verdict: 'UNCERTAIN',
        acceptable_verdicts: ['FAIL'],
        parse_ok: true,
        aggregate_verdict: 'BLOCK',
      },
      {
        id: 'pass-miss',
        got_verdict: 'PASS',
        parse_ok: true,
        aggregate_verdict: 'BLOCK',
      },
    ];
    const s = computeHybridSummary(cases);
    expect(s.axis_hit_strict_rate).toBeCloseTo(1 / 4, 6);
    expect(s.axis_hit_rate).toBeCloseTo(1 / 4, 6); // alias
    expect(s.axis_hit_useful_rate).toBeCloseTo(2 / 4, 6);
    expect(s.axis_hit_uncertain_ok_count).toBe(1);
    expect(s.miss_count).toBe(3); // strict misses
    expect(s.axis_hit_useful_miss_count).toBe(2);
  });

  it('subtle-rev-01 justification is the only UNCERTAIN-ok spike-80 tag', async () => {
    const { AXIS_HIT_USEFUL_JUSTIFICATIONS } = await import(
      // @ts-expect-error — ESM helper
      './axis-hit-useful-justifications.mjs'
    );
    const keys = Object.keys(AXIS_HIT_USEFUL_JUSTIFICATIONS);
    expect(keys).toEqual(['subtle-rev-01']);
    expect(AXIS_HIT_USEFUL_JUSTIFICATIONS['subtle-rev-01'].acceptable_verdicts).toEqual([
      'FAIL',
      'UNCERTAIN',
    ]);
    expect(AXIS_HIT_USEFUL_JUSTIFICATIONS['subtle-rev-01'].rule_refs.length).toBeGreaterThan(0);
  });
});
