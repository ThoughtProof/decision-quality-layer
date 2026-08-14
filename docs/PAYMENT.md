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

## Implementation status (2026-08-14)

**`SELF_SERVE_LIVE=partial`** — payment **rails** live in Production (x402 + Stripe meter canary + Upstash daily-cap). Checkout **code** exists (`POST /dql/checkout`, signed webhook, one-time key reveal) behind `DQL_CHECKOUT_ENABLED` (**default OFF**). Merge ≠ public billing. Do **not** claim `SELF_SERVE_LIVE=true` until Raul flips the flag and smokes Production. No public signup UX on `app.thoughtproof.ai` yet. No freemium.

Code path **merged via [PR #36](https://github.com/ThoughtProof/decision-quality-layer/pull/36)** → `main` merge commit **`9f3c1b4`** (PR head `4c27363`).  
Production: `dql.thoughtproof.ai` · cascade `pot-cli`.

### Payment semantics (locked; review PASS)

```
Request validate
→ Payment VERIFY (x402) / auth key check
→ DQL execute
→ Payment SETTLE (x402) OR await Stripe meter
→ Deliver result
```

Hard rules:
1. **Never settle x402 before successful DQL.** Invalid body / 4xx / 5xx must not charge.
2. **Stripe meter is awaited** (not fire-and-forget). Vercel drops dangling work after response.
3. **No silent public facilitator fallback.** x402 requires CDP credentials **or** explicit `X402_FACILITATOR_URL`.
4. **Hard timeouts** on facilitator + Stripe network calls; client errors sanitized.
5. **Readiness before challenge.** Flag-on without facilitator readiness → `503 PAYMENT_UNAVAILABLE`, never a 402 challenge.
6. **Unknown settlement ≠ not charged.** Timeout/connection-drop after settle request → `PAYMENT_STATUS_UNKNOWN` + reconcile id. Authoritative `success:false` → `PAYMENT_FAILED`.
7. **Stripe price is Dashboard-side.** Meter event sends `value=1`; configure $0.05 on the Stripe Meter/Price object.

| Rail | Code status | Production | Enable |
|---|---|---|---|
| Stripe meter `dql_verify_call` | Merged · unit tests (awaited + timeout) | **ON** (canary owner `dql-canary` → `cus_V4abfGkmWdyxyC`) | Dashboard meter/price live; prod flag + secret + map |
| x402 Base USDC | Merged · Preview + **Production canary PASS** | **ON** (`DQL_X402_ENABLED` + CDP keys) | live |
| Upstash daily-cap multi-instance | Merged · unit-verified atomic INCR; Redis key = sha256(apiKey) | **ON** (shared Sentinel Upstash; keys `dql:usage:…`) | bound 2026-08-15; over-cap → 429 `QUOTA_EXCEEDED` |
| Stripe Checkout → persist `dqlk_…` | **Code** · unit tests (mint → auth → revoke; env canary; no key in logs) | **OFF** (`DQL_CHECKOUT_ENABLED` unset) | flag + webhook secret + Upstash; see below |

Auth + customer-map + daily-cap consult **env ∪ Upstash store**. `DQL_API_KEYS` and `DQL_STRIPE_CUSTOMER_MAP` remain bootstrap (canary / guardian-pwa / manual `dev_access`). Self-serve keys are `dev_access: false`, stored as sha256 only, bound to `cus_…`. Plaintext is shown **once** on `GET /dql/checkout?session_id=cs_…` (session id in the query, never the raw key).

### Checkout / webhook (local + prod flag)

**Local (Stripe test mode):**

```bash
# Terminal A — forward webhooks (prints whsec_…)
stripe listen --forward-to localhost:3002/dql/webhooks/stripe

# Terminal B
export DQL_CHECKOUT_ENABLED=true
export STRIPE_SECRET_KEY=sk_test_…
export STRIPE_WEBHOOK_SECRET=whsec_…          # from stripe listen
export DQL_PUBLIC_BASE_URL=http://localhost:3002
export UPSTASH_REDIS_REST_URL=…               # required to persist keys
export UPSTASH_REDIS_REST_TOKEN=…
# Optional: Dashboard metered price so Checkout uses subscription mode
# (pay-as-you-go invoices). Without it, Checkout is setup-mode (card on file).
# export DQL_STRIPE_PRICE_ID=price_…
DQL_CASCADE=stub npx vercel dev --listen 3002

curl -s -X POST http://localhost:3002/dql/checkout \
  -H 'content-type: application/json' \
  -d '{"email":"you@example.com"}'
# → { "url": "https://checkout.stripe.com/…", "session_id": "cs_…" }
# Complete Checkout, then:
curl -s 'http://localhost:3002/dql/checkout?session_id=cs_…'
# → { "api_key": "dqlk_…", "shown_once": true }   # once only
```

Stripe Dashboard webhook (prod): endpoint `https://dql.thoughtproof.ai/dql/webhooks/stripe`, event `checkout.session.completed`, signing secret → `STRIPE_WEBHOOK_SECRET`. Shared ThoughtProof Stripe account: only sessions with `metadata.dql_checkout=1` are minted; other events are ignored.

**Prod flip (Raul):** set `DQL_CHECKOUT_ENABLED=true` **after** `STRIPE_WEBHOOK_SECRET` + Upstash are bound. Redeploy. Smoke: one test Checkout → reveal once → `POST /dql/verify` with `X-DQL-Key` → `X-DQL-Meter: ok`. Until that smoke, keep **`SELF_SERVE_LIVE=partial`**.

Webhook signature is required. No Stripe secrets in the repo.

### Activation proof

**Preview E2E (pre-merge):**
- Tx [`0x2fc1c4a46e4219ac5bda23c907a3930d23ec08e9d1f2dbefcea0de7130f22ed6`](https://basescan.org/tx/0x2fc1c4a46e4219ac5bda23c907a3930d23ec08e9d1f2dbefcea0de7130f22ed6) · $0.05 USDC · HTTP 200 · billing x402
- Artifact: `memory/artifacts/dql-x402-e2e-step3-2026-08-14.json`

**Production canary (2026-08-14, post-merge explicit go):**
- Env: `DQL_X402_ENABLED=true` + `X402_CDP_KEY_ID/SECRET` (Production)
- Challenge smoke PASS on `dql.thoughtproof.ai` (402 + payment-required + amount 50000 + Base USDC + payTo `0xAB9f…`)
- Live settle: exactly one $0.05 · HTTP 200 · billing `x402`
- Tx [`0x70f93e79533d3c8caf7a7b5ee6ae2a218992bf97e45f095bcf797b534c8b70bf`](https://basescan.org/tx/0x70f93e79533d3c8caf7a7b5ee6ae2a218992bf97e45f095bcf797b534c8b70bf) · block `49971716` · Transfer 50000 micro-USDC → `0xAB9f…82E83`
- Artifact: `memory/artifacts/dql-x402-prod-canary-2026-08-14.json`

**Stripe meter Production canary (2026-08-14):**
- Env: `DQL_STRIPE_METER_ENABLED=true` + `STRIPE_SECRET_KEY` + `DQL_STRIPE_CUSTOMER_MAP`
- Billable key owner `dql-canary` (`dev_access=false`); guardian-pwa remains free
- Smoke: HTTP 200 · `X-DQL-Billing: metered` · **`X-DQL-Meter: ok`** · `$0.05` · request `dql_mstgnams_cs8s91`
- Artifact: `memory/artifacts/dql-stripe-prod-canary-2026-08-14.json`

**Upstash daily-cap Production bind (2026-08-15):**
- Env: `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN` (same DB as Sentinel; DQL namespaced)
- Smoke: counter@cap → **429** `QUOTA_EXCEEDED` (`dql_msthu647_ip91cp`); after reset → **200** metered (`dql_msthu6sb_amgn7z`)
- Artifact: `memory/artifacts/dql-upstash-prod-bind-2026-08-15.json`

**Honest claims:** crypto pay-per-call (x402) and fiat meter emit (Stripe canary) work in Production. Daily-cap brake is live. Checkout **code** can mint a persisted billable key, but the public flag is **OFF** — not a live self-serve claim. No freemium. Invite/dev keys still free. Env canary `dql-canary` → `cus_V4abfGkmWdyxyC` is unchanged.
