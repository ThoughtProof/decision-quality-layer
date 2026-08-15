# DQL — Now / Next / Not (replaces old v0.2 HANDOVER)

> **Language note:** This is a German one-page status doc (per the OpenClaw `DRAFTS/2026-08-04-dql-now-next-not.md` it replaces). Deep doc is in `docs/`. This file is the **current** single source of truth; prefer it over the old 2026-07-08 v0.2 HANDOVER.

**Stand:** 2026-08-14 CEST (PR #36 P2 rails code merged flag-off; #26 closed earlier)
**Live-Check:** `GET https://dql.thoughtproof.ai/dql/health` → `200 ok` · `commit_sha=9f3c1b4…` · cascade `pot-cli`
**Zweck:** Ein-Seiten-Lagebild. Kein Train-Go. Kein Launch-Claim. **`SELF_SERVE_LIVE=partial`** (x402 only).

---

## NOW (was wirklich live ist)

| Feld | Wert |
|---|---|
| Endpoint | `https://dql.thoughtproof.ai` |
| Health | `status=ok` · cascade `pot-cli` · SERV key bound |
| Runtime schema | `0.4.3.2-deadline-1` · `v0431_active=true` |
| Deploy commit | **`9f3c1b4`** — PR #36 P2 self-serve rails **code** merged · Health-SHA == main-SHA |
| npm/package label | `0.2.0` **artifact only** (locked P0 #3) — cite `config_schema_version` for behavior |
| Auth | Key-gate: non-sandbox braucht `X-DQL-Key`; `sandbox: true` free |
| Payment rails | **x402 ON** · **Stripe meter ON** (canary) · **Upstash daily-cap ON** · Checkout **code** flag-off |
| Self-serve | **`SELF_SERVE_LIVE=partial`** — rails live; public Checkout mint **OFF** (`DQL_CHECKOUT_ENABLED`) |
| Flags | `capital_path_mode` / CB / alias_gate / diagnostics — see live health JSON |
| Cascade | `serv-nano` → `serv-swift` (OpenServ) |
| Product lane | **Consumer Trust** (mandate vs geplante Aktion) — **nicht** Sentinel/PLV Banking |
| Surfaces | API live · Extension DQL-path (dogfood) · Guardian PWA demo `200` (`guardian-pwa.vercel.app`) |
| Proof artifacts | ADSB S4 claims mit Denominator · Blog decision-quality · Paris BLOCK receipt (Dmitry) |
| Objection integrity | P1 surface-bind live (28.07) — verdicts unverändert, objections/reasoning gebunden |

### Git-Stand nach PR #36 (2026-08-14)

| | |
|---|---|
| **`origin/main`** | **`9f3c1b4`** — merge PR #36 P2 self-serve rails flag-off · CI **grün** |
| **Prod deploy** | **`9f3c1b4`** — live via Health verifiziert (`dql.thoughtproof.ai`) · Vercel target=production |
| **P2 payment code** | ✅ deployed |
| **x402 Production** | ✅ **ON** · canary Tx [`0x70f93e79…8b70bf`](https://basescan.org/tx/0x70f93e79533d3c8caf7a7b5ee6ae2a218992bf97e45f095bcf797b534c8b70bf) · $0.05 |
| **Preview x402 E2E** | Tx [`0x2fc1c4a4…22ed6`](https://basescan.org/tx/0x2fc1c4a46e4219ac5bda23c907a3930d23ec08e9d1f2dbefcea0de7130f22ed6) · pre-merge proof |
| DNS | `try.thoughtproof.ai` **NXDOMAIN** · `guardian.thoughtproof.ai` **NXDOMAIN** |
| `HANDOVER.md` | dieses Dokument |

**Regel:** Health-JSON + Deploy-SHA schlagen README.

**Ops:** Mehr REVIEW nach #25 = Fix bei der Arbeit (Secondary-Failure ehrlich), kein neuer Bug.  
**Gate lexicon:** `fail_open` ≡ aggregate **ALLOW** only; REVIEW/BLOCK = safe-closed (see #26). Block→REVIEW ≠ fail-open.

---

## NEXT (priorisiert, klein)

Nur was den Drift schließt oder Demo/Revenue freimacht — **kein** Feature-Fest.

### P0 — Repo/Prod Hygiene
1. ✅ **Prod-Linie nach `main` bringen + Prod-Redeploy** — **DONE 2026-08-04** (PR #22, then superseded by later main).
2. ✅ **HANDOVER 1-pager ersetzen** — **dieses Dokument** (P0 #2; PR #23).
3. ✅ **Versionssemantik (P0 #3)** — **DONE 2026-08-05:** keep package `0.2.0` (artifact); `config_schema_version` = runtime. One-sentence rule in `docs/ENV.md`; `PACKAGE_VERSION` single source from `package.json` (health/verify); CI hermetic test asserts health==package and axes stay distinct.
4. ✅ **Cascade-Provenienz-Regression** — **DONE 2026-08-05** ([Issue #24](https://github.com/ThoughtProof/decision-quality-layer/issues/24) / [PR #25](https://github.com/ThoughtProof/decision-quality-layer/pull/25) → main/`e2e62179`). Verdict preservation decoupled from truthful `provider_outcome`; auth constant-time + key fingerprint logs. Preview spike ≈ prod; interim engine-merge gate documented on PR.
5. ✅ **P0 #5 / Issue #26 CLOSED (option 3 · 2026-08-05)** — fail_open 0 + safe_closed floors; consistency #31 + risk lockin #33; dual axis-hit forever (#29); rev useful-ok only stable STEP 1c (`subtle-rev-01`); `rev-06` → risk with `expected_v1=reversibility`. Close doc: `docs/issues/ISSUE26_CLOSE.md`. Follow-ups: rev-01/02 drift ops only — **not** % chase.



### P1 — Product-usable Demo (ohne Launch-Theater)
6. **Ein stabiler Demo-URL** (DNS *oder* klarer Canonical): Option A `app.thoughtproof.ai` / `guardian.thoughtproof.ai` → PWA · Option B bewusst nur `guardian-pwa.vercel.app`
7. **try.thoughtproof.ai** — Playground stub **oder** Redirect — kein toter Name in Pitches
8. **Smoke-card:** 2 feste Cases (ALLOW travel-ok · BLOCK budget-breach) mit Receipt-IDs

### P2 — Gate code complete (Self-Serve still OFF)
9. ✅ Stripe meter — **Production ON** (canary `dql-canary` → `cus_V4abfGkmWdyxyC`).
10. ✅ x402 Base rail — **Production ON** (2026-08-14). CDP keys + flag live; challenge + $0.05 canary PASS.
11. ✅ Upstash daily-cap multi-instance — **ON** (2026-08-15). Redis key = sha256(apiKey).
11b. 🔲 Public Checkout mint — **code** (`POST /dql/checkout` + signed webhook + one-time key+`dqla_…` reveal + `/dql/account`). **Flag OFF.** Do not claim `SELF_SERVE_LIVE=true` or a live self-serve product until `DQL_CHECKOUT_ENABLED` + smoke.

### P3 — Reliability debt (nur wenn capital/high-SLA)
12. Circuit-breaker **Recovery-Blindspot** fixen (beide OPEN → HALF_OPEN Probe mit *realer* Achsen-Last)
13. Saubere **swift-primary recert** 100×N *nach* Recovery
14. `alias_gate_ready=true` erst nach nachgewiesenem healthy-alias fraction Verhalten

### Owned-verifiers Kopplung (nicht DQL-Roadmap, aber Reihenfolge)
- Method order bleibt: **DQL validate → Sentinel economic shadow → authority last**
- **KEEP_RUN1 · Authority 0 · no train without explicit go**

---

## NOT (bewusst nein / geparkt)

| Item | Warum |
|---|---|
| DQL = Banking/PLV/Sentinel rebrand | Andere Lane; vermischen killt Positionierung |
| Option E Aggregation „härter“ auf v041d | Engpass war Achse/Curation, nicht Agg; Recall-Risiko |
| capitalPathMode=false + CB on in Prod „weil Code da“ | Recert nie clean grün; Recovery-Blindspot live gesehen |
| Freemium / monthly free tier | PAYMENT.md: low-frequency consumer → nie pay |
| BYOK tier | Surface-Komplexität ohne Segment-Gewinn |
| Product Hunt / PWA-as-Launch | Demo-only; rate-limit, no self-serve loop |
| BrowseSafe als DQL-Bench | ADR-0008 permanent reject |
| try.thoughtproof.ai als „Launch live“ claimen | DNS tot (Stand Check) |
| Railway/alt-host als „schneller als Vercel“ | PoC negativ (22.07) |
| AgentDojo/WebArena diese Woche | Post-stable external legitimation only |
| Owned-verifier Training / Authority>0 | Explizites Go fehlt; STOP gilt |
| GCP Credits als DQL-Blocker | Unrelated; Credits geparkt |

---

## 3 Moves (wenn nur 3)

1. **Ein Demo-Hostname** der auflöst (DNS oder Docs bereinigen)
2. **Smoke-card** 2 feste Cases mit Receipt-IDs (ALLOW/BLOCK)
3. **Monetarisierung nur mit eigenem Go:** Stripe first (controlled), then x402 prod canary — keep `SELF_SERVE_LIVE=false` until then

---

## Claim-Guard (Copy)

**OK:** live DQL · 5 axes · nano→swift cascade · key-gated · sandbox free · x402 Base pay-per-call **on** · consumer mandate check · objection-bound surface · main=prod `9f3c1b4`/`2fd421d`

**Nicht OK ohne Denominator/SHA:** „100% accurate“, „prevents bad actions“, „capital-path CB proven in prod“, „try.thoughtproof.ai live“, package `0.2.0` als Feature-Stand, **„full self-serve live“**, „Stripe billing on“

---

## Quellen (Check 2026-08-14, abends)

- Live: `dql.thoughtproof.ai/dql/health` → `commit_sha: 9f3c1b4…`, schema `0.4.3.2-deadline-1` (PR #36 flag-off prod deploy verifiziert)
- Git: main=`9f3c1b4` ([PR #36](https://github.com/ThoughtProof/decision-quality-layer/pull/36) gemergt 2026-08-14)
- Payment docs: `docs/PAYMENT.md` · `SELF_SERVE_LIVE=false`
- Preview x402 E2E proof: Basescan `0x2fc1c4a46e4219ac5bda23c907a3930d23ec08e9d1f2dbefcea0de7130f22ed6`
- DNS fail: `try.thoughtproof.ai`, `guardian.thoughtproof.ai`
- PWA: `guardian-pwa.vercel.app` / `app.thoughtproof.ai` as applicable
- Memory: Jul Kalibrierungsbogen · 28.07 objection-bind · PAYMENT.md Phase-2
- ADSB/Blog: controlled autonomy / decision quality framing

**Owner:** Raul product calls · Paul/Hermes exec only on explicit go for merge/DNS/Stripe.
