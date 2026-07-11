# DQL Roadmap — Post-v0.4.3

Tracked technical debt and follow-ups that are **not blockers** for the current release but must remain visible for future planning. Do not close items here silently — either address them in a version or explicitly re-classify (accept / defer with reason).

---

## v0.4.4 — CircuitBreaker Recovery Blindspot [BLOCKING TICKET]

**Discovered**: 2026-07-11 during v0.4.3 pre-flight Check B (30 cases × N=3, `runs/preflight_b_summary.json`).
**Status**: known limitation of the current CircuitBreaker + engine fail-closed interaction. Explicitly deferred out of v0.4.3 scope (PR #11 fixes the trip trigger at the root, which reduces the frequency of hitting this state to near-zero on healthy providers).
**Priority**: high — must be addressed in v0.4.4. Not optional.

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

### Design options for v0.4.4

Options (documented for context — final decision at v0.4.4 planning time):

**Option A — Engine-side synthetic probe.** When the engine emits a fail-closed verdict AND the elapsed time since the last CB trip exceeds `cooldownMs`, spawn an out-of-band `client.probe(alias)` call that issues a minimal health-check payload (`max_tokens: 1`, no billing-relevant prompt). If the probe succeeds → recovery. Cost: 1 minimal call per fail-closed verdict per alias per cooldown window.

**Option B — Sampling-based recovery.** For every N-th fail-closed verdict (e.g. every 10th), let 1 axis of that request take the normal client path anyway. `canProceed()` runs and, if cooldown has elapsed, HALF_OPEN → probe → success closes the circuit. No new code paths, just conditional routing.

**Option C — Time-based auto-transition inside the CB itself.** Move the OPEN → HALF_OPEN transition into a wall-clock check that runs periodically (not caller-triggered). Requires background polling or lazy evaluation on `snapshot()`. Least invasive at the call site, but crosses the abstraction boundary — the CB starts observing the clock instead of being asked.

**Recommendation** (subject to review at v0.4.4 planning): Option A. Explicit, testable, keeps the CB purely reactive, and the cost is one health-check call per fail-closed verdict per cooldown window — negligible.

### Acceptance criteria for v0.4.4 close

- After a documented CB trip on a real provider, when the provider recovers, a subsequent verification within `cooldownMs + 60s` must observe a state transition of at least one alias circuit back to `CLOSED`.
- Regression test: same shape as PR #11 Test 3 (retry cluster), plus a follow-on verification after cooldown that asserts state transition.
- No regression in `capitalPathMode=true` safety: the recovery mechanism must not silently re-enable fallback routing on capital paths.

---

## v0.4.4 — Retry-Bug adv_084 / adv_098 [SEPARATE TRACK]

Deferred out of v0.4.2 into v0.4.3 into v0.4.4. Existing PR #10 body describes the symptom. Owner: separate ticket after v0.4.3 ships.

---

## v0.4.4 — Suite v1.2 (UNCERTAIN-lastig)

Requires stable v0.4.3 baseline first. Prerequisite for the Option E revisit.

---

## v0.5 — AgentDojo Track

Requires v0.4.2+ stability. Not before v0.4.3 ships.
