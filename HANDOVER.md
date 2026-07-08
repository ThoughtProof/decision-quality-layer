# HANDOVER — Decision Quality Layer (DQL)

**Status:** Phase 0.2 committed — real cascade adapter wired behind `DQL_CASCADE=pot-cli`. Ready for Vercel deploy + payment gates (Phase 2).

**Owner handoff:** Raul (product / repo) → Hermes (cascade wiring, deploy, HF token).

## What is done (Phase 0)

- Public repo at [ThoughtProof/decision-quality-layer](https://github.com/ThoughtProof/decision-quality-layer), MIT.
- API scaffold on Vercel serverless (`api/dql/verify.ts`, `axes.ts`, `health.ts`).
- Full request validation (`src/validation.ts`).
- Engine orchestrator with parallel per-axis execution and fail-open error handling (`src/engine/index.ts`).
- Per-axis prompt builders for all 5 axes (`src/engine/axes/*.ts`) — carrying the spike-validated framing.
- Aggregation logic with pre-registered rules (`src/aggregation.ts`).
- Cascade interface + `StubCascade` for local dev + `parseAxisResponse` shared parser.
- **PotCliCascade** (`src/engine/cascade-pot.ts`) — real two-stage cascade (`serv-nano` → `serv-swift`) with early-exit, degraded-mode, and conservative disagreement rules ported from the Sentinel `runCascade` ADR-0007 pattern.
- **HttpLlmClient** (`src/engine/llm-client.ts`) — minimal OpenAI-compatible provider router. Cross-family default (OpenAI + Groq).
- ENV-gated cascade swap in `api/dql/verify.ts` (`DQL_CASCADE=stub` default, `pot-cli` for live).
- Vitest suite — 50 tests covering aggregation, validation, cascade parsing, engine orchestration, and the full cascade decision matrix (early-exit, agreement, disagreement, UNCERTAIN handling, degraded mode).
- Docs: `README.md`, `docs/ARCHITECTURE.md`, `docs/SPIKE-RESULTS.md`, `docs/PAYMENT.md`, `docs/ENV.md`.

## What is NOT done (Phase 1 work — Hermes)

### 1. Regression scenarios from the Orthogonality Spike

The cascade is wired but the 40 spike cases from [docs/SPIKE-RESULTS.md](./docs/SPIKE-RESULTS.md) are NOT yet locked in as regression tests. Add `scenarios/spike-40.jsonl` and a runner that replays them through `PotCliCascade` against live models on demand (out of the default vitest run — they cost money and are non-deterministic). Target: 95%+ axis-hit-rate holds after the wiring, matching the spike.

### 2. Deploy to `dql.thoughtproof.ai`

- Vercel project setup (mirror `thoughtproof-sentinel` config).
- DNS: `dql.thoughtproof.ai` CNAME → Vercel.
- Env vars — see [docs/ENV.md](./docs/ENV.md). Minimum for a live deploy: `DQL_CASCADE=pot-cli`, `SERV_API_KEY`. Upstash Redis for rate-limit lands with payment gates.

### 3. HF endpoint (for BrowseSafe-Bench run, separate track)

- **Raul action first:** revoke the old chat-token `hf_PdI...` in HF settings — it went through a chat and must be assumed compromised.
- Extract new token from `~/Desktop/HF.pdf`.
- Deploy the endpoint (~$5).
- This is NOT a DQL dependency — it belongs to the BrowseSafe-Bench evaluation track and is listed here only to keep the token-handoff visible.

### 4. Payment gates (Phase 2)

See [docs/PAYMENT.md](./docs/PAYMENT.md) for the full model. Summary:

- **Pay-as-you-go at $0.05 / call. No freemium.**
- **Stripe metered** — API-key holders. Emit a `dql_verify_call` meter event per non-sandbox call. Mirror `src/auth.ts` from `thoughtproof-sentinel` for key validation + Upstash rate limiting.
- **x402** — crypto-native. Port `src/middleware/x402.ts` from `thoughtproof-sentinel` with DQL prices + (TBD) wallet address.
- **Dev-access API keys** — same key format, `dev_access: true` flag skips charging. Granted manually.
- **Sandbox** — `sandbox: true` in request body already implemented in Phase 0 (`SandboxCascade`). Free, deterministic. Skip the payment gate entirely.

## Constraints — do not violate

1. **Do NOT modify `thoughtproof-sentinel`.** DQL is a separate product on its own repo, own endpoint, own cascade config. Prod-Sentinel carries live cb4a money and stays untouched.
2. **Do NOT re-brand DQL as "5-dimensional Sentinel"** in public copy. Sentinel returns one verdict per call and stays that way. DQL is a companion product with a different (per-axis) verdict shape.
3. **Marketing framing:** "5 axes that isolate different failure types — gross errors trigger multiple axes together, subtle errors trigger the specific one." NOT "5 completely independent checks" — the spike data shows meaningful co-fire on gross errors, and being honest about that is stronger than the loose claim.
4. **Naming stays "Decision Quality Layer" / "DQL"** — matches the blogpost that shipped 2026-07-07 at [thoughtproof.ai/blog/decision-quality-layer](https://thoughtproof.ai/blog/decision-quality-layer).
5. **Standard-only cascade.** Do NOT expose a "checkpoint" / nano-solo tier. Prod-Sentinel experience shows nano-solo oscillates on borderline cases; DQL always runs nano → swift.
6. **No freemium.** Consumer decisions are low-frequency; a monthly free tier would let 99 % of consumers never pay. See [docs/PAYMENT.md](./docs/PAYMENT.md).

## Decisions locked (2026-07-08)

- **Domain:** `dql.thoughtproof.ai` — confirmed.
- **x402 wallet:** same as Sentinel — `0xAB9f84864662f980614bD1453dB9950Ef2b82E83`. No separate DQL wallet.
- **Stripe:** reuse the existing ThoughtProof Stripe account. New meter (`dql_verify_call`) inside it, not a new product / account.
- **Waitlist comms:** hold. No public DQL-API announcement until the real cascade is wired and the endpoint returns real verdicts. The waitlist landing at [thoughtproof.ai/decision-quality-layer](https://thoughtproof.ai/decision-quality-layer) stays as-is.

## Timing target

- Full build (this repo → live): 10–15 working days.
- Wind-down deadline: 01.09.2026.
- Today: 08.07.2026 → 7½ weeks runway. Comfortable for the build, plus 2 weeks of testing/iteration, plus a launch window in the second half of August.
