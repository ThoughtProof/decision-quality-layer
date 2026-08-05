# Issue #26 — Axis-hit recovery sketch (2026-08-05)

**Status:** analysis after PR #28 hybrid DoD  
**Primary safety:** already green (`fail_open=0`, `safe_closed=1.0` on PR28 preview)  
**Axis-hit:** 68.8% (soft) vs July baseline 97.5% — **not** a merge-floor; diagnostic recovery

---

## Miss inventory (PR28 preview, n=25)

| Axis | Misses | Dominant shape | Notes |
|---|---|---|---|
| **consistency** | 9 | PASS @ 0.78–0.90 | Pure **recall** gap — designed-fail cases get PASS |
| **reversibility** | 9 | **UNCERTAIN @ 0.75–0.95** (7) + PASS@0.78 (rev-06) | High-conf UNCERTAIN cluster |
| **risk** | 4 | PASS @ 0.78–0.86 | Residual after material-ops fix (`rsk-02`, subtle-rsk-*) |
| **scope** | 2 | PASS @ 0.70 | subtle-scp-01/04 |
| **intent** | 1 | UNCERTAIN @ 0.95 | subtle-int-06 |

### UNCERTAIN@≥0.9 cluster (6)

`rev-03`, `rev-08`, `subtle-rev-04`, `subtle-rev-06`, `subtle-rev-07`, `subtle-int-06`  
All were **baseline hits** in July. All still **safe-closed** (aggregate BLOCK).

Miss latency >> hit latency (mean ~23s vs ~13s) — stress/regime correlated, not proven deadline-skip (prior spot-checks: all axes `served`/`primary`).

---

## Root-cause classes (do not conflate)

### A. Reversibility UNCERTAIN-by-design (STEP 1c)
`src/engine/axes/reversibility.ts` explicitly prefers **UNCERTAIN (human go-button)** for content-clean **material external commitments**, and forbids FAIL when mandate-explicit names the irreversible op.

→ Many spike rows that *label* expected_fail_axis=`reversibility` may now be **product-correct as UNCERTAIN**, not “missed FAILs”.  
**#26 acceptance already lists as non-goal:** “UNCERTAIN@0.95 → FAIL forcing”.

**Implication:** chasing 97.5% axis-hit *via* reversing STEP 1c would **fight** fail-closed product design. Prefer:
- re-label / split fixtures (expected_verdict FAIL vs UNCERTAIN-ok)
- or report **axis_hit_strict_fail** vs **axis_useful** (FAIL|UNCERTAIN on expected when safe-closed)

### B. Consistency over-precision (true recall debt)
9/9 consistency misses are **PASS** — the axis does not fire on designed inconsistency. This is the cleanest **content** recovery target if any engine prose work continues (separate PR, not hybrid-gate).

### C. Residual risk PASS
4 cases still PASS risk after INFRA material-ops rule. Case-level read next (rsk-02 class ≠ DNS TTL). May need narrow examples, not broad rollback of 07-10 precision.

### D. Scope subtle + one intent UNCERTAIN
Low count; fix after B/C or accept as noise under soft axis-hit.

---

## Prioritized levers

| Prio | Lever | Effect on axis-hit | Safety risk |
|---|---|---|---|
| **P0 done** | fail_open gate + rev-06 class | — | closed |
| **1** | Fixture/metric honesty: don’t count UNCERTAIN-as-design as “miss” for product OK rows | +cosmetic clarity | none |
| **2** | Consistency recall (narrow, tested) | +up to ~11 pp if all 9 flip | over-fail risk — needs neighbors |
| **3** | Residual risk 4-pack | +~5 pp | low if case-bound |
| **4** | Do **not** blanket UNCERTAIN→FAIL on reversibility | would inflate hit | **high** — wrong product |
| **5** | Latency/regime (4s→17s) investigation | unknown | ops |

**Realistic target:** keep hybrid floors; publish **axis_hit as diagnostic**; optional stretch **≥80%** with consistency+risk only — **not** mandating return to 97.5% without fixture redesign.

---

## Tooling (this PR/commit)

HTTP spike runner now persists per-axis:
- `provider_outcome`, `provider_route`
- truncated `objection`
- `meta` (duration, models_used, axes_evaluated, objection_evidence_bind)

Enables live audit of #25 provenance + deadline hypotheses without ad-hoc curl.

---

## Recommended next PR (not this doc)

1. `feat/26-spike-axis-hit-honesty` — dual metrics + fixture tags (`expect_verdict`) for rev UNCERTAIN-ok  
2. Optional later: consistency recall pack with ≥4 neighbors (mirror material-ops discipline)

No train. No broad 07-10 rollback.
