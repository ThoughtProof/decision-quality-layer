# Environment variables — DQL API

This is the complete list of environment variables the DQL API reads. The
default configuration (no variables set) runs the **StubCascade** and needs
no secrets — safe for local development and CI.

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
| `DQL_API_KEYS` | **yes in prod** for live calls | JSON object of API keys. Empty / unset → every non-sandbox call returns **402 PAYMENT_REQUIRED** (fail-closed). Format: `{"dqlk_<hex>":{"owner":"name","dev_access":true,"daily_cap":500}}`. `dev_access:true` → free (manual grant). `dev_access:false` → billable (Stripe/x402 meter rails TBD; usage line already emitted). |
| `UPSTASH_REDIS_REST_URL` | optional | Daily-cap brake + usage counter. Absent → cap enforcement disabled (key validation still active). |
| `UPSTASH_REDIS_REST_TOKEN` | optional | Pair with URL above. |

Header: `X-DQL-Key: dqlk_...` (primary, CORS-allowed) or `Authorization: Bearer dqlk_...`.

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
