# DQL Throughput Scaling — Design Options (2026-07-19)

**Status:** Discussion doc for the next OpenServ conversation. Not an implementation plan.
**Trigger:** c4 stage of the PR #17 load harness showed 50% REVIEW amplification at concurrency=4 under stress budgets — fail-closed works, capacity does not scale linearly.

---

## 1. The problem, quantified

Per verified case (healthy path):

| Unit | Count |
|---|---|
| Axes | 5 |
| LLM calls per axis | 1 primary (serv-nano) + 1 secondary (serv-swift) |
| **LLM calls per case** | **≈10** |
| End-to-end latency (observed, 2026-07-19 cool window) | 7–26 s |

Scaling arithmetic:

| Concurrent cases | Concurrent LLM calls to OpenServ | Expected outcome (current posture) |
|---|---|---|
| 4 (c4 stage) | ~40 | 50% REVIEW amplification (measured, PR #17 live Option-A) |
| 100 | **~1,000** | Provider queueing → latency > tripP90 (15s) → per-alias breakers OPEN → near-total fail-closed REVIEW |

**The system degrades exactly as designed** (safety ✓, 0 false allows at c4) — but is not usable at burst scale.

## 2. Where the bottleneck is — and is not

| Layer | Verdict | Evidence |
|---|---|---|
| Client → DQL HTTP | Not the problem | 100 concurrent requests is trivial |
| Vercel Hobby + Fluid (maxDuration 300s) | Secondary | Pro upgrade raises concurrency; does not fix provider queue |
| DQL sync request/response model | Design issue | One HTTP request held open 20s+ per case does not fit throughput workloads |
| **OpenServ gateway** | **Primary bottleneck** | ~10 LLM calls/case; serverless IP variance (residential path 1–2s), serv-swift bursty; CB `tripP90=15s` trips under queue pressure — by design |

**Answer in one line:** 100+ parallel cases is an OpenServ-capacity and DQL-interaction-model problem, not a Vercel problem.

## 3. Options

### Option A — Async job model (structural fix)

```
POST /dql/verify        → 202 Accepted + job_id   (immediate)
Worker pool             → bounded concurrency vs OpenServ (e.g. 5–10 in flight)
GET /dql/result/:job_id → result when done  (or webhook callback)
```

- Decouples client concurrency from provider rate limits.
- Client-side bursts become queue depth, not provider pressure.
- Worker can live on Vercel (queued functions) or a small always-on process (Mac mini / VM) — the pacing discipline we already use for benchmark runs (≥25–40s) becomes a worker setting.
- **Cost:** new endpoint surface, job store (KV/Supabase), result retention policy.
- **Honest limit:** does not raise *throughput ceiling* — it converts failure mode from "50–90% fail-closed REVIEW" into "predictable latency under load".

### Option B — Tiered verification (load reduction 5–10×)

Deterministic pre-filter before the LLM cascade:

1. Structural/schema checks (already in the codebase — no LLM)
2. Clear-pass cases skip or reduce the cascade
3. Only uncertain/complex cases run full 5-axis primary+secondary

Most routine cases are unambiguous. Sending everything through ~10 LLM calls is the expensive default, not a requirement.

- **Cost:** routing policy + re-certification of the tiered path (FAR must stay 0.00 on the reduced cascade — needs a suite-v1 re-run).
- **Risk:** pre-filter errors become FAR events — the filter must be fail-closed toward the full cascade.

### Option C — OpenServ capacity agreement (prerequisite for any burst claim)

- Rate-limit agreement / dedicated quota / batch API.
- Evidence base for the conversation: c4 measurements (PR #17), per-case call arithmetic, latency distributions from the 2026-07-19 cool-window runs.
- Without this, any 100+ burst is luck regardless of our architecture.

### Option D — Vercel Pro (only if sync model stays)

- Higher concurrency, Fluid compute. Cheap to try.
- **Does not address the primary bottleneck.** Listed for completeness only.

## 4. What NOT to do

| Anti-pattern | Why |
|---|---|
| Raise `tripP90`/deadline budgets to "survive" bursts | Converts fail-closed safety into silent queue-waiting; exactly the failure mode the breakers exist to prevent |
| Client-side retry storms | Amplifies provider pressure (storm guards in the load harness exist for this reason) |
| Parallelize axes inside one case without provider agreement | Same total call count hitting the same gateway — moves the queue, doesn't remove it |
| Claim burst capacity without a certifying re-run | c4 is load-test evidence (non-certifying); any throughput claim needs the same judgment-backed discipline as FAR/FBR |

## 5. Recommended sequence

1. **Decide product posture first:** is DQL a gate-of-record (sync, single case, human waiting) or a throughput layer (async, batch)? This is a product decision, not a technical one.
2. **OpenServ conversation** with c4 evidence (Option C) — regardless of posture.
3. If throughput layer: **Option A** (async) + **Option B** (tiering) as one design, then certifying re-run of suite v1 against the new path before any claim.
4. Vercel Pro (Option D) only when the sync path itself becomes the limit — it isn't yet.

## 6. Evidence anchors

- PR #17 load harness: `scripts/run-loadtest.mjs`, matrix c1/c2/c4, non-certifying stamps
- c4 live Option-A observations: 4/8 REVIEW, 0 false allows, W45/PC18/T15 stress budgets
- Prod deadline posture: W90/PC40/T30, `maxDuration` 300s (Vercel Hobby + Fluid), `0.4.3.2-deadline-1` on `da110b8`
- CB posture: per-alias isolation (PR #17), `tripP90=15s` for nano+swift, capital-path no-fallback
- Cool-window latencies 2026-07-19: 7–26s/case judgment-backed (ADSB run `v1-20260719-045029` + recovery runs)

---

*Hermes · 2026-07-19 · discussion doc — no code changes implied*
