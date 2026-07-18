# Implementierungs-Briefing: Provider-Deadline für DQL auf Vercel Hobby

**Adressat:** Paul
**Datum:** 2026-07-18
**Autor:** Computer (read-only Analyse; keine Quell-Änderung, kein Provider-Call, kein Deploy/Push/PR)
**Codebasis-Stand:** origin/main HEAD `34bba10` (Code-Inspektion), Incident-Kontext aus Commit `92bdff8` (`docs/briefing-computer-incident-update-2026-07-18.md`)

**Kennzeichnung durchgängig:** `[VERIFIED]` = im aktuellen Code/Plattform belegt · `[RECOMMENDED]` = Vorschlag mit Begründung · `[OPEN]` = benötigt Entscheidung/Freigabe vor Umsetzung.

---

## 0. Kernaussage (zuerst lesen)

**Ein pauschaler 45–50-s-Deadline *pro Provider-Call* ist NICHT sicher.** Innerhalb einer Achse laufen Primär- und Sekundär-Call **sequenziell**; zwei Calls à 45–50 s ergeben 90–100 s und überschreiten die 60-s-Vercel-Grenze garantiert. Mit dem heutigen In-Client-Retry (bis 6 Versuche, Backoff-Cap 90 s) ist selbst ein *einzelner* Call im Worst Case ≈ 387 s — konsistent mit der in Stage-1 gemessenen Max-Latenz von 392 s.

**Empfehlung [RECOMMENDED]:** 45 s **nur** als **Gesamt-Request-Deadline** (Whole-Request-Budget) verwenden und alles andere darunter schichten:

| Budget-Ebene | Wert | Rolle |
|---|---|---|
| Whole-Request (W) | **45 s** | absolute Obergrenze, geteilter AbortController für den gesamten `runVerification`-Lauf |
| Per-Provider-Call (PC) | **18 s** | Budget für *einen* Alias-Call inkl. seiner Retries |
| Per-Attempt (T) | **15 s** | Timeout eines einzelnen HTTP-Versuchs (deckt sich mit CB `tripP90LatencyMs=15000`) |
| maxAttempts | **2** | statt heute 6 |
| backoffBaseMs / backoffCapMs | **500 / 1500** | statt heute 800 / 90000 |
| Reserve | **≈ 12 s** | Cold-Start, Serialisierung, Fail-Closed-Aggregation, Diagnostics-Flush |

Rechnung pro Achse: Primär (≤18 s) + Sekundär (≤18 s) = 36 s ≤ 45 s W; Achsen laufen parallel, daher bestimmt die langsamste Achse die Wandzeit. 45 − 36 = 9 s + Reserve puffern Cold-Start und Abschluss.

**Kontrakt bleibt 200 + REVIEW** (wahrheitsgemäß, keine Aggregations-Änderung). Deadline-Abbruch wird als `provider_error` klassifiziert und eskaliert über die bestehende Aggregations-Regel 2 zu REVIEW.

**Blocker:** Non-certifying Canary erst **nach** Wiederherstellung des OpenServ-Pfads (Incident 15:26–15:35 UTC). `AbortSignal.any`-Verfügbarkeit auf Vercels Node-Runtime bestätigen `[OPEN]`.

---

## 1. Problemstellung und verifizierte Plattform-Beschränkung

### 1.1 Symptom
Unter Provider-Störung (siehe Incident-Briefing `92bdff8`) hängen Calls über die Vercel-fra1→OpenServ-Kante. Die DQL-Funktion läuft dann bis zur Plattformgrenze und wird von Vercel mit **504 FUNCTION_INVOCATION_TIMEOUT ohne Body** beendet — der Client erhält *keine* strukturierte DQL-Antwort, keine Diagnostics, keine REVIEW-Eskalation.

### 1.2 Verifizierte Beschränkung `[VERIFIED]`
- `vercel.json`: `"functions": { "api/dql/**/*.ts": { "maxDuration": 60 } }` → **60 s Funktionsdeckel**.
- Vercel Hobby erlaubt maximal 60 s pro Serverless-Function-Invocation; bei Überschreitung 504 ohne Body.
- **Der aktuelle Code hat KEINEN Request-Deadline.** `src/engine/production-runtime.ts` (`baseClientOptions`) setzt nur `capitalPathMode`, `circuitBreakerConfigByAlias`, `disableCircuitBreaker`, `requireDiagnostics` — **nicht** `timeoutMs`/`maxAttempts`/`backoff*`. Daher gelten in Produktion die `DEFAULT_CONFIG`-Werte aus `src/engine/llm-client.ts`:
  ```ts
  const DEFAULT_CONFIG = { timeoutMs: 60_000, maxAttempts: 6, backoffBaseMs: 800, backoffCapMs: 90_000 };
  ```
- Per-Attempt-Timeout = 60 s = Funktionsdeckel: Ein einziger hängender Versuch verbraucht bereits das gesamte Plattformbudget, bevor irgendein Retry/Fallback greift.

### 1.3 Worst-Case-Rechnung (heutiger Stand) `[VERIFIED]`
Single Call mit 6 Versuchen à 60 s Timeout + Backoff (800 ms·2^(n−1), Cap 90 s, +Jitter):
Versuche 6×60 s = 360 s; Backoff-Summe ≈ 0,8+1,6+3,2+6,4+12,8 ≈ 24,8 s → **≈ 385–387 s**. Deckt sich mit Stage-1-Max 392 s.
Pro Achse (Primär+Sekundär sequenziell) ≈ 2× → **≈ 774 s**. Achsen parallel, aber jede einzelne Achse kann bereits den 60-s-Deckel weit überschreiten.

---

## 2. Explizite Nicht-Ziele `[VERIFIED-Scope]`

Dieses Vorhaben ändert **ausschließlich** Zeit-/Deadline-/Retry-Verhalten und die dafür nötige Telemetrie. **Ausdrücklich NICHT geändert werden:**
- **Prompts / System-/User-Templates** — keine inhaltliche Änderung.
- **Parser / Ausgabe-Contract** der Modellantwort (JSON-Schema, Feldnamen).
- **Aggregation / Entscheidungslogik** (`src/aggregation.ts` Regeln 1–6 bleiben unverändert; wir nutzen Regel 2 nur *wie vorhanden*).
- **Kalibrierung / Schwellwerte** (z. B. FAIL@≥0.7 Early-Exit).
- **Modelle / Aliase** (serv-nano Primär, serv-swift Sekundär bleiben).
- **Dekodierparameter** (temperature 0, seed 42, `max_completion_tokens`, `response_format`).

Die einzige Berührung der Antwort-Verarbeitung ist **additiv**: `finish_reason` und `completion_tokens` werden zusätzlich ausgelesen (heute verworfen), ohne den Parse-Pfad des Contents zu verändern.

---

## 3. Vorgeschlagener Deadline-Wert und Abgrenzung der Budget-Ebenen

### 3.1 Warum 45 s als Whole-Request und nicht 45–50 s pro Call `[RECOMMENDED]`
- 50 s Whole-Request lässt bei 60 s Deckel nur 10 s Reserve — zu knapp für Cold-Start (`[OPEN]`, siehe 9) + Aggregation + Diagnostics-Flush (8 KB Header). 45 s gibt 15 s Reserve.
- Zwei sequenzielle Calls (Primär→Sekundär) müssen **beide** in W passen. Mit PC=18 s: 36 s Achsen-Wandzeit, 9 s Puffer innerhalb W, plus die 15 s W↔60 s-Reserve.
- T=15 s deckt sich mit dem Circuit-Breaker `tripP90LatencyMs=15000` — ein Versuch, der langsamer ist als die CB-Latenzschwelle, wird ohnehin als ungesund betrachtet; ihn nach 15 s abzubrechen ist konsistent.

### 3.2 Vier klar getrennte Budgets `[RECOMMENDED]`

1. **Per-Attempt-Timeout (T = 15 s):** gilt für *einen* HTTP-`fetch`-Versuch. Realisiert wie heute per `AbortController` + `setTimeout`, aber zusätzlich mit `min(T, verbleibendes PC, verbleibendes W)` geklammert.
2. **Per-Provider-Call-Budget (PC = 18 s):** deckt *alle* Retries eines Alias-Calls. Vor jedem Versuch und vor jedem Backoff-Sleep prüfen, ob PC-Restzeit ausreicht; sonst nicht-retrybarer Abbruch.
3. **Whole-Request-Deadline (W = 45 s):** eine gemeinsame absolute Frist (`Date.now() + 45000`) plus geteilter `AbortSignal` für den gesamten `runVerification`-Lauf. Jeder Attempt-Signal wird via `AbortSignal.any([attemptSignal, requestSignal])` mit dem Request-Signal kombiniert.
4. **Per-Axis-Reservierung (abgeleitet, kein fester Wert):** Innerhalb `cascade-pot.ts` muss vor dem Sekundär-Call geprüft werden, dass genug W-Restzeit für einen vollständigen Sekundär-Call + Fail-Closed-Antwort bleibt (siehe §6). Kein separater konfigurierter Wert, sondern dynamisch aus W-Restzeit.

**Wichtig:** T, PC und W sind ineinander verschachtelt; der effektive Attempt-Timeout ist stets das Minimum aller drei Restbudgets. Dadurch kann keine Ebene die nächsthöhere sprengen.

---

## 4. Exakte Architektur- und Code-Touchpoints (auf Basis von origin/main `34bba10`)

### 4.1 `src/engine/production-config.ts` `[RECOMMENDED]`
- Neue, validierte und gehashte Felder ergänzen: `providerCallBudgetMs` (18000), `attemptTimeoutMs` (15000), `requestDeadlineMs` (45000), `maxAttempts` (2), `backoffBaseMs` (500), `backoffCapMs` (1500).
- In den Config-Hash/Provenance einbeziehen, damit die Deadline-Parameter im Manifest nachweisbar sind.
- Feature-Flag `deadlineEnforcementEnabled` (Default **false** = heutiges Verhalten).

### 4.2 `src/engine/production-runtime.ts` — `baseClientOptions` `[RECOMMENDED]` (Haupt-Verdrahtung)
- Aus der Config `timeoutMs=attemptTimeoutMs`, `maxAttempts`, `backoffBaseMs`, `backoffCapMs` an den `HttpLlmClient` durchreichen.
- `ClientOptionsOverride` (heute nur Test) exponiert diese Felder bereits — der Produktionspfad muss sie lediglich befüllen. **Das ist der zentrale Fix**: ohne diese Zeile bleiben die 60 s/6-Versuche-Defaults aktiv.

### 4.3 `src/engine/call-context.ts` `[RECOMMENDED]`
- `CallContext` additiv erweitern um `deadlineAt?: number` (epoch ms) und `requestSignal?: AbortSignal`.
- Rückwärtskompatibel: bestehende Felder (`requestId`, `axis?`, `callId?`, `collector?`) unverändert.

### 4.4 `src/engine/index.ts` — `runVerification` `[RECOMMENDED]`
- Zu Beginn Request-Deadline scharfschalten: `const deadlineAt = Date.now() + config.requestDeadlineMs; const requestController = new AbortController();` + `setTimeout(() => requestController.abort(), requestDeadlineMs)` mit garantiertem `clearTimeout` im `finally`.
- `deadlineAt` und `requestController.signal` über `CallContext` an alle Achsen (`Promise.all`) weiterreichen.
- Bestehende Per-Achsen-`catch`-Logik (CircuitAllOpenError/ProviderCallError → UNCERTAIN@0 + `provider_outcome`) bleibt; `DeadlineExceededError` fällt als `ProviderCallError`-Subtyp automatisch in den `provider_error`-Zweig.

### 4.5 `src/engine/cascade-pot.ts` — `callAxis` / Sekundär-Pfad `[RECOMMENDED]`
- Vor dem Sekundär-Call prüfen: `remainingW = deadlineAt − Date.now()`. Wenn `remainingW < minSecondaryBudget` (≈ PC + Fail-Closed-Reserve), Sekundär **nicht** starten, sondern sofort fail-closed (degraded) mit `timeout_source='request_deadline'`.
- `classifySecondaryFailure(err)` behandelt `DeadlineExceededError` strukturell (kein Message-Parsing).
- Early-Exit bei Primär-FAIL@≥0.7 unverändert.

### 4.6 `src/engine/llm-client.ts` — `singleCall` + `callWithRetry` `[RECOMMENDED]`
- **`singleCall`:** Attempt-`AbortController` wie heute, aber Signal via `AbortSignal.any([controller.signal, ctx.requestSignal])` kombinieren; effektiver Timeout `= min(attemptTimeoutMs, PC_remaining, W_remaining)`. `clearTimeout` im `finally` bleibt (kein Timer-Leak).
- Abbruch-Ursache unterscheiden: Attempt-Timer → `timeout_source='attempt_timeout'`; Request-Signal → `'request_deadline'`; PC-Erschöpfung im Retry-Loop → `'call_budget'`.
- **Additiv:** `finish_reason` und `usage.completion_tokens` aus der Antwort auslesen (heute wird nur `choices?.[0]?.message?.content` gelesen). Response-Typ um `finish_reason?` und `usage?` erweitern — verändert **nicht** den Content-Parse.
- **`callWithRetry`:** vor jedem Versuch und vor jedem Backoff-Sleep `PC_remaining`/`W_remaining` prüfen; reicht die Zeit nicht, Schleife mit `DeadlineExceededError` (nicht-retrybar) verlassen. Backoff zusätzlich auf `min(backoffCapMs, PC_remaining)` klammern. RETRY_TELEMETRY (`Symbol.for('dql.llm.retryTelemetry')`) weiter befüllen.

### 4.7 `api/dql/verify.ts` `[VERIFIED-unverändert]`
- Kontrakt bleibt 200 + `DqlResponse` (REVIEW unter Fail-Closed). Kein neues Timeout-Handling nötig, weil die Deadline *innerhalb* der Funktion vor dem 60-s-Deckel greift und eine reguläre 200+REVIEW-Antwort erzeugt.
- Optionaler 503-Backstop nur für den Whole-Request-Notfall (`[OPEN]`, §7).

---

## 5. AbortController/Signal, Timer-Cleanup, Fehler-Typisierung, Retry, CB-Buchung

### 5.1 Abort/Timer `[RECOMMENDED]`
- Ein Request-`AbortController` (Lebensdauer = `runVerification`), plus je Versuch ein Attempt-`AbortController`.
- Kombination via `AbortSignal.any` — bricht das erste ab, propagiert der Abbruch. `[OPEN]`: `AbortSignal.any` erst ab Node 20.3 stabil; Runtime-Version bestätigen (siehe §9). Fallback: manuelles Verketten via `addEventListener('abort', …)` mit Cleanup.
- **Kein Timer-Leak:** jeder `setTimeout` hat ein passendes `clearTimeout` im `finally`; Event-Listener werden im `finally` entfernt. Dies ist ein explizites Akzeptanzkriterium (§8, Test „no timer leaks“).

### 5.2 Fehler-Typisierung / Kategorie / Provenance `[RECOMMENDED]`
- Neuer Typ **`DeadlineExceededError extends ProviderCallError`**:
  - Gilt für die Aggregation als **`provider_error`** → Regel 2 → **REVIEW** (keine Aggregations-Änderung nötig).
  - **Nicht-retrybar:** wird aus `RETRYABLE_PATTERN` ausgeschlossen, damit der Retry-Loop sofort abbricht (sonst würde „aborted“/„timeout“ im Muster fälschlich einen Retry auslösen).
  - Feld `timeout_source: 'attempt_timeout' | 'call_budget' | 'request_deadline'`.
- Engine klassifiziert weiterhin ausschließlich über den strukturierten **Typ**, nie über Message-Parsing (bestehendes Prinzip).
- `RuntimeDiagnosticsCollector`: `categorizeFailure` mappt Deadline-Abbrüche auf `FailureCategory='timeout'` (Muster deckt bereits `aborted|timeout` ab).

### 5.3 Retry-Eignung `[RECOMMENDED]`
- Transiente Netzfehler (429/ECONN/EAI_AGAIN/socket hang up …) bleiben retrybar — aber nur, solange PC- und W-Budget reichen.
- `DeadlineExceededError` und Budget-Erschöpfung sind **nie** retrybar.

### 5.4 Circuit-Breaker-Buchung `[VERIFIED + OPEN]`
- `[VERIFIED]` CB braucht `minSamples=5` abgeschlossene Samples → er kann bei einem *einzelnen in-flight Hang* nicht auslösen (erklärt `circuit_rejected=0` im Incident). Der Deadline-Mechanismus ist daher **notwendig** und ersetzt den CB nicht.
- CB erfasst Netto-Latenz (Wall − Backoff). Ein per Attempt-Timeout (15 s) abgebrochener Versuch liefert ein sauberes „failed sample“ mit ~15 s Latenz → beschleunigt legitimes CB-Tripping bei anhaltender Störung.
- `[OPEN]` **Entscheidung nötig:** Sollen `request_deadline`-Abbrüche (globale Frist, nicht providerspezifisch) als CB-Failure zählen? Empfehlung: **nein** — sie sind kein providerspezifisches Gesundheitssignal; nur `attempt_timeout`/`call_budget` als Failure buchen. Muss vor Umsetzung bestätigt werden.

---

## 6. Zeitreservierung der Kaskade für Sekundär / Fail-Closed vor 60 s `[RECOMMENDED]`

- In `cascade-pot.ts` vor dem Sekundär-Call: `remainingW = deadlineAt − Date.now()`.
- `minSecondaryBudget = PC (18 s) + failCloseReserve (≈ 3 s)`. Wenn `remainingW < minSecondaryBudget`: Sekundär überspringen, degraded/fail-closed mit `provider_outcome=provider_error`, `timeout_source='request_deadline'`.
- Dadurch bleibt garantiert Zeit, eine reguläre 200+REVIEW-Antwort zu serialisieren und den Diagnostics-Header zu flushen, **bevor** Vercel bei 60 s abbricht.
- Da Achsen parallel laufen, gilt die Reservierung pro Achse gegen dieselbe gemeinsame W-Frist; die langsamste Achse bestimmt, ob der Sekundär noch startet.

---

## 7. HTTP-/API-Verhalten und Status-Entscheidung `[VERIFIED + OPEN]`

- `[VERIFIED]` **Aktueller Kontrakt:** Erfolg = 200 + `DqlResponse`; ein durch Provider-Fehler erzwungenes aggregiertes **REVIEW ist wahrheitsgemäß** (Fail-Closed, keine ALLOW-Behauptung). Fehler-Codes 400/405/413/415/500/503 existieren; **kein** Timeout-Pfad.
- `[RECOMMENDED]` **Beibehalten: 200 + REVIEW** für den Regelfall des Deadline-Abbruchs. Grund: Der Deadline greift *innerhalb* der Funktion und produziert eine vollständige, korrekt aggregierte REVIEW-Antwort inkl. Diagnostics — das ist ehrlicher und maschinenlesbarer als ein leeres 504.
- `[OPEN]` **Optionaler 503 `DEADLINE_EXCEEDED`-Backstop** nur für den Fall, dass selbst die Fail-Closed-Aggregation nicht mehr rechtzeitig fertig wird (harte W-Verletzung). Das wäre eine **Contract-Erweiterung** und braucht Freigabe. Empfehlung: zunächst NICHT einführen; erst messen, ob 200+REVIEW immer erreichbar ist.

---

## 8. Observability-Felder und Akzeptanzkriterien

### 8.1 Neue/erweiterte Telemetrie (keine Payloads, keine Secrets) `[RECOMMENDED]`
Pro Attempt/Call in Diagnostics (X-DQL-Diagnostics, 8 KB-Cap) bzw. JSONL:
- `timeout_source` (`attempt_timeout`|`call_budget`|`request_deadline`|`none`)
- `deadline_ms` (W), `elapsed_ms` (Wall seit Request-Start), `attempt_count`, `backoff_waited_ms`
- `finish_reason`, `completion_tokens` (soweit vom Provider geliefert)
- `provider_route` (Alias), `provider_outcome` (ok|provider_error|circuit_rejected)
Ausdrücklich **ohne** Prompt-/Antwort-Inhalte, API-Keys, Header-Secrets.

### 8.2 Akzeptanzkriterien `[RECOMMENDED]`
1. Kein Lauf überschreitet die Wandzeit W (45 s) + kleine Toleranz; nie den 60-s-Deckel.
2. Bei Provider-Hang liefert die Funktion **200 + REVIEW** (nie leeres 504) im Regelfall.
3. Deadline-Abbruch → `provider_error` → REVIEW (Aggregation unverändert).
4. Keine Retries nach `DeadlineExceededError`.
5. Keine Timer-/Listener-Leaks (verifiziert mit Fake-Timers).
6. `finish_reason`/`completion_tokens` erscheinen in Telemetrie, wenn vom Provider geliefert.
7. Feature-Flag off = bit-identisches heutiges Verhalten.

### 8.3 Diskriminierende Tests (vitest, `fetchImpl`+`sleep`-Injection, Fake-Timers) `[RECOMMENDED]`

| # | Szenario | Injektion | Erwartetes Ergebnis |
|---|---|---|---|
| 1 | Hängender fetch (nie auflösend) | `fetchImpl` = never-resolving | Attempt bricht nach T ab; `timeout_source='attempt_timeout'`; kein Leak |
| 2 | Langsamer Primär (T−ε) | fetch löst knapp unter T | Ein Versuch erfolgreich, kein Timeout |
| 3 | Budget-Erschöpfung vor Sekundär | Primär verbraucht ~W | Sekundär übersprungen; fail-closed; `timeout_source='request_deadline'` |
| 4 | Abort-Race (Antwort + Abort ~gleichzeitig) | fetch löst genau bei Abort | Deterministisch ein Ergebnis; kein doppeltes Settle; kein Leak |
| 5 | Retries/Backoff | erste N transient, dann ok | Retry bis PC; Backoff geklammert auf `min(cap, PC_remaining)` |
| 6 | Circuit-Verhalten | 5 Fehl-Samples | CB trippt; `circuit_rejected`; Deadline nicht als request_deadline gebucht (§5.4) |
| 7 | Keine Timer-Leaks | Fake-Timers, alle Pfade | Nach jedem Pfad 0 offene Timer/Listener |
| 8 | Vercel-artige Wandzeit | Fake-Timers bis 60 s | Antwort < 60 s; 200+REVIEW; Diagnostics geflusht |
| 9 | Flag off Regression | Default-Config | Verhalten == origin/main `34bba10` |

---

## 9. Risiken, Tradeoffs, offene Fragen (Freigabe nötig)

- `[OPEN]` **`AbortSignal.any`-Verfügbarkeit:** kein `engines`-Pin im Projekt; `@types/node ^22`, `@vercel/node ^5.8`. Vor Umsetzung Node ≥ 20.3 auf Vercel bestätigen; sonst manueller Listener-Fallback.
- `[OPEN]` **Cold-Start gegen `maxDuration`:** Zählt Vercel den Cold-Start ins 60-s-Budget? Falls ja, Reserve ggf. auf ≥ 15 s erhöhen (W ggf. auf 42 s).
- `[OPEN]` **CB-Buchung von `request_deadline`-Abbrüchen** (§5.4) — Empfehlung „nicht als Failure buchen“ bestätigen.
- `[OPEN]` **503-Backstop** (§7) — Contract-Entscheidung.
- **Tradeoff maxAttempts 6→2:** weniger Resilienz gegen sporadische 429, aber unverzichtbar für 60-s-Deckel. Bei erhöhter Parse-/Provider-Fehlerrate ggf. PC leicht anheben (mehr Reserve statt mehr Versuche).
- **Tradeoff T=15 s vs. legitime Langsam-Antworten:** serv-swift war im Incident 272–298 s (bursty). 15 s bricht solche Antworten ab → REVIEW. Das ist gewollt (Fail-Closed) unter der 60-s-Grenze.

---

## 10. Rollout-Sequenz `[RECOMMENDED]`

1. **Lokale deterministische Tests:** Tabelle §8.3 grün, Flag-off-Regression bit-identisch.
2. **Preview mit Fault-Injection:** hängender/langsamer Provider simuliert; 200+REVIEW < 60 s, Telemetrie vollständig.
3. **Non-certifying Canary — NUR nach Wiederherstellung des OpenServ-Pfads** (Incident 15:26–15:35 UTC). Alle Artefakte/Manifeste `certifying=false`, `movement_only=true`. Neue Telemetrie (finish_reason/tokens/latency/timeout_source) muss erscheinen.
4. **Prod-Deploy** mit `deadlineEnforcementEnabled=true` (env-flag-gated).
5. **Monitoring:** p50/p90/max Wandzeit, timeout_source-Verteilung, provider_outcome-Rate, REVIEW-Quote, 504-Rate (soll → 0).
6. **Rollback:** Feature-Flag auf false (sofort, ohne Redeploy falls env-gesteuert) → exakt heutiges Verhalten.

---

## 11. Branch-/Commit-/PR-Posture und Evidenz für Paul `[RECOMMENDED]`

- **Branch:** Feature-Branch von origin/main `34bba10`, env-flag-gated (Default off).
- **Commits:** kleinste logische Einheiten (Config-Felder → Runtime-Verdrahtung → CallContext → Engine-Deadline → Cascade-Reservierung → llm-client Signal/Telemetrie → Tests).
- **PR:** Draft, kein Merge, keine Live-Calls im CI.
- **Evidenz, die Paul dem PR beilegen muss:**
  1. Ausgabe der deterministischen Testtabelle §8.3 (alle grün, inkl. Leak-Test).
  2. Preview-Fault-Injection-Ergebnisse (Wandzeiten, 200+REVIEW, Telemetrie-Dump ohne Secrets).
  3. Post-Recovery non-certifying Canary mit neuen Telemetriefeldern (`certifying=false`, `movement_only=true`).
  4. Config-Hash/Provenance, der die Deadline-Parameter dokumentiert.

---

## 12. Zusammenfassung Kennzeichnungen

- `[VERIFIED]`: 60-s-Deckel (vercel.json + Hobby); Prod nutzt 60 s×6 Defaults (Runtime setzt keine Overrides); Primär→Sekundär sequenziell, Achsen parallel; Worst-Case ≈387 s/Call; CB braucht 5 Samples (kein Single-Hang-Trip); Aggregation Regel 2 provider_error→REVIEW; finish_reason/tokens heute verworfen; Kontrakt 200+REVIEW/leeres 504.
- `[RECOMMENDED]`: layered budget W45/PC18/T15/attempts2/backoff500-1500; DeadlineExceededError (provider_error, nicht-retrybar); additive finish_reason/token-Telemetrie; 200+REVIEW behalten; env-flag-gated; Canary nur nach Recovery.
- `[OPEN]`: AbortSignal.any/Node-Version; Cold-Start im 60-s-Budget; CB-Buchung von request_deadline-Abbrüchen; 503-Backstop-Contract.
