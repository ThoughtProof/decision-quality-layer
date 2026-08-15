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

## Implementation status (2026-08-15)

**`SELF_SERVE_LIVE=partial`** — payment **rails** live in Production (x402 + Stripe meter canary + Upstash daily-cap). Checkout **code** exists (`POST /dql/checkout`, signed webhook, one-time key+account-token reveal, prepaid ledger + trial guards, post-purchase `/dql/account`) behind `DQL_CHECKOUT_ENABLED` (**default OFF**). Merge ≠ public billing. Merge ≠ live packs. Merge ≠ flag-on. Do **not** claim `SELF_SERVE_LIVE=true` and do **not** claim a live self-serve product until Raul flips the flag and smokes Production. The App can be a thin post-purchase client against this API; that is not a live product claim. `no_freemium=true`.

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
| Stripe Checkout → persist `dqlk_…` + prepaid ledger + account session | **Code** · unit tests (pack mint → decrement → hard-stop; PAYG meter; trial email∪fingerprint; daily-cap; reveal token once; rotate/revoke; flag default OFF) | **OFF** (`DQL_CHECKOUT_ENABLED` unset) | flag + **both** pack prices in Dashboard + ledger deployed + webhook secret + Upstash + (optional) App URL + Stripe Customer Portal; see below |

Auth + customer-map + daily-cap + prepaid credits consult **env ∪ Upstash store**. `DQL_API_KEYS` and `DQL_STRIPE_CUSTOMER_MAP` remain bootstrap (canary / guardian-pwa / manual `dev_access`). Self-serve keys are `dev_access: false`, stored as sha256 only, bound to `cus_…`. One live key per Stripe customer. Plaintext `dqlk_…` **and** an account session `dqla_…` are shown **once** on `GET /dql/checkout?session_id=cs_…` (session id in the query, never the raw key or token). Only hashes are stored. Env canary `dql-canary` is unchanged (env wins; credits do not apply). The account token is **not** a verify key: `X-DQL-Key` still rejects `dqla_…`. The same token **does** authorize `POST /dql/verify` via `X-DQL-Account` / `Authorization: Bearer dqla_…`, billing the bound hash ledger, without returning `dqlk_…`.

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
# Pack prices — create one-time Prices in Dashboard; do not commit price_… ids.
# export DQL_STRIPE_PRICE_STARTER=price_…   # $8 / 200 credits
# export DQL_STRIPE_PRICE_PLUS=price_…      # $35 / 1000 credits
# Optional metered PAYG price (subscription mode). Without it, pack=payg is setup-mode.
# export DQL_STRIPE_PRICE_ID=price_…
DQL_CASCADE=stub npx vercel dev --listen 3002

curl -s -X POST http://localhost:3002/dql/checkout \
  -H 'content-type: application/json' \
  -d '{"email":"you@example.com","pack":"starter"}'
# → { "url": "https://checkout.stripe.com/…", "session_id": "cs_…", "pack": "starter", "no_freemium": true }
# Complete Checkout, then:
curl -s 'http://localhost:3002/dql/checkout?session_id=cs_…'
# → { "api_key": "dqlk_…", "account_token": "dqla_…", "key_prefix": "dqlk_…xxxx",
#     "credits": 200, "pack": "starter", "trial": false, "payg_opt_in": false, "shown_once": true }
# once only (first mint). Replay → 409 KEY_ALREADY_DELIVERED (no key, no token).
```

**Success / cancel URLs:** if `DQL_PUBLIC_APP_URL` is set (example `https://app.thoughtproof.ai`), Stripe `success_url` is `{app}/keys?session_id={CHECKOUT_SESSION_ID}` and cancel is `{app}/pricing?canceled=1` (unless `DQL_CHECKOUT_CANCEL_URL` overrides). If unset, keep the DQL reveal URL `{publicBase}/dql/checkout?session_id=…` (fail-safe). Do not hardcode the App origin as the only path.

### Post-purchase account API (code; flag OFF)

Identity after checkout is the account token, not the raw `dqlk_…`. No Clerk. No freemium signup. Auth: `X-DQL-Account: dqla_…` or `Authorization: Bearer dqla_…`. Invalid/missing → **401**.

| Method | Path | Returns |
|---|---|---|
| `GET` | `/dql/account` | `{ key_prefix, credits, trial, payg_opt_in, usage_today, daily_cap, email_masked, revoked }` — enough for Balance/Usage. No full key. |
| `POST` | `/dql/account/portal` | `{ url }` Stripe Customer Billing Portal (history + payment method). **Fail closed** (`503 PORTAL_UNAVAILABLE`) if Customer Portal is not activated in the Stripe Dashboard. |
| `POST` | `/dql/account/rotate` | New `dqlk_…` once. Old hash revoked. Credits / PAYG / customer / account token preserved. |
| `POST` | `/dql/account/revoke` | Key dead. Credits unused. |

Verify (`X-DQL-Key: dqlk_…`) is unchanged. An account token presented as `X-DQL-Key` is rejected. `POST /dql/verify` also accepts `X-DQL-Account: dqla_…` / `Authorization: Bearer dqla_…`. Account path: atomic **reserve** (bound to key hash + idempotency id + payload digest) → execute once → **commit** stored result (or **release** on CONFIG_INVALID / throw / PAYG meter failure). In-flight retry → **409** `IDEMPOTENCY_IN_PROGRESS`. Cross-account reuse → **403** `IDEMPOTENCY_KEY_BOUND`. Payload mismatch → **409** `IDEMPOTENCY_PAYLOAD_MISMATCH`. `committed` replay returns the stored result. Stale `held` (lease 15 min; record kept 7 days) is refunded on recover/sweep. PAYG meter off/fail → **503** `METER_UNAVAILABLE`, no stored free replay. Invalid/missing account token → **401**. Zero credits / over cap fail closed **before** the engine. Rotate/revoke still stops verify. Response body stays the native verify contract (no raw key).

This API lets the App be a thin post-purchase home. Shipping the routes is **not** a self-serve product launch and does **not** flip `DQL_CHECKOUT_ENABLED`.

`pack` is required (`trial` | `starter` | `plus` | `payg`). Missing/unknown → `400 INVALID_REQUEST`. A pack whose Stripe price env is unset → `503 CHECKOUT_UNAVAILABLE` (fail closed). Flag off → `503 CHECKOUT_DISABLED`.

Stripe Dashboard webhook (prod): endpoint `https://dql.thoughtproof.ai/dql/webhooks/stripe`, event `checkout.session.completed`, signing secret → `STRIPE_WEBHOOK_SECRET`. Shared ThoughtProof Stripe account: only sessions with `metadata.dql_checkout=1` are fulfilled; other events are ignored.

**Prod flip (Raul):** set `DQL_CHECKOUT_ENABLED=true` only after **all** of: `STRIPE_WEBHOOK_SECRET`, Upstash, prepaid ledger deployed, trial email∪fingerprint guards deployed, **and** both `DQL_STRIPE_PRICE_STARTER` + `DQL_STRIPE_PRICE_PLUS` exist as one-time Prices in the Stripe Dashboard. Redeploy. Smoke: pack Checkout → reveal once → N prepaid verifies decrement → N+1 `402 CREDITS_EXHAUSTED`; PAYG opt-in meters; trial is 5 checks then hard-stop. Until that smoke, keep **`SELF_SERVE_LIVE=partial`**. Do not claim live packs from a merge.

### Prepaid packs, PAYG opt-in, trial (code; flag OFF)

Same `dqlk_…` key. Daily-cap (`dql:usage:…`) still applies. Sandbox stays free/keyless. x402 path untouched.

| `pack` | Stripe Checkout | Grant | After 0 credits |
|---|---|---|---|
| `starter` | `mode=payment` · `DQL_STRIPE_PRICE_STARTER` | 200 prepaid credits ($8) | hard-stop unless `payg_opt_in` |
| `plus` | `mode=payment` · `DQL_STRIPE_PRICE_PLUS` | 1000 prepaid credits ($35) | hard-stop unless `payg_opt_in` |
| `payg` | `mode=subscription` if `DQL_STRIPE_PRICE_ID`, else `setup` | no credits; sets `payg_opt_in` | existing Stripe meter @ $0.05 / live verify |
| `trial` | `mode=setup` (card bind, $0) | 5 checks, `trial=true` on the ledger | hard-stop unless `payg_opt_in` |

Credit amounts live in `src/auth/packs.ts` (not Stripe metadata as the source of truth). Balance is `dql:credits:<sha256>`; grant history is `dql:credit-ledger:<sha256>` so trial grants (`trial=true`) are distinct from paid pack grants. Never a second live key for the same Stripe customer — a later pack **adds credits** to the existing key.

**Verify (`POST /dql/verify`, non-sandbox, store key):**
1. Daily-cap (existing `429 QUOTA_EXCEEDED`).
2. If credit balance > 0 → decrement 1 atomically, allow, **do not** Stripe-meter (`X-DQL-Billing: credit`).
3. If balance 0 and `payg_opt_in` → existing Stripe meter path.
4. If balance 0 and not PAYG → `402 CREDITS_EXHAUSTED` (hard-stop; never silently allow).

**Trial rules (not a plan):** card + email required. Once per `email_normalized` ∪ Stripe `card_fingerprint` (reuse of either burns it → `409 TRIAL_ALREADY_USED`). No card fingerprint after setup → `402 TRIAL_REQUIRES_CARD`, no credits. Consumer copy: trial / first 5 checks. `no_freemium=true`.

Webhook HMAC still required. No plaintext keys in logs.

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

**Honest claims:** crypto pay-per-call (x402) and fiat meter emit (Stripe canary) work in Production. Daily-cap brake is live. Checkout **code** can mint a persisted key, grant prepaid credits, gate a 5-check trial, reveal an account session once, and serve `/dql/account` (balance, portal, rotate, revoke), but the public flag is **OFF** and pack price env vars are unset in Production — not a live self-serve or live-pack claim. Merge ≠ flag-on ≠ “self-serve product”. `no_freemium=true`. Invite/dev keys still free (manual). Env canary `dql-canary` → `cus_V4abfGkmWdyxyC` is unchanged.
