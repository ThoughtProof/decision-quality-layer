# ADR-0008 — Reject BrowseSafe as a DQL cross-benchmark

**Status:** Accepted
**Date:** 2026-07-08
**Decider:** Raul Jaeger
**Supersedes:** —
**Superseded by:** —

## Context

During v0.2 planning we considered running DQL against the BrowseSafe benchmark to obtain an external evaluation number, on the assumption that "both are AI safety benchmarks" and therefore comparable. Two attempts in the same day exposed a category error:

1. Sentinel (`action_authorization`) vs DQL — abandoned mid-session once it became clear Sentinel authorizes actions and DQL grades reasoning, so the two do not share an evaluation shape.
2. BrowseSafe raw-HTML samples vs DQL — the DQL API requires `mandate + proposed_action + reasoning`. BrowseSafe samples are raw HTML with a maliciousness label; there is no mandate, no proposed action, no agent reasoning to grade.

The naive path (feed HTML into DQL's `proposed_action` or `reasoning`) reproduces the Sentinel framing error: everything degenerates to `UNCERTAIN` or coincidentally-shaped verdicts, and the resulting number measures nothing.

## Decision

We do **not** run DQL against BrowseSafe. Not as an official benchmark, not as an internal sanity check, not "later, with a mapping layer". BrowseSafe is removed from the DQL evaluation roadmap.

## Rationale

**BrowseSafe and DQL measure different things:**

| Dimension | BrowseSafe | DQL |
|---|---|---|
| Input | Raw HTML content | Agent decision tuple `{mandate, action, reasoning}` |
| Question | "Is this content malicious?" | "Is this decision defensible against the mandate?" |
| Category | Content classifier (toxicity / injection) | Decision-reasoning classifier (five orthogonal axes) |
| Failure mode measured | Unsafe input reaches the agent | Unsafe *decision* reaches the user |

A cross-benchmark between the two would require synthesising an agent-decision dataset from BrowseSafe samples. That is not a cross-benchmark — it is a new internal dataset (effectively Spike-40 v2), which we already have a better path for (see ADR-0009 pending on Spike-80).

**The correct DQL evaluation surface is agent-decision data.** We have one (`scenarios/spike-40.jsonl`) with a signed live baseline (2026-07-08, parse 100 %, axis-hit 97.5 %, mean pairwise correlation 0.184). That baseline is the regression watchdog for v0.2 code changes. It is not, and should not be marketed as, "we beat BrowseSafe."

**If external legitimation is required later**, the right benchmark family is agentic reasoning benches with native mandate/action/outcome shape — τ-bench, AgentBench task-success suites, or WebArena trajectory grading. Not BrowseSafe.

## Consequences

- No A100 endpoint spin-up for BrowseSafe-DQL bridging. Spend avoided.
- No mapping layer in the codebase to translate HTML → decision tuple. Complexity avoided.
- The "how does DQL compare externally?" question is deferred to a proper agent-reasoning bench and gated on v0.2 having demonstrated stability over time.
- The Spike-40 live baseline remains the sole authoritative DQL evaluation until Spike-80 (ADR-0009 pending) supersedes it as the primary regression set.

## Alternatives considered

**A. Naive BrowseSafe → DQL mapping (HTML into `proposed_action`).**
Rejected. Reproduces the Sentinel category error observed 2026-07-08.

**B. Synthesise decision tuples from BrowseSafe samples.**
Rejected. This is a new internal dataset, not a cross-benchmark; the label transfer from "malicious HTML" to "bad decision" is not obvious and would need its own validation. Effort dominates the value — Spike-80 targets the same evaluation goal with cleaner provenance.

**C. Postpone the decision.**
Rejected. Twice in one day the same category error was reproduced. Without an explicit ADR the temptation returns on the next roadmap sweep.

## Notes

Cross-referenced by: `docs/SPIKE-RESULTS.md` (live baseline, co-firing caveat), `HANDOVER.md` (v0.3 planning surface).
