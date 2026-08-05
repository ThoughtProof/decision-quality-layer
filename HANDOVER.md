# DQL — Now / Next / Not (replaces old v0.2 HANDOVER)

> **Language note:** This is a German one-page status doc (per the OpenClaw `DRAFTS/2026-08-04-dql-now-next-not.md` it replaces). Deep doc is in `docs/`. This file is the **current** single source of truth; prefer it over the old 2026-07-08 v0.2 HANDOVER.

**Stand:** 2026-08-05 CEST (PR #28 hybrid gate live; #26 partial — risk matops + fail_open metrics)
**Live-Check:** `GET https://dql.thoughtproof.ai/dql/health` → `200 ok` · `commit_sha=f9b33990…`
**Zweck:** Ein-Seiten-Lagebild. Kein Train-Go. Kein Launch-Claim.

---

## NOW (was wirklich live ist)

| Feld | Wert |
|---|---|
| Endpoint | `https://dql.thoughtproof.ai` |
| Health | `status=ok` · cascade `pot-cli` · SERV key bound |
| Runtime schema | `0.4.3.2-deadline-1` · `v0431_active=true` |
| Deploy commit | **`f9b33990`** — PR #28 (#26 hybrid: risk material-ops recall + spike fail_open/safe_closed gate) · Health-SHA == main-SHA |
| npm/package label | noch `0.2.0` (Label ≠ Runtime — nicht als Product-Version zitieren) |
| Auth | Key-gate: non-sandbox braucht `X-DQL-Key`; `sandbox: true` free |
| Flags | `capital_path_mode=true` · `disable_circuit_breaker=true` · `alias_gate_ready=false` · diagnostics on |
| Cascade | `serv-nano` → `serv-swift` (OpenServ) |
| Product lane | **Consumer Trust** (mandate vs geplante Aktion) — **nicht** Sentinel/PLV Banking |
| Surfaces | API live · Extension DQL-path (dogfood) · Guardian PWA demo `200` (`guardian-pwa.vercel.app`) |
| Proof artifacts | ADSB S4 claims mit Denominator · Blog decision-quality · Paris BLOCK receipt (Dmitry) |
| Objection integrity | P1 surface-bind live (28.07) — verdicts unverändert, objections/reasoning gebunden |

### Git-Stand nach PR #25 (2026-08-05)

| | |
|---|---|
| **`origin/main`** | **`e2e62179`** — merge `fix(cascade): decouple… (#25)` · CI **grün** |
| **Prod deploy** | **`e2e62179`** — live via Health verifiziert (`dql.thoughtproof.ai`) |
| **Provenance track** | ✅ closed — Secondary-Outage → ehrliches REVIEW (nicht silent ALLOW); reopens #13/#14 closed via #24/#25 |
| DNS | `try.thoughtproof.ai` **NXDOMAIN** · `guardian.thoughtproof.ai` **NXDOMAIN** |
| `HANDOVER.md` | dieses Dokument |

**Regel:** Health-JSON + Deploy-SHA schlagen README.

**Ops:** Mehr REVIEW nach #25 = Fix bei der Arbeit (Secondary-Failure ehrlich), kein neuer Bug.

---

## NEXT (priorisiert, klein)

Nur was den Drift schließt oder Demo/Revenue freimacht — **kein** Feature-Fest.

### P0 — Repo/Prod Hygiene
1. ✅ **Prod-Linie nach `main` bringen + Prod-Redeploy** — **DONE 2026-08-04** (PR #22, then superseded by later main).
2. ✅ **HANDOVER 1-pager ersetzen** — **dieses Dokument** (P0 #2; PR #23).
3. **Versionssemantik:** entweder package auf `0.4.3.2` heben oder public copy nur `config_schema_version` nennen.
4. ✅ **Cascade-Provenienz-Regression** — **DONE 2026-08-05** ([Issue #24](https://github.com/ThoughtProof/decision-quality-layer/issues/24) / [PR #25](https://github.com/ThoughtProof/decision-quality-layer/pull/25) → main/`e2e62179`). Verdict preservation decoupled from truthful `provider_outcome`; auth constant-time + key fingerprint logs. Preview spike ≈ prod; interim engine-merge gate documented on PR.
5. **P0 #5: Prod spike-80 recovery ≥90%** — [Issue #26](https://github.com/ThoughtProof/decision-quality-layer/issues/26). **Partial 2026-08-05:** [PR #28](https://github.com/ThoughtProof/decision-quality-layer/pull/28) shipped risk INFRA material-ops prose + hybrid gate (`fail_open=0` hard, `safe_closed≥95%` over misses; axis-hit soft). Preview DoD: fail_open **0**, safe_closed **100%**, rev-06 **REVIEW**, hybrid **PASSED** (axis-hit still ~69% soft). Open: drive axis-hit toward ≥90% vs July; UNCERTAIN@0.95 cluster; optional provenance fields in spike report. Interim relative gate still time-boxed to this issue.

### P1 — Product-usable Demo (ohne Launch-Theater)
6. **Ein stabiler Demo-URL** (DNS *oder* klarer Canonical): Option A `app.thoughtproof.ai` / `guardian.thoughtproof.ai` → PWA · Option B bewusst nur `guardian-pwa.vercel.app`
7. **try.thoughtproof.ai** — Playground stub **oder** Redirect — kein toter Name in Pitches
8. **Smoke-card:** 2 feste Cases (ALLOW travel-ok · BLOCK budget-breach) mit Receipt-IDs

### P2 — Gate vollständig (wenn Self-Serve gewollt)
9. Stripe meter `dql_verify_call` @ **$0.05** (PAYMENT.md) — Raul-Hold erst bei Bedarf heben
10. x402-Rail port von Sentinel (gleiche Wallet) — optional parallel
11. Upstash/global rate-limit multi-instance verifizieren

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
