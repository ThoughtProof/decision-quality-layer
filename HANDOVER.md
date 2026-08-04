# DQL — Now / Next / Not (replaces old v0.2 HANDOVER)

> **Language note:** This is a German one-page status doc (per the OpenClaw `DRAFTS/2026-08-04-dql-now-next-not.md` it replaces). Deep doc is in `docs/`. This file is the **current** single source of truth; prefer it over the old 2026-07-08 v0.2 HANDOVER.

**Stand:** 2026-08-04 CEST (aktualisiert nach P0 #1)
**Live-Check:** `GET https://dql.thoughtproof.ai/dql/health` → `200 ok`
**Zweck:** Ein-Seiten-Lagebild. Kein Train-Go. Kein Launch-Claim.

---

## NOW (was wirklich live ist)

| Feld | Wert |
|---|---|
| Endpoint | `https://dql.thoughtproof.ai` |
| Health | `status=ok` · cascade `pot-cli` · SERV key bound |
| Runtime schema | `0.4.3.2-deadline-1` · `v0431_active=true` |
| Deploy commit | `4238bf2` — objection evidence bind (axis surface) — Prod-Bereitstellung **unverändert** |
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
| **`origin/main`** | **`face93d`** — squash `feat(dql): enforce API-key gate on non-sandbox /dql/verify (#22)` · CI **grün** (typecheck, test, build, Vercel) |
| **Prod deploy** | weiterhin `4238bf2` (Code-Linie = die nach main gemergte; **Redeploy von main für einen kanonischen SHA ist der verbleibende Schritt**) |
| DNS | `try.thoughtproof.ai` **NXDOMAIN** · `guardian.thoughtproof.ai` **NXDOMAIN** |
| `HANDOVER.md` | ersetzt durch *dieses* Dok. |
| `docs/ROADMAP.md` | **fehlt** im Tree |

**Regel:** Health-JSON + Deploy-SHA schlagen README.

---

## NEXT (priorisiert, klein)

Nur was den Drift schließt oder Demo/Revenue freimacht — **kein** Feature-Fest.

### P0 — Repo/Prod Hygiene
1. ✅ **Prod-Linie nach `main` bringen** — **DONE 2026-08-04** (PR #22, main=`face93d`, CI grün). Offen: Prod-Redeploy von `main`, damit Health-SHA == main-SHA.
2. ✅ **HANDOVER 1-pager ersetzen** — **dieses Dokument** (P0 #2).
3. **Versionssemantik:** entweder package auf `0.4.3.2` heben oder public copy nur `config_schema_version` nennen.

### P1 — Product-usable Demo (ohne Launch-Theater)
4. **Ein stabiler Demo-URL** (DNS *oder* klarer Canonical): Option A `app.thoughtproof.ai` / `guardian.thoughtproof.ai` → PWA · Option B bewusst nur `guardian-pwa.vercel.app`
5. **try.thoughtproof.ai** — Playground stub **oder** Redirect — kein toter Name in Pitches
6. **Smoke-card:** 2 feste Cases (ALLOW travel-ok · BLOCK budget-breach) mit Receipt-IDs

### P2 — Gate vollständig (wenn Self-Serve gewollt)
7. Stripe meter `dql_verify_call` @ **$0.05** (PAYMENT.md) — Raul-Hold erst bei Bedarf heben
8. x402-Rail port von Sentinel (gleiche Wallet) — optional parallel
9. Upstash/global rate-limit multi-instance verifizieren

### P3 — Reliability debt (nur wenn capital/high-SLA)
10. Circuit-breaker **Recovery-Blindspot** fixen (beide OPEN → HALF_OPEN Probe mit *realer* Achsen-Last)
11. Saubere **swift-primary recert** 100×N *nach* Recovery
12. `alias_gate_ready=true` erst nach nachgewiesenem healthy-alias fraction Verhalten

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

1. **Main = Prod** — main=`face93d` (DONE); Prod-Redeploy von main für kanonischen SHA
2. **Ein Demo-Hostname** der auflöst (DNS oder Docs bereinigen)
3. **Stripe an oder hard „invite-only key“** als ehrliche Public-Story — kein Halb-Gate

---

## Claim-Guard (Copy)

**OK:** live DQL · 5 axes · nano→swift cascade · key-gated · sandbox free · consumer mandate check · objection-bound surface

**Nicht OK ohne Denominator/SHA:** „100% accurate“, „prevents bad actions“, „capital-path CB proven in prod“, „try.thoughtproof.ai live“, package `0.2.0` als Feature-Stand

---

## Quellen (Check 2026-08-04)

- Live: `dql.thoughtproof.ai/dql/health` → commit `4238bf2…`, schema `0.4.3.2-deadline-1`
- Git: main=`face93d` (PR #22 gemergt 2026-08-04, CI success run `30945813537`); Prod-Depoly unverändert `4238bf2`
- DNS fail: `try.thoughtproof.ai`, `guardian.thoughtproof.ai`
- PWA: `guardian-pwa.vercel.app` → 200
- Memory: Jul Kalibrierungsbogen · 28.07 objection-bind · PAYMENT.md Phase-2
- ADSB/Blog: controlled autonomy / decision quality framing

**Owner:** Raul product calls · Paul/Hermes exec only on explicit go for merge/DNS/Stripe.
