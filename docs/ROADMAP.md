# DQL Roadmap — Post-v0.4.3

Tracked technical debt and follow-ups that are **not blockers** for the current release but must remain visible for future planning. Do not close items here silently — either address them in a version or explicitly re-classify (accept / defer with reason).

---

## v0.4.3.1 — CircuitBreaker Recovery Blindspot [BLOCKING v0.4.3 RECERT]

**Discovered**: 2026-07-11 during v0.4.3 pre-flight Check B (30 cases × N=3, `runs/preflight_b_summary.json`).
**Escalated**: 2026-07-11 during v0.4.3 Vollrun (100 cases × N=5, workers=1) — live-Bestätigung: 83/100 Cases in Folge CB persistent-OPEN nach legitimem Trip bei adv_017. Vollrun-Rohdaten: `dql-benchmark/runs/results_v043_swift_primary_recert_w1.jsonl`.
**Status**: escalated from v0.4.4 → v0.4.3.1 BLOCKING per Hermes decision 2026-07-11. capitalPathMode=false on prod capital paths cannot proceed until this ticket is closed.
**Priority**: BLOCKING v0.4.3 Recert. Not deferrable.

### Problem

Once **both** SERV alias circuits (`serv-swift` + `serv-nano`) are simultaneously `OPEN`, the engine catches `CircuitAllOpenError` in `src/engine/index.ts:58-79` and maps directly to `UNCERTAIN@0` with an explicit objection. This is correct **safety** behavior — the request fails closed.

The blindspot: the `HttpLlmClient.call()` path is the **only** place where `CircuitBreaker.canProceed()` runs, and `canProceed()` is the **only** trigger for the `OPEN → HALF_OPEN` transition (see `src/engine/circuit-breaker.ts:145-165`). Once the engine short-circuits to fail-closed, `call()` is never invoked → `canProceed()` is never called → the cooldown timer runs out but the state is never re-evaluated → **the circuit remains OPEN indefinitely** until the process restarts.

In v0.4.3 pre-flight Check B (see `docs/v043-preflight-check-b-report.md`): after 3 legitimate trips at draw 25 (adv_009 d0), both circuits stayed OPEN for the following 60 draws (~15 minutes wall-clock) despite the underlying provider recovering within ~30 seconds. Verified by ad-hoc `curl` to openserv-nano succeeding in ~10s immediately after the Check-B run.

### Impact under Prod Capital-Path Mode

With `capitalPathMode=true` (the current v0.4.2 posture on prod capital paths):

- All fallback routing is disabled — the `SERV-internal fallback` never runs.
- Primary trip → `CircuitAllOpenError` → engine `UNCERTAIN@0`.
- **No path back to `CLOSED`** without a redeploy.

This means: **any transient upstream event large enough to trip the primary CB is effectively a hard outage** until manual intervention. That is a latent availability risk that must be closed before v0.4.3 goes on capital paths with `capitalPathMode=false`.

### Design options for v0.4.3.1

**REJECTED — Small-payload synthetic probe (formerly Option A).** A `max_tokens:1` or 50-token ping does NOT reflect real DQL-axis latency (5s+ reasoning generation). Probe passes → HALF_OPEN → real DQL traffic immediately re-trips → OPEN. Circuit flaps without recovery. Hermes decision 2026-07-11: verworfen.

Remaining options (see `docs/v0431-recovery-fix-design.md` for full analysis):

**Sub-Option 1 — Axis-shaped probe with tolerance window.** Fixed real DQL-axis prompt (500 token context, ~200 token output), probe latency compared against dynamic threshold (e.g. 1.3× median of last 10 pre-trip successful primary latencies). Real axis shape, dynamic threshold.

**Sub-Option 2 — Time-based recovery + window flush.** Fixed cooldown (starting 5 min, exponential backoff on re-trip up to 60 min), then HALF_OPEN with explicit p90-window flush (no carry-over samples). 3 consecutive real axis calls under threshold → CLOSED.

**Sub-Option 3 — Two-tier CB (soft-OPEN + hard-OPEN).** After trip: soft-OPEN, every N-th traffic call gets through. 3 consecutive under-threshold → CLOSED. Any tripping call → hard-OPEN (classic HALF_OPEN-with-cooldown).

**Recommendation (Perplexity)**: Sub-Option 2, simplest, fewest hyperparameters. **Awaiting Hermes decision on sub-option + parameters before implementation.**

### Acceptance criteria for v0.4.3.1 close

- After a documented CB trip on a real provider, when the provider recovers, a subsequent verification within `cooldownMs + 60s` must observe a state transition of at least one alias circuit back to `CLOSED`.
- Regression test: same shape as PR #11 Test 3 (retry cluster), plus a follow-on verification after cooldown that asserts state transition.
- No regression in `capitalPathMode=true` safety: the recovery mechanism must not silently re-enable fallback routing on capital paths.
- **Empirical**: Re-Vollrun `v043_swift_primary_recert_w1` mit dem Fix MUSS primary-Route-Anteil > 80% über alle 100 Cases zeigen (Vollrun-Baseline vor Fix: 17/100 primary = 17%).

---

## v0.4.4 — Retry-Bug adv_084 / adv_098 [SEPARATE TRACK]

Deferred out of v0.4.2 into v0.4.3 into v0.4.4. Existing PR #10 body describes the symptom. Owner: separate ticket after v0.4.3 ships.

---

## Process Rule (2026-07-11, retroactive)

**"Done" = code committed + pushed to origin + raw data + report + manifest pushed to `dql-benchmark/main`.**

Session 2026-07-11 uncovered a communication gap where the assistant reported "commit cb9d83a" as done, but the branch was not yet on origin. Hermes correctly refused Vollrun-Go until the diff could be four-eyes reviewed. Retroactive process rule: no status message may claim completion until the push is confirmed.

---

## v0.4.4 — Suite v1.2 (UNCERTAIN-lastig)

Requires stable v0.4.3 baseline first. Prerequisite for the Option E revisit.

---

## v0.5 — AgentDojo Track

Requires v0.4.2+ stability. Not before v0.4.3 ships.
