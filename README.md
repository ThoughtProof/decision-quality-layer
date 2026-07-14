# Decision Quality Layer (DQL)

**5-axis reasoning verification for AI agents.**

DQL evaluates an AI-agent decision along five isolable axes:

| Axis | Question | Failure mode |
|---|---|---|
| **Intent** | Does the action pursue the goal the user stated? | Goal drift |
| **Scope** | Does the action stay within the granted authority? | Scope creep |
| **Risk** | Was the downside identified and weighed? | Blind optimism |
| **Consistency** | Does the conclusion follow from its own premises? | Contradiction |
| **Reversibility** | Is the commitment shape appropriate? | Irreversibility blindness |

Where **[Sentinel](https://sentinel.thoughtproof.ai)** returns a single verdict per call, DQL returns one verdict per axis plus an aggregate — so callers know *which* dimension of the decision is weak, not just *that* it is weak.

## Why five axes, not one

The five axes were pre-registered before empirical validation. The **Orthogonality Spike (2026-07-08)** ran 40 hand-crafted cases (8 per axis) through the cascade and measured pairwise correlation between axis verdicts:

- **Parse rate:** 100 %
- **Axis-hit rate:** 95 %
- **Mean inter-axis correlation:** **0.09**
- **Max inter-axis correlation:** 0.39

Pre-registered decision rule: mean corr ≥ 0.85 → don't build; 0.60–0.85 → delay; 0.40–0.60 → build if wind-down cleared; < 0.40 → build. **Result: BUILD (strong).**

Full spike report: [docs/SPIKE-RESULTS.md](./docs/SPIKE-RESULTS.md).

## Pricing

**Pay-as-you-go. No freemium.**

| Path | Price | Who |
|---|---|---|
| **Stripe** (metered) | $0.05 / call | API-key holders (fiat, no wallet) |
| **x402** (per-call) | $0.05 / call | Crypto-native agents (Base or GOAT) |
| **Dev access** | Free | Granted manually on request — mail team |
| **Sandbox** (`sandbox: true` in body) | Free | Anyone — deterministic mock, integration testing only |

DQL runs a single tier: the nano → swift cascade validated by the Orthogonality Spike. Nano-solo (a hypothetical faster/cheaper "checkpoint" tier) is intentionally not exposed — Prod-Sentinel experience shows nano-solo oscillates on borderline cases, and DQL's whole promise is reliable per-axis verdicts.

## Status

**Phase 0 (this repo, today):** API scaffold, request validation, engine orchestration, aggregation, per-axis prompt builders, sandbox cascade. Real cascade is stubbed — every non-sandbox axis returns `UNCERTAIN` until Phase 1 wires the pot-cli cascade.

**Phase 1 (next):** Wire cascade to `pot-cli`'s nano→swift path (validated by the spike). Deploy to `dql.thoughtproof.ai` via Vercel.

**Phase 2:** Payment gates — Stripe metered ($0.05/call for API-key holders) and x402 (per-call for crypto-native agents). Both flows return the same DQL response.

## API

### `POST /dql/verify`

**Request:**

```json
{
  "mandate": "Swap 100 USDC to ETH",
  "proposed_action": "Grant unlimited USDC approval to Uniswap router, then swap 100 USDC",
  "reasoning": "Unlimited approval saves gas on future swaps",
  "context": "(optional) additional evidence",
  "axes": ["intent", "scope", "risk", "consistency", "reversibility"],
  "sandbox": false
}
```

- `mandate`, `proposed_action`, `reasoning` — required strings
- `context` — optional string with extra evidence
- `axes` — optional array; defaults to all five
- `sandbox` — optional boolean; when true, returns a deterministic mock without running the cascade (free, for integration testing)

**Response:**

```json
{
  "id": "dql_abc123",
  "version": "0.1.0",
  "axes": [
    { "axis": "intent",        "verdict": "PASS", "confidence": 0.9, "reasoning": "...", "objection": "" },
    { "axis": "scope",         "verdict": "FAIL", "confidence": 0.9, "reasoning": "...", "objection": "unlimited approval where exact-amount would suffice" },
    { "axis": "risk",          "verdict": "PASS", "confidence": 0.8, "reasoning": "...", "objection": "" },
    { "axis": "consistency",   "verdict": "PASS", "confidence": 0.9, "reasoning": "...", "objection": "" },
    { "axis": "reversibility", "verdict": "PASS", "confidence": 0.7, "reasoning": "...", "objection": "" }
  ],
  "aggregate": {
    "verdict": "BLOCK",
    "confidence": 0.9,
    "triggered_by": ["scope"],
    "rationale": "Blocked on scope. High-confidence axis failure(s)."
  },
  "meta": {
    "duration_ms": 1234,
    "models_used": ["serv-nano", "serv-swift"],
    "axes_evaluated": ["intent", "scope", "risk", "consistency", "reversibility"],
    "sandbox": false
  }
}
```

### `GET /dql/axes`

Returns the five axis definitions — useful for rendering per-axis UI.

### `GET /dql/health`

Liveness endpoint.

## Aggregation rules (v0.1)

1. Any axis `FAIL` with confidence ≥ 0.7 → `BLOCK`
2. Two or more axes `UNCERTAIN` → `REVIEW`
3. Any axis `FAIL` with confidence 0.5–0.7 → `REVIEW`
4. Any axis `UNCERTAIN` with confidence ≥ 0.7 → `REVIEW`
5. Otherwise → `ALLOW`

Callers always receive the raw per-axis results and can override.

## Development

```bash
npm install
npm run typecheck
npm run test
npx vercel dev --listen 3002
```

### Continuous integration

Every pull request into `main` and every push to `main` runs `.github/workflows/ci.yml`, which runs three independent jobs — `test` (`npm test`), `typecheck` (`npm run typecheck`), and `build` (`npm run build`) — on Node 20 with `npm ci`. The full hermetic suite (including OpenAPI and Spike-80 checks) runs under `test`. These jobs become merge gates only once they are configured as required status checks in branch protection.

## Relationship to other ThoughtProof products

- **[Sentinel](https://sentinel.thoughtproof.ai)** — single-verdict production API for agentic-commerce checkpoints (live, carries money).
- **DQL** — 5-axis diagnostic layer for agent decisions. Complements Sentinel; does not replace it.
- **[BrowseSafe-eval](https://github.com/ThoughtProof/browsesafe-eval)** — evaluation harness that measures how DQL and Sentinel complement input-layer prompt-injection detectors like BrowseSafe.

## License

MIT — see [LICENSE](./LICENSE).
