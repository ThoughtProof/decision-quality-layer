# Orthogonality Spike — Results (2026-07-08)

**Question:** Are the five DQL axes (intent, scope, risk, consistency, reversibility) empirically independent, or are they redundant re-phrasings of one underlying judgement?

**Method:** 40 hand-crafted decision-cases (8 per axis, each designed to trigger ONE specific axis failure). Each case run through the standard-tier cascade (serv-nano → serv-swift) with a per-axis JSON-shaped prompt. Pairwise correlation between axis verdicts measured across the full 40-case matrix.

## Pre-registered decision rule

| Mean inter-axis correlation | Decision |
|---|---|
| ≥ 0.85 | Do not build — axes redundant |
| 0.60 – 0.85 | Delay — needs stronger separation |
| 0.40 – 0.60 | Build if wind-down cleared |
| < 0.40 | **Build (strong)** |

Two guards (both must pass):
- Parse rate > 50 % (does the model return the per-axis JSON?)
- Axis-hit rate > 60 % (does the designed axis fire strongest?)

## Results

| Metric | Value | Guard | Status |
|---|---|---|---|
| Parse rate | **100 %** (40/40) | > 50 % | ✅ |
| Axis-hit rate | **95 %** (38/40) | > 60 % | ✅ |
| Mean off-diagonal correlation | **0.09** | < 0.40 → BUILD | ✅ |
| Max correlation (scope ↔ risk) | 0.39 | | mild |
| Verdicts vary across axes (not constant-artefact) | yes | | ✅ verified |

**Decision:** BUILD (strong). Both guards passed → the recommendation does not rest on parse-noise.

## Qualitative reading

The raw JSONL surfaces something the aggregate 0.09 obscures:

- **Signal is content-meaningful.** On single-axis cases, the designed axis fires with precise, case-specific objections (e.g. Risk case: "50,000 EUR = 96 % of account balance, disproportional to typical 300–800 EUR").
- **Gross errors co-fire multiple axes.** A single case like "wrong city booked" triggers intent + scope + risk in parallel (which is correct — a wrong-city booking IS an intent failure AND a scope violation AND a risk-blindness case).
- **Reversibility and consistency are the cleanest-separated axes** — they stay PASS where intent/scope/risk co-block on gross errors.

**Marketing implication:** the story is not "5 fully independent checks" (that would be a claim the data does not support) — it is **"5 axes that isolate different failure types: gross errors trigger multiple axes together, subtle errors trigger the specific one"**. That framing is both more honest AND stronger (it advertises the differentiation directly).

## Aggregate correlation table

Mean off-diagonal correlation: **0.09**. Max: **0.39** (scope ↔ risk — the two axes most affected by gross-error co-fire on shared cases).

> The full pairwise matrix should be pasted here from `spike/orthogonality/runs/2026-07-08T14-25-31-933Z-cascade/results.jsonl` — kept out of this doc until the analyzer output is committed so the numbers are traceable to a specific run.

## Artefacts (in OpenClaw)

- `spike/orthogonality/runs/2026-07-08T14-25-31-933Z-cascade/report.md` — rule-based recommendation
- `spike/orthogonality/runs/.../readable.md` — all 40 cases with per-axis verdict and full reasoning
- `spike/orthogonality/runs/.../results.jsonl` — raw model outputs (nano and swift preserved separately)
- Runner: `spike/orthogonality/run_direct.mjs` (direct cascade grader, bypasses x402)

## What the spike does NOT establish

- **Not a fine-tuning result.** No models were adapted; this is a prompt-engineering + cascade-shaping result.
- **Not a false-positive rate.** The 40 cases are single-axis-failure by construction. Real-world traffic mixes clean cases (all PASS) and multi-axis-failure cases; per-axis FPR/FNR need a separate calibration run against a natural traffic sample.
- **Not proof of coverage.** The five axes cover five failure modes we pre-registered as important. Other failure modes may exist that none of the five catches — see [ARCHITECTURE.md § Adding a new axis](./ARCHITECTURE.md).

Follow-up calibration: once DQL sees production traffic, re-run this correlation analysis on natural samples and compare to the hand-crafted baseline.
