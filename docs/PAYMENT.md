# DQL Payment Model

**One price, two rails, zero freemium.**

## Design principles

1. **Pay-as-you-go, no freemium.** Consumer decisions (booking a flight, big online purchase, agent-driven trade) are low-frequency events. A monthly free tier would let 99 % of consumers never pay — we'd subsidize the entire consumer segment. Every real call is billed.
2. **Two payment rails, same product.** Fiat customers get Stripe metered billing behind an API key. Crypto-native customers get x402 pay-per-call. Neither is a subclass of the other — same endpoint, same response, same price.
3. **Sandbox is free.** Developers integrating against the API contract need a way to test without incurring cost or hitting the cascade. `sandbox: true` in the request body returns a deterministic mock verdict. No account needed.
4. **Dev access is manual.** Prospective partners / researchers can request a dev-access API key by email. Grants are per-relationship, not automated.

## Price

**$0.05 per call.** Flat. Independent of the number of axes evaluated (evaluating a subset does not reduce the cost — the cascade cost is per-call, not per-axis).

## Payment rails

### Rail A — Stripe (fiat)

Customer flow:
1. Sign up on the DQL landing page → receive an API key.
2. Provide the key as `X-DQL-Key` header on every call.
3. Every non-sandbox call emits a Stripe Meter Event with amount = 0.05 USD.
4. Customer's Stripe invoice bills the accumulated meter events at the end of the billing period.

Implementation notes (Phase 2):
- Meter Events API endpoint: `https://api.stripe.com/v1/billing/meter_events`
- Meter event name: `dql_verify_call`
- Idempotency key: DQL request id (prevents double-billing on retries)
- API-key storage: Upstash Redis or Vercel KV (mirror Prod-Sentinel's `src/auth.ts` pattern)

### Rail B — x402 (crypto)

Customer flow:
1. Agent submits `POST /dql/verify` without an API key.
2. Server responds `402 Payment Required` with x402 challenge (asset, amount, chains supported).
3. Agent signs a payment and re-submits with `PAYMENT-SIGNATURE` header.
4. Server verifies + settles via x402 facilitator, then runs the cascade and returns the DQL response.

Implementation notes (Phase 2):
- Reuse Sentinel's `src/middleware/x402.ts` — supports Base mainnet (Circle facilitator) and GOAT Network (opt-in via env).
- Payment wallet: TBD — same address as Sentinel or a dedicated DQL wallet (open question in HANDOVER).
- No Redis-backed payment intents in v1 unless there is clear demand — direct verify+settle is enough.

## Decision matrix at the gate

```
POST /dql/verify received
  │
  ├── sandbox: true                                → run sandbox cascade, no charge
  │
  ├── X-DQL-Key present + valid + dev_access flag   → run real cascade, no charge
  │
  ├── X-DQL-Key present + valid + billable          → run real cascade, emit Stripe Meter Event
  │
  ├── PAYMENT-SIGNATURE header + valid x402         → verify+settle, run real cascade
  │
  └── Nothing                                       → 402 Payment Required
                                                       body: { stripe: <signup-url>, x402: <challenge> }
```

## What is intentionally NOT in this model

- **No freemium.** See design principle 1.
- **No monthly recurring subscription.** Pay-as-you-go removes the "did I use enough this month" friction and aligns cost with usage.
- **No volume discounts (yet).** Simple pricing until we see the distribution of customer usage. Volume tiering can be added without breaking the API surface.
- **No cost-per-axis knob.** The customer cannot "pay less by evaluating fewer axes" — the cascade cost dominates, per-axis prompting is marginal.
- **No BYOK (bring your own key) tier.** Considered — rejected for v1 because it complicates the surface (whose model? whose bill? whose latency?) without opening a segment we can't reach with Stripe or x402.

## Decisions locked (2026-07-08)

- **x402 wallet:** `0xAB9f84864662f980614bD1453dB9950Ef2b82E83` — same wallet as Sentinel. Simplifies accounting; no separate DQL wallet.
- **Stripe:** reuse the existing ThoughtProof Stripe account. Create a new meter `dql_verify_call` inside that account. Not a separate product / account.

## Still open for Phase 2

- **Dev-access grant flow** — email-based today; do we want a lightweight form or is a mailto: link enough for v1?
- **Refund / dispute policy** — if a customer disputes a Stripe charge, do we auto-refund below some threshold? Manual review above?
