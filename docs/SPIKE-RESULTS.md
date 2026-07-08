# DQL Spike-40 — Live Baseline

**Date:** 2026-07-08
**Repo HEAD at run:** `decision-quality-layer` main + uncommitted `max_completion_tokens` fix
**Cascade:** `DQL_CASCADE=pot-cli` — real SERV cascade (serv-nano → serv-swift, temperature 0, seed 42)
**Scenarios:** `scenarios/spike-40.jsonl` (40 hand-curated single-axis-fail cases, 8 per axis)
**Report:** `scenarios/live-baseline-2026-07-08.json`

---

## Result: ✓ PASSED — all three regression floors held

| Metric | Live baseline | Floor | Status |
|---|---:|---:|:--:|
| Parse rate | 100.0 % | 100 % | ✅ |
| Axis-hit rate | 97.5 % (39/40) | ≥ 90 % | ✅ |
| Mean pairwise correlation | 0.184 | ≤ 0.20 | ✅ |

Per-axis hit rate: intent 8/8 · scope 8/8 · risk 8/8 · consistency 8/8 · reversibility 7/8.
The single miss (rev-06) returned PASS where the scenario expected a reversibility FAIL —
a borderline case, not a systemic gap.

---

## Honest caveat — axis co-firing on coarse errors

`other-axes-fired` averaged **3.58 of 4** per case: when the designed axis fails, ~3.5 of
the other four axes ALSO return FAIL. This is **not an aggregation artifact** — it is real
two-model agreement. On the coarse single-axis scenarios in this set, a gross error is
genuinely multi-axis: e.g. "book a flight to the wrong city" really does violate intent
AND scope AND risk at once, and both serv-nano and serv-swift see it on each axis.

**Consequence for the "5 orthogonal axes" claim:**
- The **per-axis separation** (each axis firing *only* on its designed error) is best
  demonstrated by the **solo grader**, not the live cascade. The orthogonality spike
  (2026-07-08, serv-nano solo) measured mean pairwise correlation **0.09** with 95 % hit —
  clean separation.
- The **live cascade** (nano→swift, conservative aggregation) blurs this on coarse errors
  because the second model also finds a real problem on most axes. Correlation stays under
  floor (0.184) but co-firing is high (3.58/4).
- Marketing/product framing must reflect this: "five axes that isolate different failure
  types — on subtle errors they separate cleanly; on gross errors several fire together
  (correctly)." Do NOT claim clean per-axis isolation on the live cascade.

## Investigated and rejected: disagreement→UNCERTAIN aggregation

We tested whether the conservative rule `PASS↔FAIL disagreement → FAIL` was too coarse and
whether the Sentinel-congruent `→ UNCERTAIN` would improve axis separation. Measured:

| Rule | Axis-hit | other-axes-FAIL | Mean corr |
|---|---:|---:|---:|
| `disagreement → FAIL` (kept) | 97.5 % | 3.58/4 | 0.184 |
| `disagreement → UNCERTAIN` (rejected) | 92.5 % | 3.00/4 | 0.182 |

The UNCERTAIN variant lowered co-firing only marginally (3.58→3.00) while costing hit rate
(97.5→92.5, intent dropped to 6/8). Net: no clear win — confirming the co-firing is driven
by genuine two-model agreement, not by the aggregation rule. Reverted to `→ FAIL`.

**v0.3 lever (not v0.2):** if tighter per-axis isolation on the live cascade is wanted, the
place to work is axis-prompt sharpening or scenario design — NOT the aggregation rule.

## Infrastructure fix found during this run

First run reported "Parse 100 % / Axis-hit 0 %" — every SERV call was failing with
`HTTP 400: 'max_tokens' is not supported with this model. Use 'max_completion_tokens'`.
The cascade silently defaulted failed calls to UNCERTAIN@0, so parse-rate looked fine while
nothing actually evaluated. Fixed in `src/engine/llm-client.ts` (max_tokens →
max_completion_tokens). Lesson: a clean parse-rate can mask a total call failure — always
eyeball a raw single-call output before trusting aggregate metrics.

---

## Sign-off

v0.2 meets all three regression floors on the live SERV cascade. Signed off with the
axis-co-firing caveat documented above. Dev-access only (no payment gate) as intended.
