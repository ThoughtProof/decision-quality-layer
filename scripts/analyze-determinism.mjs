#!/usr/bin/env node
/**
 * Analyze a determinism-metric JSONL and print stability breakdowns.
 *
 * Usage:
 *   node scripts/analyze-determinism.mjs runs/determinism-main.jsonl
 *   node scripts/analyze-determinism.mjs runs/before.jsonl runs/after.jsonl   # diff mode
 */
import { readFileSync } from 'node:fs';

const paths = process.argv.slice(2);
if (paths.length < 1 || paths.length > 2) {
  console.error('Usage: analyze-determinism.mjs <baseline.jsonl> [after.jsonl]');
  process.exit(1);
}

function load(p) {
  return readFileSync(p, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
}

function summarize(rows, label) {
  const total = rows.length;
  const stable = rows.filter((r) => r.aggregate_stable).length;
  const anyAxisFlip = rows.filter((r) => r.any_axis_flip).length;
  const errors = rows.filter((r) => r.draws.some((d) => d.verdict === 'ERROR')).length;
  const N = rows[0]?.n_draws || 0;

  // Per-category stability
  const perCat = {};
  for (const r of rows) {
    const c = r.category || 'unknown';
    if (!perCat[c]) perCat[c] = { total: 0, stable: 0, axis_flip: 0 };
    perCat[c].total += 1;
    if (r.aggregate_stable) perCat[c].stable += 1;
    if (r.any_axis_flip) perCat[c].axis_flip += 1;
  }

  // Per-axis flip count
  const axisFlipCount = { intent: 0, scope: 0, risk: 0, consistency: 0, reversibility: 0 };
  for (const r of rows) {
    for (const ax of Object.keys(axisFlipCount)) {
      if (!r.per_axis_flips?.[ax]?.stable) axisFlipCount[ax] += 1;
    }
  }

  // Unstable case ids with signature
  const unstable = rows.filter((r) => !r.aggregate_stable).map((r) => ({
    id: r.id,
    category: r.category,
    expected: r.expected_verdict,
    unique_verdicts: r.aggregate_unique_verdicts,
    flipping_axes: Object.entries(r.per_axis_flips || {}).filter(([, v]) => !v.stable).map(([k, v]) => `${k}:${v.unique_verdicts.join('|')}`),
  }));

  console.log(`\n=== ${label} (N=${N}, total=${total}) ===`);
  console.log(`aggregate_stable:   ${stable}/${total}  (${((stable / total) * 100).toFixed(1)}%)`);
  console.log(`any_axis_flip:      ${anyAxisFlip}/${total}  (${((anyAxisFlip / total) * 100).toFixed(1)}%)`);
  console.log(`rows_with_errors:   ${errors}/${total}`);
  console.log(`\nper-category aggregate_stable:`);
  for (const [cat, s] of Object.entries(perCat).sort()) {
    console.log(`  ${cat.padEnd(24)} stable ${s.stable}/${s.total}  axis_flip ${s.axis_flip}/${s.total}`);
  }
  console.log(`\nper-axis flip count (rows where axis has ≥2 distinct verdicts across N draws):`);
  for (const [ax, n] of Object.entries(axisFlipCount)) {
    console.log(`  ${ax.padEnd(16)} ${n}/${total}`);
  }
  if (unstable.length > 0 && unstable.length <= 20) {
    console.log(`\nunstable case signatures:`);
    for (const u of unstable) {
      console.log(`  ${u.id} [${u.category}] exp=${u.expected} verdicts=${u.unique_verdicts.join('|')}  flipping=${u.flipping_axes.join(', ') || '(none? aggregate-only flip)'}`);
    }
  } else if (unstable.length > 20) {
    console.log(`\n${unstable.length} unstable cases (list suppressed, > 20).`);
  }

  return { label, N, total, stable, anyAxisFlip, perCat, axisFlipCount, unstable };
}

const s1 = summarize(load(paths[0]), paths[0]);
if (paths[1]) {
  const s2 = summarize(load(paths[1]), paths[1]);
  console.log(`\n=== DIFF (${paths[0]} → ${paths[1]}) ===`);
  console.log(`aggregate_stable:   ${s1.stable} → ${s2.stable}   delta ${s2.stable - s1.stable >= 0 ? '+' : ''}${s2.stable - s1.stable}`);
  console.log(`any_axis_flip:      ${s1.anyAxisFlip} → ${s2.anyAxisFlip}   delta ${s2.anyAxisFlip - s1.anyAxisFlip}`);
  const s1ids = new Set(load(paths[0]).filter((r) => !r.aggregate_stable).map((r) => r.id));
  const s2ids = new Set(load(paths[1]).filter((r) => !r.aggregate_stable).map((r) => r.id));
  const becameStable = [...s1ids].filter((id) => !s2ids.has(id));
  const becameUnstable = [...s2ids].filter((id) => !s1ids.has(id));
  console.log(`\nbecame stable (was unstable, now stable): ${becameStable.length}`);
  for (const id of becameStable) console.log(`  + ${id}`);
  console.log(`became unstable (was stable, now unstable): ${becameUnstable.length}`);
  for (const id of becameUnstable) console.log(`  - ${id}`);
}
