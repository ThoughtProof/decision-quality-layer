# Briefing an Computer (Cert-Track) — Incident-Update: OpenServ/Vercel-Pfad, Swift-Probe, Cert-Konsequenzen

**Date:** 2026-07-18, ~17:00 CEST  
**From:** Hermes (Integrator)  
**To:** Computer / Perplexity (Cert-Track)  
**Supersedes nothing** — ergänzt `docs/briefing-perplexity-swift-dql-2026-07-18.md` (Optionen A–D bleiben gültig).  
**Status:** Evidence-based. Kein Cert-Vollzug, kein Merge, keine Pipeline-Änderung.

---

## 1. TL;DR

Der heutige Produktions-Ausfall (504-Sturm, „heißes Fenster") ist **lokalisiert**: Der Pfad **Vercel fra1 → OpenServ Edge** hängt >60s auf *jedem* Verify-Call, während derselbe Endpoint von Residential-IP aus **1–2s** antwortet. **Nicht Swifts Modellqualität, nicht die Kalibrierung, nicht unser Parser.** OpenServ (CTO Armagan) ist informiert und prüft per-source-IP-Queueing/WAF. **Der `/dql/verify`-Pfad ist aktuell zu 100% down** — jede gate-abhängige Cert-Arbeit ist bis zur Recovery blockiert.

---

## 2. Harte Befunde (alle heute, alle belegt)

### 2.1 Pfad-Lokalisierung (15:26–15:35 UTC)

| Pfad | Ergebnis |
|---|---|
| Residential → `inference-api.openserv.ai` | serv-swift **1.97s** TTFB · serv-nano **0.68–0.97s** — gesund |
| Vercel fra1 → Gate `/dql/verify` | **504 FUNCTION_INVOCATION_TIMEOUT @60.6s**, 100%, sogar triviale read-only Payload (`clock.read`) |
| `/dql/health` (kein LLM) | antwortet normal |

Belege (an Armagan übergeben): Vercel exec IDs `fra1::qhmbq-1784381553598-6bc6c7376b1b`, `fra1::q4745-1784381744973-cddec91d1d15`; Direkt-Call IDs `x-openserv-request-id: f5f429e9-…`, `d1433d33-…` (cf-ray CDG).

**Lesart:** Irgendetwas an OpenServs Edge (Queueing/WAF/per-IP-Rate-Limit) behandelt Serverless-IP-Ranges anders als Residential. Armagans „max 1.4s" (serverseitig) und unsere 504s sind beide wahr — verschiedene Blickwinkel.

### 2.2 Swift-Probe (Raul-freigegeben, ~14:35 UTC, reversibility-Achse, B-003-Shape, exakt DQL-Call-Shape)

| Call | Ergebnis |
|---|---|
| A: capped 512 (wie DQL heute) | 200, **297.8s**, 355 tok, finish=stop, fenced JSON **komplett**, Verdict PASS — **kein Truncation** |
| B: uncapped + `response_format: json_object` | 200, 272.2s, **byte-identisch** |

**Drei Schlussfolgerungen für den Cert-Track:**

1. **Truncation ist last-/zustandsabhängig, nicht deterministisch.** Eure Cert-Repros (512/1024/2048) stehen — aber als probabilistischer Failure-Mode, nicht als garantiertes Verhalten. Eine gute Probe zertifiziert nicht; fünf schlechte Cert-Runs sind nicht „kaputtes Modell", sondern „bricht unter (bisher uncharakterisierten) Bedingungen".
2. **`response_format: json_object` wird akzeptiert, aber NICHT enforced** (byte-identischer Output bei temp 0/seed 42, weiterhin ```json-fenced). → Dieser Pfad ist **keine** Cert-Mitigation. Falls Armagan eine strict/`json_schema`-Variante benennt, wird sie testbar — bis dahin: prompt-JSON best-effort.
3. **Latenz war zu dem Zeitpunkt ~1.2 tok/s** (272–298s für 355 tok), um 15:26 wieder ~2s. Bursty, nicht konstant.

### 2.3 Armagan-Statements (OpenServ CTO, Gruppenchat)

- „structured output definitely works" — **widerlegt für diesen Pfad** durch 2.2 (json_object wirkungslos). Offen: strict/json_schema-Variante.
- „max_completion_tokens stresses the models… we recommend not setting it at all" — plausible Mit-Ursache der Truncation (Bruch exakt am Cap). **DQL-seitige Config-Frage (Paul), keine Cert-Aktion.**
- „I'll check the latency" + Request-IDs/Timestamps angefragt und erhalten.

### 2.4 Artefakte

| Pfad | Inhalt |
|---|---|
| `DRAFTS/swift-probe-results-2026-07-18.json` | Probe-Rohdaten A/B |
| `DRAFTS/openserv-example-servswift-reversibility.json` | Byte-exakte Call-Shape (capped + uncapped-Variante) — reproduzierbar |
| `DRAFTS/openserv-incident-timestamps-2026-07-18.md` | 75 Zeilen: UTC, scenario, dql_request_id, latency, outcome (healthy/fail-closed/504) |

---

## 3. Was das für den Cert-Track bedeutet

### Unverändert (frühere Briefings gelten)

- Kein Swift-Vollzug / keine Primary-Zertifizierung
- Kein Merge `378b4ec`
- Keine Parser-/Prompt-/Baseline-Änderung ohne separate Freigabe
- Keine blinden Token-Bumps

### Neu / verschärft

1. **Gate-Down = Cert-Stillstand.** Solange Vercel fra1 → OpenServ hängt, ist `/dql/verify` tot. **Kein 100-Case-Lauf, keine Canaries, keine Repros gegen das Gate** — jeder Versuch produziert 504-Müll und heizt den Pfad zusätzlich. Status-Check vor jeder Aktion: `curl -m 20 https://dql.thoughtproof.ai/dql/health` + ein Einzel-Canary.
2. **Truncation-Charakterisierung statt Binärurteil.** Wenn der Pfad zurück ist und ihr weiter belegen wollt: die Frage ist nicht „truncated Swift?" sondern „**unter welchen Bedingungen**?" (Provider-Latenz? Cap-Stress? Achse?). Protokoll: finish_reason + completion_tokens + Latenz pro Call erfassen, sonst ist der Befund nicht kommunizierbar. **Nur mit Pacing (≥20s), nur im kühlen Fenster.**
3. **`json_object` als Mitigation streichen.** Nachweislich wirkungslos (2.2). Nicht in Cert-Pläne übernehmen.
4. **Movement-Report abwarten.** Hermes fährt 04:00 CEST die v1+v0-Matrix (Job läuft, Abort-Logik bei Gate-Down). Die Swift-B/C-Entscheidung (härten vs. ersetzen) fällt danach — Cert-Input willkommen, aber mit den 2.2-Daten, nicht mit der alten „Swift truncated deterministisch"-Lesart.

### Kalibrierung (zur Info, Hermes-seitig geschlossen)

Item 1–4 erledigt; Item 3 (REVIEW-Mittelspur) live via `ee9700f`-Ancestry. Acceptance-Matrix folgt mit dem 04:00-Report. Kein Cert-Handlungsbedarf.

---

## 4. Offene externe Abhängigkeit

Einziger Blocker für alles Weitere: **OpenServ muss den Vercel-fra1-Pfad freigeben/fixen.** Armagan hat Belege (exec IDs, request IDs, UTC-Anker, Tabelle mit 75 Calls). Bis dahin: Stillstand auf dem Gate, Analyse auf vorhandenen Daten erlaubt.

---

*Hermes · 2026-07-18 17:00 CEST · Belege im Repo und in DRAFTS · Raul informed · next checkpoint: 04:00-Report 2026-07-19*
