# HANDOVER — Decision Quality Layer (DQL)

**Status:** Phase 0 scaffold committed. Ready for Phase 1 (real cascade wiring + Vercel deploy).

**Owner handoff:** Raul (product / repo) → Hermes (cascade wiring, deploy, HF token).

## What is done (Phase 0)

- Public repo at [ThoughtProof/decision-quality-layer](https://github.com/ThoughtProof/decision-quality-layer), MIT.
- API scaffold on Vercel serverless (`api/dql/verify.ts`, `axes.ts`, `health.ts`).
- Full request validation (`src/validation.ts`).
- Engine orchestrator with parallel per-axis execution and fail-open error handling (`src/engine/index.ts`).
- Per-axis prompt builders for all 5 axes (`src/engine/axes/*.ts`) — carrying the spike-validated framing.
- Aggregation logic with pre-registered rules (`src/aggregation.ts`).
- Cascade interface + `StubCascade` for local dev + `parseAxisResponse` shared parser.
- Vitest test suite covering aggregation, validation, cascade parsing, and engine orchestration.
- Docs: `README.md`, `docs/ARCHITECTURE.md`, `docs/SPIKE-RESULTS.md`.

## What is NOT done (Phase 1 work — Hermes)

### 1. Wire the real cascade

`api/dql/verify.ts` instantiates `StubCascade` (returns `UNCERTAIN` for every axis). To go live:

1. Implement a `PotCliCascade` in `src/engine/cascade-pot.ts` that calls `pot-cli`'s `runCascade` with the same nano→swift path validated by the Orthogonality Spike (see [docs/SPIKE-RESULTS.md](./docs/SPIKE-RESULTS.md)).
2. Reuse `parseAxisResponse` from `src/engine/cascade.ts` for output parsing.
3. Swap the `new StubCascade()` line in `api/dql/verify.ts`.
4. Add scenarios in `scenarios/` covering the 40 spike cases as regression tests.

### 2. Deploy to `dql.thoughtproof.ai`

- Vercel project setup (mirror `thoughtproof-sentinel` config).
- DNS: `dql.thoughtproof.ai` CNAME → Vercel.
- Env vars: cascade credentials, Upstash Redis for rate limiting.

### 3. HF endpoint (for BrowseSafe-Bench run, separate track)

- **Raul action first:** revoke the old chat-token `hf_PdI...` in HF settings — it went through a chat and must be assumed compromised.
- Extract new token from `~/Desktop/HF.pdf`.
- Deploy the endpoint (~$5).
- This is NOT a DQL dependency — it belongs to the BrowseSafe-Bench evaluation track and is listed here only to keep the token-handoff visible.

### 4. Middleware (Phase 2)

- API-key auth (mirror `src/auth.ts` from `thoughtproof-sentinel`).
- Upstash rate limiting.
- Optional: x402 gate if we want metered pricing on DQL.
- Billing hooks.

## Constraints — do not violate

1. **Do NOT modify `thoughtproof-sentinel`.** DQL is a separate product on its own repo, own endpoint, own cascade config. Prod-Sentinel carries live cb4a money and stays untouched.
2. **Do NOT re-brand DQL as "5-dimensional Sentinel"** in public copy. Sentinel returns one verdict per call and stays that way. DQL is a companion product with a different (per-axis) verdict shape.
3. **Marketing framing:** "5 axes that isolate different failure types — gross errors trigger multiple axes together, subtle errors trigger the specific one." NOT "5 completely independent checks" — the spike data shows meaningful co-fire on gross errors, and being honest about that is stronger than the loose claim.
4. **Naming stays "Decision Quality Layer" / "DQL"** — matches the blogpost that shipped 2026-07-07 at [thoughtproof.ai/blog/decision-quality-layer](https://thoughtproof.ai/blog/decision-quality-layer).

## Open questions for Raul

- **Waitlist comms:** do we announce the DQL API on the existing waitlist ([thoughtproof.ai/decision-quality-layer](https://thoughtproof.ai/decision-quality-layer)) now, or wait until Phase 1 (real cascade) is live?
- **Pricing:** freemium (Sentinel model: 100 calls/mo free, $0.02/call metered) — same for DQL, or different because 5-axis cascade cost is higher?
- **Domain confirmation:** `dql.thoughtproof.ai` OK, or a different subdomain?

## Timing target

- Full build (this repo → live): 10–15 working days.
- Wind-down deadline: 01.09.2026.
- Today: 08.07.2026 → 7½ weeks runway. Comfortable for the build, plus 2 weeks of testing/iteration, plus a launch window in the second half of August.
