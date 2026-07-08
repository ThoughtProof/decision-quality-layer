# HANDOVER — Decision Quality Layer (DQL)

**Status:** v0.2 **live on production** at [`https://dql.thoughtproof.ai`](https://dql.thoughtproof.ai). Signed off with Spike-80 regression baseline. Dev-access only (no payment gate yet).

**Owner handoff:** Raul (product / repo / baseline sign-off) → Hermes (merge policy / deploy discipline / on-call).

**Last updated:** 2026-07-08 21:25 CEST, at commit `0800638`.

---

## What is live now (v0.2)

- **Public repo:** [ThoughtProof/decision-quality-layer](https://github.com/ThoughtProof/decision-quality-layer), MIT, `main` at `0800638`.
- **Live URL:** [`https://dql.thoughtproof.ai`](https://dql.thoughtproof.ai) — version `0.2.0` on `GET /` and `GET /dql/health`.
- **Cascade:** `DQL_CASCADE=pot-cli` — real `serv-nano` → `serv-swift` via SERV (`inference-api.openserv.ai`).
- **Determinism:** temperature 0, seed 42 (Sentinel-congruent).
- **Endpoints:** `GET /`, `GET /dql/health`, `GET /dql/axes`, `GET /openapi.json`, `POST /dql/verify` (`sandbox: true` for free deterministic test).
- **Tests:** 73/73 hermetic, TypeScript clean, build clean.
- **Regression baseline:** Spike-80 (see below) signed off on live SERV cascade.

## Spike-80 regression baseline (2026-07-08)

The canonical regression set. Any code change that could affect cascade output must re-run `npm run scenarios:spike-80-live` before merge.

| Metric | Coarse-40 | Subtle-40 | **Spike-80** | Floor | Status |
|---|---:|---:|---:|---:|:--:|
| Parse rate | 100 % | 100 % | **100 %** | 100 % | ✅ |
| Axis-hit rate | 97.5 % | 97.5 % | **97.5 %** (78/80) | ≥ 90 % | ✅ |
| Mean pairwise correlation | 0.184 | **0.043** | **0.109** | ≤ 0.20 | ✅ |

Full analysis, per-pair correlation table, approved marketing framing, and rejected framings all live in [`docs/SPIKE-RESULTS.md`](./docs/SPIKE-RESULTS.md).

Files:
- `scenarios/spike-40-coarse.jsonl` (40 coarse cases, 8 per axis)
- `scenarios/spike-40-subtle.jsonl` (40 subtle cases, 8 per axis, real reasoning)
- `scenarios/spike-80.jsonl` (concat, 80 cases)
- `scenarios/spike-80-baseline-2026-07-08.json` (signed run report)

Runners (in `package.json`):
- `scenarios:spike-coarse` / `scenarios:spike-subtle` / `scenarios:spike-80` — local cascade, needs `SERV_API_KEY`
- `scenarios:spike-80-live` — POST to `https://dql.thoughtproof.ai/dql/verify`, no local key needed, ~$1.60 per full run

---

## Nine fixes that must not regress

Committed today. Any PR must preserve these:

**Congruence (`a6c401a`):**
1. SERV bindings (not OpenAI/Groq) — `serv-nano` → `serv-swift` via `SERV_API_KEY`.
2. Determinism pinned — `temperature: 0`, `seed: 42`.
3. `confirmFail` optionality — env-gated `DQL_CONFIRM_FAIL`, default OFF, mirrors Sentinel `confirmBlocks`.
4. ADR-0007 corrected — DQL runs two SERV capability tiers, not two vendor families.
5. Docs / OpenAPI / scenarios aligned to one key (`SERV_API_KEY`).

**Deploy:**
6. Functions-only build (`15677f0`) — `buildCommand: ""`, `outputDirectory: "."`, no `public/`.
7. `max_completion_tokens` for SERV (`05eb863`) — legacy `max_tokens` returned HTTP 400, silently defaulted cascade to `UNCERTAIN@0` (parse-rate looked fine while nothing evaluated).
8. `DQL_CASCADE` env-trim (`2040ce6`) — trailing newline in Vercel env value silently disabled real cascade.

**Test coverage:**
9. 73/73 tests green.

---

## Merge policy (Hermes-owned)

For any PR into `main`:

- Must rebase cleanly on current `origin/main` (do not merge stale branches — they may re-introduce fixed bugs).
- `npm test` must be 73/73 green.
- If the PR touches `src/engine/**` or `api/dql/verify.ts`, additionally require a `spike-80-live` re-run (~$1.60) before merge.
- Post-merge, verify `dql.thoughtproof.ai/dql/health` returns 0.2.x within 90 seconds of the Vercel deploy.

## Marketing / product-copy discipline

**Approved framing** (from `docs/SPIKE-RESULTS.md`):
> "Five axes that isolate different failure types. On coarse errors many axes fire in agreement (genuine multi-axis violation). On subtle errors the axes separate: mean pairwise correlation is 0.04 on a subtle-only test set and 0.11 on a mixed set, with six of ten axis-pairs near-zero correlated."

**Rejected framings — enforce:**
- "prevents malicious actions" / "stops X" / "schützt vor" — DQL grades reasoning, does not guarantee action safety
- "one axis per failure" / "cleanly isolates each error" — data doesn't support this on coarse errors
- "5-dimensional Sentinel" — Sentinel is a different product, single-verdict, separate deploy

## Constraints — do not violate

1. **Do NOT modify `thoughtproof-sentinel`.** DQL is a separate product on its own repo, own endpoint, own cascade config. Sentinel carries live money and stays untouched.
2. **Do NOT re-brand DQL as a Sentinel variant** in public copy.
3. **Standard-only cascade.** Do NOT expose a "checkpoint" / nano-solo tier — nano-solo oscillates on borderline cases in prod Sentinel.
4. **No freemium.** Consumer decisions are low-frequency; a monthly free tier would let 99 % never pay. See [docs/PAYMENT.md](./docs/PAYMENT.md).
5. **BrowseSafe is not a DQL cross-benchmark.** See [ADR-0008](./docs/adr/ADR-0008-reject-browsesafe-cross-benchmark.md). Content classifiers ≠ decision-reasoning classifiers.

## Decisions locked

- **Domain:** `dql.thoughtproof.ai` — deployed.
- **Cascade:** `serv-nano` → `serv-swift`, temp 0 / seed 42.
- **x402 wallet:** same as Sentinel — `0xAB9f84864662f980614bD1453dB9950Ef2b82E83`. No separate DQL wallet.
- **Stripe:** reuse the existing ThoughtProof Stripe account. New meter `dql_verify_call` inside it.
- **Waitlist comms:** hold. No announcement until Spike-80 has held over at least one non-trivial code change — i.e. the watchdog is proven in anger, not just at initial setup.
- **BrowseSafe cross-benchmark:** closed permanently (ADR-0008).

---

## What is NOT done (v0.3 roadmap)

### 1. Payment gates (Stripe metered + x402)

Spec'd in [`docs/PAYMENT.md`](./docs/PAYMENT.md), not wired yet. v0.2 is dev-access only. Requires:

- Port `src/auth.ts` from `thoughtproof-sentinel` (API-key validation + Upstash rate limiting).
- Emit `dql_verify_call` Stripe meter event per non-sandbox call.
- Port `src/middleware/x402.ts` from `thoughtproof-sentinel` with DQL prices.
- Sandbox path (`sandbox: true`) already implemented in v0.2, skips gate entirely.

**Blocked by:** waitlist-comms gate — Spike-80 must hold across one real code change first.

### 2. External reasoning benchmark (τ-bench / AgentBench / WebArena)

If external legitimation is required later, this is the right family (agentic reasoning benches with native task-trace shape). Not started, not on this week's roadmap.

### 3. HF endpoint (BrowseSafe-Bench track — now closed)

Track sunset alongside ADR-0008. The HF-token rotation (`hf_PdI...` → new token in `~/Desktop/HF.pdf`) is decoupled from DQL and lives on Raul's personal-security list, not on this repo's roadmap.

### 4. `confirmFail=ON` A/B on live traffic

`DQL_CONFIRM_FAIL` env exists, defaults OFF. Once we have payment traffic and a signal source, run an A/B to measure whether ON reduces false-positives on high-confidence FAIL without impacting recall. Deferred until payment lands.

---

## Timing

- Today: 2026-07-08 → 7 weeks runway to the 2026-09-01 wind-down deadline.
- v0.2 live: 2026-07-08 (today). Ahead of the 10–15-day build plan by ~1 week.
- Payment landing target: mid-to-late July, gated on Spike-80 in-anger validation.
- Launch window: second half of August, if payment lands and no v0.2 regressions surface.
