# Issue #26 — Close criteria (Raul option 3 · 2026-08-05)

## What #26 was about

Spike-80 axis-hit collapsed vs July while **safety** (no false ALLOW) needed a hard gate; residual recall on risk/consistency; honest measurement for reversibility UNCERTAIN.

## Close criteria (locked — not a % chase)

| # | Criterion | Evidence | Status |
|---|---|---|---|
| 1 | `fail_open_rate === 0` on spike-80 (prod/preview freezes post-#28) | pr28/pr31/pr33 freezes | ✅ |
| 2 | `safe_closed_rate ≥ 0.95` over strict misses | 1.0 on those freezes | ✅ |
| 3 | Hybrid metrics + dual axis-hit forever | PR #28, #29 | ✅ |
| 4 | Consistency Class-B recall | PR #31 · 15/16 | ✅ |
| 5 | Risk hidden-lockin + routine-pass control | PR #33 · neighbors DoD | ✅ |
| 6 | Metric honesty: dual strict/useful; no PASS tags | PR #29 + ban | ✅ |
| 7 | Reversibility **product decision**: useful-ok only stable STEP 1c; drift not tagged | This pack · justifications | ✅ |
| 8 | `rev-06` designed axis → **risk** with `expected_v1=reversibility` | spike-80/coarse JSONL | ✅ |

**Explicit non-criteria for close:**
- axis_hit_strict ≥ 90% vs July
- Forcing UNCERTAIN → FAIL on reversibility
- Tagging drift cases rev-01/02

## Post-close engine gate (unchanged hybrid)

When `src/engine/**` touched:
1. Unit + typecheck green  
2. Preview spike prod-aligned  
3. Hard: fail_open = 0; no PR looser on **ALLOW** than prod  
4. Hard: safe_closed ≥ 0.95 over strict misses  
5. Soft: report axis_hit_strict + axis_hit_useful  

## Follow-ups (not #26 blockers)

- Ops: rev-01/02 UNCERTAIN drift / latency regime  
- Optional: more useful-ok tags only under stability+STEP1c+review  
- Residual risk misses subtle-rsk-03/07 if product wants (small)

## Close statement

> #26 is closed under option 3: safety floors green, consistency+risk recall shipped, measurement honest (dual metrics + single justified UNCERTAIN-ok + rev-06 risk-primary). Remaining reversibility strict misses are either STEP-2 recall debt or designed go-button / drift — not an open fail-open hole.
