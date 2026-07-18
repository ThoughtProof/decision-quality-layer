# Briefing für Perplexity — Swift in DQL: Befund, Sentinel-Vergleich, Optionen

**Date:** 2026-07-18  
**From:** Hermes (Integrator)  
**To:** Perplexity (Computer / Cert-Track)  
**Status:** Evidence-based handoff. Keine Prod-Änderung in diesem Briefing.  
**Related:**  
- `docs/swift-output-contract-report-2026-07-18.md` (OpenServ Schema-Frage)  
- Cert-Stopp: Swift-Rezertifizierung gestoppt (Truncation auf `reversibility`)  
- Gültige Entscheidungen bleiben: Nano Primary · kein Swift-Vollzug · kein Merge `378b4ec` · keine blinden Token-Erhöhungen  

---

## 1. Worum es geht (1 Absatz)

DQL und Sentinel nutzen beide **serv-nano → serv-swift** auf OpenServ. Die Swift-Rezertifizierung für DQL ist gestoppt, weil `serv-swift` auf der Achse `reversibility` wiederholt **abgeschnittenes JSON** liefert (reproduzierbar bei 512 / 1024 / 2048 Completion-Tokens). Parse-Guard fail-closed → keine unsichere Entscheidung zertifiziert. Gleichzeitig wirkt Sentinel „stabil“. Dieses Briefing erklärt den Unterschied und die Optionen **nur für DQL**.

---

## 2. Harte Befunde (DQL)

### 2.1 Cascade-Mechanik (Code: `src/engine/cascade-pot.ts`)

| Nano-Verdict | Verhalten |
|---|---|
| FAIL @ conf ≥ 0.7 | **Early-Exit** — Swift wird nicht gerufen |
| PASS | Swift wird gerufen (Bestätigung) |
| UNCERTAIN | Swift wird gerufen |

Wenn Swift ausfällt (Parse-Truncate, Circuit Breaker, Provider-Fehler):

- Nano PASS → **UNCERTAIN** (degradiert)
- Nano FAIL bleibt FAIL
- Nano UNCERTAIN bleibt UNCERTAIN  
→ Aggregat typisch **REVIEW**, **nie** ALLOW durch Swift-Ausfall.

**Korrekte Lesart:** Nano entscheidet harte BLOCKs oft allein. Erlaubnisse und Unsicherheit brauchen Swift — ohne Swift wird es Unsicherheit/REVIEW, nicht „Nano allein ALLOW“.

### 2.2 Output-Contract & Budget (Code-Belege)

- DQL Default: **`maxTokens: 512`** (`cascade-pot.ts` DEFAULT_CONFIG)
- Pro Achse strenges JSON: `{ verdict, confidence, reasoning, objection }`
- Parser (`parseAxisResponse`): lenient extract (fence / first `{…}`), bei kaputt → **UNCERTAIN@0** + Raw in objection
- Cert-Befund: Truncation auf **`reversibility`**, nicht „Modell antwortet nie“

### 2.3 OpenServ: kein erzwungenes Schema belegbar

Report: `docs/swift-output-contract-report-2026-07-18.md` (`c68a58d`)

- Offizielle Doku listet **kein** `response_format` / `json_schema` / strict structured output auf `/v1/chat/completions`, `/v1/responses`, `/v1/messages`
- Einziger dokumentierter Struktur-Hebel: **`tools` + erzwungenes `tool_choice`**
- Marketing „schema-forced execution“ = SERV Reasoning/BRAID-Orchestrierung, **kein** Chat-Completions-Parameter
- **Selbst Grammar würde Truncation nicht lösen** (Form ≠ Token-Anzahl)

### 2.4 Zusätzlicher Betriebs-Befund (heute, Suite v1 / Item 4)

- `serv-swift` p90 Circuit Breaker: p90 ≥ ~15s → `circuit_rejected` → generisches Label „provider/auth failure“
- Ops: Pause ≥20s zwischen Calls, ≥30s Cool-down nach Infra (ADSB-Runner angepasst)
- B-003 war **kein** Payload-Bug, sondern CB unter Last; im Cool-Window: judgment-backed REVIEW

### 2.5 Was Swift bisher als Secondary *nicht* beweist

- Alte Baselines erfassten Parsefehler nicht transparent genug
- Early-Exit kann Swift-Aufrufe vermeiden (FAIL-Pfad)
- „Secondary funktionierte“ ≠ zertifizierte Robustheit unter adversarial Primary-Last

---

## 3. Sentinel-Vergleich (Repo: `thoughtproof-sentinel` + `pot-cli`)

**Dieselben Modelle, andere Pipeline.**

| Dimension | DQL | Sentinel (standard tier) |
|---|---|---|
| Modelle | nano → swift | nano → swift (`tiers.ts`) |
| Aufgabe | 5 parallele Achsen | 1 Plan-Eval + `step_evaluations` |
| Token-Budget | **512 default** | **4096** (`cascade.ts` / `evaluateItem`) |
| Early-Exit | high-conf **FAIL** | primary **BLOCK/HOLD** |
| Wann Swift? | PASS **und** UNCERTAIN | vor allem wenn Nano **ALLOW/COND_ALLOW** will |
| Erfolgsmetrik historisch | Axis-Parse + Suite/Cert | vor allem **0 False ALLOWs** |
| Parse-Fehler historisch | Cert-Stopp sichtbar | Goldstandard z.B. `parse_errors: 38` (nano-run) — „works“ ≠ parse-perfekt |

**Folgerung:** Sentinel maskiert denselben Swift-Schwächepunkt durch **Budget + Contract + Metrik**. Es ist **kein** Beweis, dass Swift unter DQL-Contract zertifizierbar ist.

**Entscheidung Raul/Integrator:** **Sentinel kann so bleiben** (bewährt auf FA=0). Optional später Telemetrie für Truncation/Parse nachziehen — kein Umbau-Blocker.

---

## 4. Optionen für DQL (Swift-Track)

### A — Status quo / interim (**empfohlen jetzt**)

- Nano = Primary  
- Swift = Secondary, fail-closed  
- Kein Swift-Vollzug, kein Primary-Switch, kein Merge `378b4ec`  
- `capitalPathMode=true` bleibt  

**Pro:** Sicherheit hält (kein ALLOW durch Swift-Fail).  
**Contra:** Mehr REVIEW unter Last/CB; Secondary unzuverlässig.

### B — Swift-Secondary gezielt härten (kein blinder Token-Bump)

Nur wenn ihr SERV/Swift behalten wollt:

1. Output-Contract für Achsen **kürzen** (Sentinel-ähnlich: weniger Vorlauf-Prosa, JSON-first)
2. Budget **messen** (z.B. Stufen 1024/2048 mit `finish_reason`/Truncation-Rate) — nicht blind 4096 kopieren und „fixed“ claimen
3. Kleine Rezert unter **DQL-Contract** (nicht Sentinel-Contract)
4. CB-Ops einhalten (Pacing)

**Pro:** Stack bleibt einheitlich mit Sentinel.  
**Contra:** Truncation kann trotz höherem Budget bleiben; Cert-Aufwand; Grammar-Illusion vermeiden.

### C — Secondary ersetzen (**sauberster mittelfristige Weg**)

- Kandidat z.B. `serv-pro` (Sentinel hat hidden Pro-Tier nano→pro) oder externes Modell
- **Derselbe Maßstab:** 100-Case adversarial suite grün **bevor** Prod-Rolle
- Erst danach `capitalPathMode`-Diskussion

**Pro:** Trennt euch von nachgewiesen schwachem Swift-Output unter DQL-Contract.  
**Contra:** Kosten/Latenz/Kalibrierung neu; eigener Workstream.

### D — Swift ganz entfernen

- Nur Nano  

**Jetzt nicht empfohlen:** verliert zweite Meinung auf Nicht-Kapitalpfaden ohne Ersatz. Erst nach C.

---

## 5. Was Perplexity *nicht* tun soll

1. Keinen Swift-Vollzug / keine Primary-Zertifizierung gegen bewegliches Gate  
2. Keinen Merge von `378b4ec`  
3. Keine blinden Token-Erhöhungen als „Fix“  
4. Keine DQL-Parser-/Prompt-/Baseline-Änderung ohne separate Freigabe  
5. Keinen parallelen 100-Case-Hammer ohne Ops-Pacing (kontaminiert CB + Kalibrierungs-Canaries)  
6. Kalibrierungs-Track (Item 3 REVIEW-Mittelspur → Full v0+v1 Re-Run) **nicht** auf Swift-Track warten lassen — **zwei Schienen**

---

## 6. Empfohlene Haltung (Integrator)

| Track | Haltung |
|---|---|
| **Sentinel** | Unverändert lassen |
| **DQL kurzfristig** | **Option A** |
| **DQL mittelfristig** | **B light** *oder* **C** — Entscheidung nach Item-3 + Movement-Report, nicht davor |
| **OpenServ Schema-Probe** | Optional, max. 1 Call nach Freigabe; strategisch nebensächlich (löst Truncation nicht) |

**Ein Satz für Stakeholder:**  
*Swift ist in DQL als fail-closed Secondary sicher, als zuverlässige zweite Meinung und als Primary derzeit nicht tragfähig; Sentinel darf so bleiben, weil anderer Contract und Budget denselben Defekt seltener sichtbar machen; nächster DQL-Schritt entweder gezielte Secondary-Härtung unter Messung oder Secondary-Ersatz mit voller Rezert.*

---

## 7. Belegquellen (lokal)

| Quelle | Inhalt |
|---|---|
| `decision-quality-layer/src/engine/cascade-pot.ts` | Cascade-Regeln, maxTokens 512, degraded secondary |
| `decision-quality-layer/src/engine/cascade.ts` | `parseAxisResponse` / extractJson |
| `decision-quality-layer/src/engine/llm-client.ts` | OpenServ call shape, kein response_format, MODEL_MAP |
| `decision-quality-layer/docs/swift-output-contract-report-2026-07-18.md` | OpenServ Schema-Doku-Audit |
| `thoughtproof-sentinel/src/engine/cascade.ts` | maxTokens 4096, pot-cli cascade |
| `thoughtproof-sentinel/src/tiers.ts` | standard = nano→swift |
| `pot-cli/src/plan/cross-model-cascade.ts` | Sentinel cascade semantics (ALLOW→secondary) |
| `pot-cli/src/utils/model-router.ts` | OpenServ call, parse helpers |
| ADSB calibration report / Item-4 diagnostics | CB p90, B-003 |

---

## 8. Offene Entscheidung an Raul (nicht an Perplexity allein)

Nach Item 3 + Movement-Report:

- **B** (Swift härten) oder **C** (Secondary ersetzen)?  
- Probe-Call OpenServ `response_format` — ja/nein (informativ only)?

*Hermes · 2026-07-18 · Handoff complete — no production change proposed in this document.*
