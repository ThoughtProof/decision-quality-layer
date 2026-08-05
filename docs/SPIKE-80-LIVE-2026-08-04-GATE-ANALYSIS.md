# Spike-80 live 2026-08-04/05 — gate analysis (NO-GO for PR #25 merge)

**Status:** NO-GO on merge of PR #25 *against its stated spike-floor criterion* until interpreted correctly.  
**Report:** `scenarios/spike-80-live-2026-08-04.json` · script fix commit `0e3382b` on `feat/dql-api-key-gate`  
**Baseline:** `scenarios/spike-80-baseline-2026-07-08.json` · 97.5% axis-hit (78/80)

---

## Headline numbers

| | Baseline 2026-07-08 | Live 2026-08-04/05 | Floor |
|---|---|---|---|
| Parse | 100% | 100% | 100% ✅ |
| Axis-hit | **97.5%** (78/80) | **66.3%** (53/80) | ≥90% ❌ |
| Other-axes fire | 83.1% | 58.1% | — |
| Mean latency | **4.2s** | **17.3s** | — |

Per-axis hit (live): intent 16/16 · scope 14/16 · risk 9/16 · consistency 7/16 · reversibility 7/16  
**25 ids** hit in baseline, miss now (list in analysis script / below).

Miss shape: **19 PASS** on expected axis + **8 UNCERTAIN** (almost all reversibility) — not parse/HTTP failures.

---

## Critical scope correction (PR #25)

| Fact | Implication |
|---|---|
| Live run hit **`https://dql.thoughtproof.ai` (production)** | Measures **current prod**, not PR #25 |
| PR #25 head = `fix/24-provenance-decoupling` (unmerged) | **Not deployed** on the URL we called |
| Script/report committed on `feat/dql-api-key-gate` | Ops fix + artifact branch ≠ PR #25 code |

**Conclusion:** This rerun is a valid **prod regression watchdog** vs July baseline. It is **not** a direct acceptance test of PR #25’s cascade-pot provenance fix.

Honest gate application:
1. **Prod floor currently FAIL** → do not claim “DQL spike healthy”.
2. **PR #25** must not be merged *as if* the spike proved the PR — either:
   - deploy PR to a **preview** and rerun spike there, or
   - document that spike floor is a **prod** gate independent of #25 and merge #25 only on unit/typecheck + targeted degraded-provenance tests (450/450) *while tracking prod regression separately*.

Prefer: **preview spike for #25** + **separate prod bisect** for 97.5→66.3.

---

## Hypotheses

### H1 — Deadline / secondary skip (method effect)
**Weakened by spot-checks (2026-08-05).**  
Re-fetched `rsk-02`, `cns-01`, `rev-08`, `int-01` with full response: every axis showed `provider_outcome: served`, `provider_route: primary`. Meta lists `models_used: [serv-nano, serv-swift]`, all five axes evaluated.  
→ Failures are **content verdicts** (PASS/UNCERTAIN on expected axis), not “axis missing because secondary skipped.”

Latency still suspicious: miss cases slower (mean ~23s) than hits (~14s); overall ~4× baseline. Deadline pressure may still **change secondary behavior** in ways not visible if route always labels `primary`, but we do **not** have evidence of DEADLINE-SKIP omitting axes in these samples.

### H2 — Config / model regime drift vs baseline (likely major)
Baseline docs (`docs/SPIKE-RESULTS.md`): live SERV cascade, `DQL_CASCADE=pot-cli`, temperature 0, seed 42, mean ~4s.  
Live now: mean ~17s, nano+swift in `models_used`, prod env includes deadline enforcement flags (`DQL_DEADLINE_ENFORCEMENT=1`, etc. from Vercel pull).  
Prod also carries post-baseline features (objection evidence bind on surface path visible in meta on some calls).

**Most plausible:** prod cascade/config/model path drifted since 2026-07-08; axis quality especially **risk / consistency / reversibility** degraded under current regime.

### H3 — True regression from PR #25 provenance decoupling
**Not testable from this run** (PR not on prod). Unit suite on PR claims 450/450 for degraded-provenance contract. Do not attribute 66% hit to #25 without preview deploy evidence.

---

## Regressed IDs (baseline hit → live miss)

`cns-01, cns-04, cns-06, rev-03, rev-08, rsk-02, rsk-03, rsk-06, subtle-con-01..05, subtle-con-07, subtle-rev-01,02,04..07, subtle-rsk-01..03,07, subtle-scp-01`

---

## Recommended next steps (ordered)

1. **Keep PR #25 DRAFT / NO-GO** on spike-floor narrative until preview spike or explicit gate rewrite.
2. **Push** `feat/dql-api-key-gate` (`0e3382b` + report) so reviewers can recompute.
3. **Prod bisect / config diff:** compare Vercel env + deployed commit SHA now vs ~2026-07-08 (cascade, deadline, CB, model aliases).
4. **Optional instrumented rerun:** persist full `meta` + per-axis `provider_outcome`/`provider_route` in HTTP spike report (script enhancement) — current report drops provenance → hard to audit deadline.
5. **PR #25 acceptance path:** Vercel preview of `fix/24-provenance-decoupling` → spike-80 with same key → compare to **today’s prod** (not only July baseline).
6. **Key rotation:** DQL dev key was in chat-capable context → rotate `DQL_API_KEYS` on Vercel + refresh `.env.local` (shai-hulud hygiene).

---

## Bottom line

| Claim | Verdict |
|---|---|
| Spike floor 90% met on prod today? | **No** (66.3%) |
| July→now prod regression real? | **Yes** (−31.2 pp, 25 id flips) |
| Caused by PR #25? | **Unknown / not implicated by this URL** |
| Merge PR #25 now under stated spike gate? | **NO-GO** |
| Bee analysis OK to continue? | **Yes** — with above scope correction |
