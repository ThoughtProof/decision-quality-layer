# Environment variables — DQL API

This is the complete list of environment variables the DQL API reads. The
default configuration (no variables set) runs the **StubCascade** and needs
no secrets — safe for local development and CI.

## Version semantics (P0 #3)

**One-sentence rule:** `version` is the **package/artifact** version
(`package.json` / npm label); `config_schema_version` is the **runtime
behavior/schema** version (`CONFIG_SCHEMA_VERSION` in
`src/engine/production-config.ts`). Never cite `version` for feature or
behavior claims; never cite `config_schema_version` as the package version.

| Field (e.g. `/dql/health`) | Meaning | Current example |
|----------------------------|---------|-----------------|
| `version` | npm/package **artifact** | `0.2.0` (locked; not a feature level) |
| `config_schema_version` | runtime **behavior/schema** | `0.4.3.2-deadline-1` |
| `X-DQL-Version` header | same as `version` (artifact) | `0.2.0` |

Single source of truth for the artifact number: `package.json` →
`src/package-version.ts` (`PACKAGE_VERSION`). Health/verify/structural-metrics
import that constant. CI hermetic test asserts
`PACKAGE_VERSION === package.json.version` and that the two axes stay distinct.

## Cascade selection

| Variable       | Values                                | Default | Effect |
|----------------|---------------------------------------|---------|--------|
| `DQL_CASCADE`  | `stub` \| `pot-cli` \| `live`         | `stub`  | Selects which cascade runs for non-sandbox requests. `stub` emits UNCERTAIN for every axis and is what the free repo clone uses. `pot-cli` / `live` (aliases) wire the real two-stage cascade — see below. |

Sandbox requests (`{ "sandbox": true }` in the body) always use the
`SandboxCascade` regardless of `DQL_CASCADE` — sandbox is designed to be
deterministic for developer integration testing.

## PotCliCascade (live)

The production cascade is `serv-nano → serv-swift`, mapped to concrete
provider models in `src/engine/llm-client.ts:DEFAULT_MODEL_MAP`. It
uses distinct SERV models of different capability tiers for the two-stage
validation approach.

| Alias         | Provider (default) | Model                       | Env var         |
|---------------|--------------------|-----------------------------|-----------------| 
| `serv-nano`   | SERV (openserv.ai) | `serv-nano`                 | `SERV_API_KEY`  |
| `serv-swift`  | SERV (openserv.ai) | `serv-swift`                | `SERV_API_KEY`  |

The key is required when `DQL_CASCADE=pot-cli`. The client makes plain
OpenAI-compatible `POST /v1/chat/completions` calls to `inference-api.openserv.ai/v1` with
`response_format: json_object`; no additional SDK setup is needed.

If a secondary call fails at runtime the cascade enters **degraded mode**:
- Primary `PASS` → downgraded to `UNCERTAIN`.
- Primary `FAIL` → kept as `FAIL`.
- Primary `UNCERTAIN` → stays `UNCERTAIN`.

## Deployment (Vercel)

Set these in the Vercel dashboard for `dql.thoughtproof.ai`:

```
DQL_CASCADE=pot-cli
SERV_API_KEY=serv_...
DQL_API_KEYS={"dqlk_...":{"owner":"raul","dev_access":true,"daily_cap":500}}
```

## Auth / billing gate (Phase 2 key layer)

Enforced on every non-sandbox `POST /dql/verify` (see `docs/PAYMENT.md`).

| Variable | Required | Effect |
|----------|----------|--------|
| `DQL_API_KEYS` | **yes in prod** for bootstrap keys | JSON object of API keys (canary / guardian-pwa / manual `dev_access`). Auth is **env ∪ Upstash store** — self-serve minted keys do **not** need to be pasted here. Empty env + empty store → every non-sandbox call returns **402 PAYMENT_REQUIRED**. Format: `{"dqlk_<hex>":{"owner":"name","dev_access":true,"daily_cap":500}}`. `dev_access:true` → free (manual grant). `dev_access:false` → billable. |
| `UPSTASH_REDIS_REST_URL` | prod (caps + store) | Daily-cap brake (`dql:usage:…`) **and** persisted self-serve key records (`dql:key:<sha256>`). Absent → cap disabled; store-minted keys cannot be validated (env keys still work). |
| `UPSTASH_REDIS_REST_TOKEN` | pair with URL | Pair with URL above. |

### Stripe meter (P2 Rail A — default OFF)

| Variable | Required | Effect |
|----------|----------|--------|
| `DQL_STRIPE_METER_ENABLED` | no | `true`/`1`/`on` to emit Stripe Billing Meter Events. Default off. |
| `STRIPE_SECRET_KEY` | with flag | Stripe secret (`sk_live_…` / `sk_test_…`). Without it the flag is ignored. |
| `STRIPE_METER_EVENT_NAME` | no | Default `dql_verify_call`. Must match the meter created in Stripe Dashboard. |
| `DQL_STRIPE_CUSTOMER_MAP` | bootstrap | JSON `{"owner":"cus_…"}` mapping key `owner` → Stripe customer id (canary). Minted keys resolve `owner → cus_…` from the Upstash store too. Missing both → skip emit (no charge attempt). |

Billable keys only (`dev_access: false`). Idempotency key = DQL `request_id`. Meter emit is **awaited** with a hard timeout before the response is finalized. Failures are logged, never fail the verify response.

**Pricing note:** the API meter event sends `value=1` (one call unit). The **$0.05 USD** price must be configured on the Stripe Meter / Price object in the Dashboard — not in the event payload.

### Public Checkout (self-serve mint + packs — default OFF)

Merge does **not** turn on public billing and does **not** make packs live. `POST /dql/checkout` returns `503 CHECKOUT_DISABLED` until the flag is on. Do not set `DQL_CHECKOUT_ENABLED` until the prepaid ledger, trial guards, **and** both pack Prices exist in the Stripe Dashboard.

`POST` body: `{ "email": "…", "pack": "trial"|"starter"|"plus"|"payg" }`. Missing/unknown `pack` → `400 INVALID_REQUEST`.

| Variable | Required | Effect |
|----------|----------|--------|
| `DQL_CHECKOUT_ENABLED` | no | `true`/`1`/`on` to create Checkout Sessions. **Default off.** |
| `STRIPE_SECRET_KEY` | with flag | Same secret as the meter rail. |
| `STRIPE_WEBHOOK_SECRET` | webhook | `whsec_…` from Stripe Dashboard or `stripe listen`. Unsigned webhooks are rejected. |
| `DQL_STRIPE_PRICE_STARTER` | for `pack=starter` | One-time Dashboard Price ($8 / 200 credits). Missing → that pack's POST is `503 CHECKOUT_UNAVAILABLE`. Do not hardcode `price_…` ids. |
| `DQL_STRIPE_PRICE_PLUS` | for `pack=plus` | One-time Dashboard Price ($35 / 1000 credits). Missing → `503 CHECKOUT_UNAVAILABLE`. |
| `DQL_STRIPE_PRICE_ID` | for `pack=payg` subscription | Existing metered PAYG price. When set, `pack=payg` is `mode=subscription`. When unset, `pack=payg` is `mode=setup` (card on file). Does not grant credits. |
| `DQL_PUBLIC_BASE_URL` | no | DQL origin used when the App URL is unset. Default `https://$VERCEL_URL` or `https://dql.thoughtproof.ai`. |
| `DQL_PUBLIC_APP_URL` | no | Optional App origin (example `https://app.thoughtproof.ai`). When set, Stripe `success_url` = `{app}/keys?session_id={CHECKOUT_SESSION_ID}` and cancel = `{app}/pricing?canceled=1`. When **unset**, keep the DQL reveal URL (fail-safe). Do not hardcode the App URL as the only path. |
| `DQL_CHECKOUT_CANCEL_URL` | no | Optional cancel-URL override. Default `{app}/pricing?canceled=1` when App URL is set, else `{publicBase}/`. |
| `DQL_BILLING_PORTAL_RETURN_URL` | no | Return URL for `POST /dql/account/portal`. Default `{app}/keys` when App URL is set, else `{publicBase}/`. |
| `DQL_STRIPE_PORTAL_CONFIGURATION` | no | Optional Stripe Customer Portal Configuration id (`bpc_…`). If unset, Stripe uses the Dashboard default. Portal create **fails closed** (`503 PORTAL_UNAVAILABLE`) when Customer Portal is not activated. |

Credit amounts (5 / 200 / 1000) are defined in `src/auth/packs.ts`, not in Stripe metadata. Ledger keys: `dql:credits:<sha256>` (balance), `dql:credit-ledger:<sha256>` (grants, including `trial=true`), `dql:trial-email:<sha256(email)>`, `dql:trial-fp:<fingerprint>`, `dql:account:<sha256(dqla_…)>` (account session → live key hash). Daily-cap stays on `dql:usage:…`.

Self-serve keys are always `dev_access: false`. PAYG is **opt-in** (`payg_opt_in` on the key). Zero credits + no PAYG → `402 CREDITS_EXHAUSTED`. Trial is the first 5 checks, once per email ∪ card fingerprint, card required — not a plan. `no_freemium=true`. Plaintext key and account token are never logged; only hashes are persisted. The one-time reveal slot (15 min) holds both until `GET /dql/checkout?session_id=` consumes it. Success URL uses `session_id`, not the raw key.

Post-purchase account routes (`GET /dql/account`, `POST /dql/account/portal|rotate|revoke`) authenticate with `X-DQL-Account: dqla_…` or `Authorization: Bearer dqla_…`. They do **not** turn on Checkout. The account token is not accepted as `X-DQL-Key`.

`POST /dql/verify` also accepts that same account header: `X-DQL-Account: dqla_…` or `Authorization: Bearer dqla_…`. Admission **reserves** prepaid credit (or confirmed PAYG) and daily-cap **before** the engine runs; success **commits**, CONFIG_INVALID / thrown verify **releases** so balance and cap are unchanged. The verify response never includes the raw `dqlk_…`. Invalid/missing token → **401**. Exhausted credits → existing **402** (engine is not invoked). `dqla_…` pasted as `X-DQL-Key` is still rejected. This is an app-credential path for bots/MCP clients — not a self-serve product claim and it does not flip `DQL_CHECKOUT_ENABLED`.

See `docs/PAYMENT.md` § Checkout / webhook, § Post-purchase account API, and § Prepaid packs. Do not claim `SELF_SERVE_LIVE=true` and do not claim a live self-serve product until the flag is on and smoked.

Header: `X-DQL-Key: dqlk_...` (verify) or `X-DQL-Account: dqla_...` (account **and** verify). Alias for either: `Authorization: Bearer` (prefix selects the path: `dqlk_` vs `dqla_`).

### x402 (P2 Rail B — default OFF)

| Variable | Required | Effect |
|----------|----------|--------|
| `DQL_X402_ENABLED` | no | `true` to accept Base USDC x402 when no API key. Default off. |
| `PAYMENT_WALLET` | no | Default shared wallet `0xAB9f…82E83` (same as Sentinel). |
| `X402_CDP_KEY_ID` / `X402_CDP_KEY_SECRET` | for CDP facilitator | Coinbase CDP credentials (required unless explicit facilitator URL). |
| `X402_FACILITATOR_URL` | no | Explicit facilitator base URL. **Required** if CDP keys absent. No silent public fallback. |

When enabled **and ready** (CDP keys or explicit facilitator URL) and no key/signature: `402` + `payment-required` header + JSON challenge (Base dual `eip155:8453` + `base`).

When enabled but **not ready** (flag on, no CDP, no facilitator URL): `503 PAYMENT_UNAVAILABLE` — **no challenge**, no `payment-required` header.

Payment sequence: validate → verify authorization → DQL → settle → respond. Settlement timeouts return `PAYMENT_STATUS_UNKNOWN` (do not claim "not charged").

Header: `X-DQL-Key: dqlk_...` (primary, CORS-allowed) or `Authorization: Bearer dqlk_...`. Account token: `X-DQL-Account: dqla_...` (CORS-allowed) or `Authorization: Bearer dqla_...`.

Sandbox (`{"sandbox":true}`) stays free and keyless.

**Deploy order:** set `DQL_API_KEYS` on Vercel **before** shipping the gate-enabled code, then update clients (extension, guardian-pwa, live drills) with real keys. Shipping the gate with an empty registry locks out all live traffic.

## Local development

Simplest reproducible dev setup — sandbox only, no keys required:

```bash
DQL_CASCADE=stub npx vercel dev
# then POST with {"sandbox": true, ...}
```

For non-sandbox local calls:

```bash
export DQL_API_KEYS='{"dqlk_dev":{"owner":"local","dev_access":true,"daily_cap":1000}}'
DQL_CASCADE=stub npx vercel dev
# header: X-DQL-Key: dqlk_dev
```

To exercise the real cascade locally, also drop `SERV_API_KEY` into
`.env.local` and set `DQL_CASCADE=pot-cli`. `.env.local` is gitignored by
the default Vercel template.

## Auditing what a call used

Every response's `meta.models_used` array reports the concrete backends
that answered — e.g. `["serv:serv-nano", "serv:serv-swift"]`
when the cascade ran both stages, or `["serv:serv-nano"]` when the
primary early-exited on a high-confidence FAIL. This is the fastest way
to confirm the env is wired correctly against a live deployment.
