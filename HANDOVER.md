# DQL — Now / Next / Not (replaces old v0.2 HANDOVER)

> **Language note:** This is a German one-page status doc (per the OpenClaw `DRAFTS/2026-08-04-dql-now-next-not.md` it replaces). Deep doc is in `docs/`. This file is the **current** single source of truth; prefer it over the old 2026-07-08 v0.2 HANDOVER.

**Stand:** 2026-08-04 CEST (aktualisiert nach P0 #1 Redeploy + Issue #24)
**Live-Check:** `GET https://dql.thoughtproof.ai/dql/health` → `200 ok` · `commit_sha=face93d7…`
**Zweck:** Ein-Seiten-Lagebild. Kein Train-Go. Kein Launch-Claim.

---

## NOW (was wirklich live ist)

| Feld | Wert |
|---|---|
| Endpoint | `https://dql.thoughtproof.ai` |
| Health | `status=ok` · cascade `pot-cli` · SERV key bound |
| Runtime schema | `0.4.3.2-deadline-1` · `v0431_active=true` |
| Deploy commit | **`face93d7`** — P0 #1 merge (API-key gate + prod line) · Health-SHA == main-SHA |
| npm/package label | noch `0.2.0` (Label ≠ Runtime — nicht als Product-Version zitieren) |
| Auth | Key-gate: non-sandbox braucht `X-DQL-Key`; `sandbox: true` free |
| Flags | `capital_path_mode=true` · `disable_circuit_breaker=true` · `alias_gate_ready=false` · diagnostics on |
| Cascade | `serv-nano` → `serv-swift` (OpenServ) |
| Product lane | **Consumer Trust** (mandate vs geplante Aktion) — **nicht** Sentinel/PLV Banking |
| Surfaces | API live · Extension DQL-path (dogfood) · Guardian PWA demo `200` (`guardian-pwa.vercel.app`) |
| Proof artifacts | ADSB S4 claims mit Denominator · Blog decision-quality · Paris BLOCK receipt (Dmitry) |
| Objection integrity | P1 surface-bind live (28.07) — verdicts unverändert, objections/reasoning gebunden |

### Git-Stand nach P0 #1 (2026-08-04)

| | |
|---|---|
| **`origin/main`** | **`face93d7`** — squash `feat(dql): enforce API-key gate on non-sandbox /dql/verify (#22)` · CI **grün** (typecheck, test, build, Vercel) |
| **Prod deploy** | **`face93d7`** — live via Health verifiziert (Redeploy erledigt; kanonischer SHA) |
| DNS | `try.thoughtproof.ai` **NXDOMAIN** · `guardian.thoughtproof.ai` **NXDOMAIN** |
| `HANDOVER.md` | ersetzt durch *dieses* Dok. |
| `docs/ROADMAP.md` | **fehlt** im Tree |

**Regel:** Health-JSON + Deploy-SHA schlagen README.

---

## NEXT (priorisiert, klein)

Nur was den Drift schließt oder Demo/Revenue freimacht — **kein** Feature-Fest.

### P0 — Repo/Prod Hygiene
1. ✅ **Prod-Linie nach `main` bringen + Prod-Redeploy** — **DONE 2026-08-04** (PR #22, main=`face93d7`, CI grün, Health=`face93d7`).
2. ✅ **HANDOVER 1-pager ersetzen** — **dieses Dokument** (P0 #2; PR #23).
3. **Versionssemantik:** entweder package auf `0.4.3.2` heben oder public copy nur `config_schema_version` nennen.
4. **P0 #4: Cascade-Provenienz-Regression fixen — [Issue #24](https://github.com/ThoughtProof/decision-quality-layer/issues/24)** — Secondary-Catch erzwingt `provider_outcome:"served"` auch bei echten `ProviderCallError`/`CircuitAllOpenError` → Aggregation Rule 2 tot → fail-open ALLOW (reopens #13/#14). Fix: primary **Verdict** behalten, Provenienz via `classifySecondaryFailure()`; Deadline-Skip bleibt as-served. Plus low-sev auth: constant-time key compare (`keys.ts:128`), API-Key nicht im Klartext in `emitUsageLine` (`usage.ts:82`).

### P1 — Product-usable Demo (ohne Launch-Theater)
5. **Ein stabiler Demo-URL** (DNS *oder* klarer Canonical): Option A `app.thoughtproof.ai` / `guardian.thoughtproof.ai` → PWA · Option B bewusst nur `guardian-pwa.vercel.app`
6. **try.thoughtproof.ai** — Playground stub **oder** Redirect — kein toter Name in Pitches
7. **Smoke-card:** 2 feste Cases (ALLOW travel-ok · BLOCK budget-breach) mit Receipt-IDs

### P2 — Gate vollständig (wenn Self-Serve gewollt)
8. Stripe meter `dql_verify_call` @ **$0.05** (PAYMENT.md) — Raul-Hold erst bei Bedarf heben
9. x402-Rail port von Sentinel (gleiche Wallet) — optional parallel
10. Upstash/global rate-limit multi-instance verifizieren

### P3 — Reliability debt (nur wenn capital/high-SLA)
11. Circuit-breaker **Recovery-Blindspot** fixen (beide OPEN → HALF_OPEN Probe mit *realer* Achsen-Last)
12. Saubere **swift-primary recert** 100×N *nach* Recovery
13. `alias_gate_ready=true` erst nach nachgewiesenem healthy-alias fraction Verhalten

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

1. **Cascade-Provenienz (#24)** — secondary error: Verdict behalten, `provider_error`/`circuit_rejected` setzen (fail-closed)
2. **Ein Demo-Hostname** der auflöst (DNS oder Docs bereinigen)
3. **Stripe an oder hard „invite-only key“** als ehrliche Public-Story — kein Halb-Gate

---

## Claim-Guard (Copy)

**OK:** live DQL · 5 axes · nano→swift cascade · key-gated · sandbox free · consumer mandate check · objection-bound surface · main=prod `face93d7`

**Nicht OK ohne Denominator/SHA:** „100% accurate“, „prevents bad actions“, „capital-path CB proven in prod“, „try.thoughtproof.ai live“, package `0.2.0` als Feature-Stand

---

## Quellen (Check 2026-08-04, abends)

- Live: `dql.thoughtproof.ai/dql/health` → `commit_sha: face93d7affb3f56a13459075a53c466c0c4f08a`, schema `0.4.3.2-deadline-1` (Prod-Redeploy verifiziert)
- Git: main=`face93d7` (PR #22 gemergt 2026-08-04, CI success run `30945813537` auf main; branch tip CI `30945662873`)
- Cascade-Provenienz-Regression: [Issue #24](https://github.com/ThoughtProof/decision-quality-layer/issues/24) (reopens #13/#14 composition gap)
- DNS fail: `try.thoughtproof.ai`, `guardian.thoughtproof.ai`
- PWA: `guardian-pwa.vercel.app` → 200
- Memory: Jul Kalibrierungsbogen · 28.07 objection-bind · PAYMENT.md Phase-2
- ADSB/Blog: controlled autonomy / decision quality framing

**Owner:** Raul product calls · Paul/Hermes exec only on explicit go for merge/DNS/Stripe.
