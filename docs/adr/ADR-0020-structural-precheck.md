# ADR-0020 — Deterministic Structural Pre-Check (shadow-first)

**Status:** Accepted  
**Date:** 2026-07-20  
**Decider:** Raul Jaeger  
**Supersedes:** —  
**Superseded by:** —

## Context

DQL grades agent decisions on five LLM axes. Several high-value failure modes are
**binary and unfixable** when the caller already has machine-readable fields:

1. Amount overshoot (`proposed.amount > granted.max_amount`)
2. Recipient / IBAN mismatch
3. Unlimited approval without explicit grant
4. Clear history-band break (`amount_variance_from_history` far outside band on
   established counterparties)

Sentinel solved the same class for `action_authorization` via
`authorization-gate.ts` (ADR-0019): deterministic code runs **before** the LLM,
fail-toward-silence, add-only blocks, shadow → enforce rollout.

DQL previously had **no** equivalent. Scope/risk “HARD RULES” lived only in
prompts. That is slower, non-deterministic, and calibration-sensitive — and it
leaves the structural shard that production graphs need inside the model.

DQL is not Sentinel. Consumer lanes use history-as-authorization and
middle-lane REVIEW. A naive port of the auth gate would smash Lane-A / first-payment
behavior if it parses prose or blocks soft cases.

## Decision

Add a **narrow deterministic structural pre-check** to DQL:

- New optional request fields:
  - `structured_context` — typed granted / proposed / history fields
  - `gate_mode` — `'shadow'` (default) | `'enforce'`
- Module: `src/engine/structural-precheck.ts`
- Runs in `runVerification` **before** the axis cascade
- Philosophy (identical to Sentinel / fact-check-core):
  - **Fail toward silence** — missing/ambiguous fields → no opinion
  - **Add-only** — can only ADD blocks, never ALLOW
  - **Never throw** — internal errors → silent
- Default **`shadow`**: compute + attach `response.structural`, still run full
  cascade (no behavior change for callers who ignore the field)
- **`enforce`**: on hard violation, short-circuit cascade, return aggregate
  `BLOCK` with a synthetic high-conf `scope` FAIL; other axes are
  `UNCERTAIN@0` with reasoning `skipped — structural enforce short-circuit`
  (**never fabricated PASS** — receipt honesty)
- **No prose parsing** in v0 — only explicit typed fields
- Amount compare only when currencies are unambiguously comparable:
  both unset **or** both set and equal. One-sided currency → silence
- History variance only fires when history count ≥ 3 **and** variance field is
  present and above a hard threshold (initial 0.20). Soft history / first-payment
  cases stay with the LLM axes.

## Trust boundary

`structured_context.granted.*` MUST be principal-/platform-supplied (wallet
session, payment rail, host policy), **not** agent-asserted. If the agent can
set or omit `granted` fields, the gate is trivially bypassable (omit → silent).
Integrators own this boundary; DQL only consumes the typed fields it is given.

## Non-goals (v0)

- Parsing amounts/recipients out of free-text `mandate` / `context`
- Intent / risk / consistency / reversibility structural rules
- Adversarial-pattern detection
- Replacing Scope LLM for residual / prose cases (cascade still owns those)
- Server-side `gate_mode` floor / key allowlist (see Rollout note)

## Consequences

- Clear audit path: `structural.violations[].kind` (e.g. `amount_overshoot`)
- Cheaper enforce-path blocks on trivial scope breaks
- Calibration surface for shadow→enforce without touching axis prompts
- Callers without `structured_context` are unaffected
- OpenAPI / validation gain two optional fields
- Enforce receipts never claim PASS on axes that did not run

## Alternatives considered

**A. Keep everything in LLM prompts.**  
Rejected for binary numeric/identity checks — same failure class ADR-0019 fixed.

**B. Full Sentinel gate port + prose mandate parsing.**  
Rejected — too aggressive for DQL consumer/history lanes.

**C. Only log, never expose on response.**  
Rejected — shadow calibration needs a visible, testable artifact.

## Rollout

1. Land behind default `gate_mode=shadow`
2. Measure would-block rate vs cascade scope FAIL on traffic with structured fields
3. Flip specific clients / keys to `enforce` only after false-block review

### Step 2 instrumentation (shipped)

- Every `runVerification` emits one structured log line:
  `{"event":"dql.structural_shadow", ...agreement, would_block, scope_verdict, ...}`
- Process-local counters + `GET /dql/structural-metrics` for live canary peek
  (honest: serverless per-instance; durable N-day rates = log drain on the event)
- Agreement labels: `both_block | structural_only | cascade_only | neither |
  enforced_short_circuit | silent | no_scope_axis`
- `HISTORY_VARIANCE_HARD = 0.2` remains INITIAL/UNCALIBRATED until real-traffic
  `history_variance_break` samples exist (see code comment)

**Follow-up (not v0):** today `gate_mode` is fully caller-controlled. When step 3
goes live, add a server floor (env allowlist / per-key force-enforce) so a client
cannot silently downgrade `enforce` → `shadow`. Harmless while default is shadow.
