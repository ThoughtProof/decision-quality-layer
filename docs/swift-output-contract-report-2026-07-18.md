# Swift Output-Contract Report — Erzwungenes strukturiertes Output auf OpenServ?

**Date:** 2026-07-18 · **Author:** Hermes (Integrator) · **Briefing:** Swift-Rezertifizierung gestoppt (abgeschnittenes JSON auf `reversibility`, reproduzierbar bei 512/1024/2048 Completion-Tokens)  
**Scope:** Nur Doku-Verifikation + Analyse. **Kein Probeaufruf ausgeführt** (Freigabe ausstehend). Keine Keys berührt. Keine Änderung an Parser/Prompt/Benchmark/Baseline/Gate.

---

## 1. Antwort in einem Satz

**Nein — ein serverseitig erzwungenes Schema (json_schema / strict structured output / Grammar) für `serv-swift` ist anhand der offiziellen OpenServ-Dokumentation nicht belegbar.** Es gibt keinen dokumentierten `response_format`-Parameter auf irgendeinem der drei Endpunkte. Der einzige dokumentierte Struktur-Hebel sind `tools` + erzwungenes `tool_choice`.

## 2. Drei-Wege-Unterscheidung (wie im Briefing gefordert)

| Kategorie | Befund |
|---|---|
| **Lediglich angefordert** (`response_format: json_object`) | **Nicht dokumentiert.** Die Chat-Completions-Referenz sagt nur: *„All other OpenAI Chat Completions parameters are accepted and **forwarded to the model**."* Forwarding ≠ Durchsetzung — ob der Upstream es honoriert, ist SERV-seitig unspezifiziert. |
| **Serverseitig garantiertes Schema** (`json_schema` strict, Grammar/GBNF, constrained decoding) | **Nicht dokumentiert, nirgends.** Weder `/v1/chat/completions` noch `/v1/responses` noch `/v1/messages` listen einen solchen Parameter. Die Parameter-Matrix in `sdk-integration` (Token-Cap, Reasoning, Stop, Tools, Streaming) enthält **keine** `response_format`-Zeile. |
| **Nicht unterstützt / still ignoriert** | DQL-eigener Code-Beleg (`llm-client.ts:1053-1054`): SERV lehnt `max_tokens` hart mit **HTTP 400 `unsupported_parameter`** ab. Das Gateway validiert bekannte-unterstützte Parameter also strikt — stilles Ignorieren ist für *abgelehnte* Parameter ausgeschlossen; für *durchgereichte* Parameter (wie `response_format` es wäre) ist Durchsetzung unbewiesen. Ein Probeaufruf diskriminiert sauber: 400 = nicht unterstützt; 200 = forwarded (Enforcement weiterhin unbewiesen). |

## 3. Exakte Endpunkte und Parameter (Beleg: offizielle Doku)

| Endpunkt | Zweck | Struktur-relevante Parameter |
|---|---|---|
| `POST https://inference-api.openserv.ai/v1/chat/completions` | universal, alle Provider | `tools`, `tool_choice` (erzwingbar: `{type:"function", function:{name}}`) — **kein** `response_format` dokumentiert |
| `POST /v1/responses` | **OpenAI-Modelle only** | `tools`, `reasoning` — **kein** `text.format`/`json_schema` dokumentiert |
| `POST /v1/messages` | Anthropic-Format, multi-provider | `tools`, `tool_choice` — kein Schema-Param |

**Constraint für serv-swift:** DQL sendet `serv-swift` als **wörtliche Model-ID** (`llm-client.ts:251-254`) — ein SERV-Tier-Alias, kein Katalog-Modell (`gpt-5.4`, `claude-…` etc.). Die Upstream-Provider-Familie hinter dem Alias ist uns nicht bekannt und kann serverseitig wechseln. Damit entfällt `/v1/responses` (OpenAI-only) als sicherer Pfad. Alle Struktur-Optionen laufen über `/v1/chat/completions`.

**Marketing-Abgrenzung:** Die Landingpage bewirbt „Schema-forced execution — parse failures disappear". Das bezieht sich auf die **SERV-Reasoning-Engine (BRAID, bounded reasoning graphs)** — ein Orchestrierungslayer, kein Parameter, den ein Chat-Completions-Client setzen kann.

## 4. Verhalten bei ungültiger Ausgabe (belegt)

- SERV-Gateway: HTTP 400 bei *nicht unterstützten Parametern* (DQL-Code-Kommentar, `max_tokens`). Kein dokumentiertes Verhalten „Invalid-JSON → Server-Fehler/Retry" — weil kein Schema-Modus dokumentiert ist.
- DQL-Seite (unverändert, korrekt): Parse-Guard bricht **fail-closed** ab → Achse UNCERTAIN → Aggregat REVIEW. Die gestoppte Rezertifizierung bestätigt: keine unsichere Entscheidung wurde zertifiziert.

## 5. Kosten / Latenz / Kompatibilität ( falls `tools`-Hebel genutzt würde — nur Analyse, keine Empfehlung zum Deploy)

- **Kosten:** Forced-tool-call erzeugt zusätzliche Schema-Token im Prompt (~50–200 Input-Tokens je Achse). Kein SERV-Aufpreis dokumentiert; Modell-Preise wie Katalog.
- **Latenz:** Strukturgebundene Antworten sind typischerweise *kürzer* als freie Prosa+JSON — eher negativ bis neutral. Aber: siehe §6, Truncation-Problem bleibt.
- **Kompatibilität:** OpenAI-Tool-Format wird dokumentiert auf `/v1/chat/completions` universal unterstützt. Würde den DQL-Response-Contract von „JSON im `content`" auf „`tool_calls[0].function.arguments`" verlegen — ein Parser-Eingriff (außerhalb dieses Briefings, separate Freigabe nötig).

## 6. Der entscheidende Punkt: Erzwungenes Schema würde den Befund NICHT lösen

Der gestoppte Cert-Befund ist **Truncation**: abgeschnittenes JSON bei 512, 1024 **und 2048** Completion-Tokens. Selbst echte Grammar-Enforcement würde nur die *Form* der Tokens garantieren, nicht deren *Anzahl*. Ein Modell, das vor dem JSON-Abschluss ausufernden Content erzeugt, wird bei jedem Budget weiterhin bei `finish_reason: length` geschnitten — und der Parse-Guard bleibt fail-closed.

Konsequenz: Auch ein positiver Probe-Befund („OpenServ honoriert json_object") ändert **nichts** an der Nicht-Zertifizierbarkeit von Swift als Primary. Die drei gültigen Entscheidungen aus dem Stopp-Bericht bleiben unangetastet richtig.

## 7. Optionen für Swifts Secondary-Rolle — Bewertung

| Option | Bewertung |
|---|---|
| **A. Swift als fail-closed Secondary behalten** | **Empfohlen (interim).** Degradation ist belegt sicher: Parse-Fehler → REVIEW, nie unsafe. Kosten: CB-/Fail-Closed-Rauschen, Latenz. Kein Alias-/Production-Switch nötig. |
| **B. Swift als Secondary ersetzen** | Mittelfristig sauberster Weg — gleicher Maßstab: Ersatzkandidat muss die **100-Case-Adversarial-Suite** bestehen, bevor er irgendeine Prod-Rolle bekommt. Eigener Workstream, frühestens nach Item-3 + Movement-Report (getrennte Zuständigkeit, kein Stillstand im Kalibrierungs-Track). |
| **C. Swift aus dem Cascade entfernen** | **Nicht empfohlen jetzt.** Auf Kapitalpfaden ist der Fallback ohnehin disabled (`capitalPathMode=true`); auf Nicht-Kapitalpfaden bedeutete Entfernung: Nano-Ausfall = fail-closed ohne Tiefe. Erst nachdem ein zertifizierter Ersatz existiert. |

**Empfehlung:** A sofort (Status quo, keine Änderung), B als geplanter Nachfolge-Workstream mit identischem Cert-Maßstab, C erst nach B.

## 8. Probe-Design (max. 1 Call, erst nach ausdrücklicher Freigabe)

```
POST /v1/chat/completions · model: serv-swift · temp 0 · seed 42
messages: minimale Achsen-Form (system: JSON-only-Vertrag, user: triviales Reversibility-Mini-Szenario)
+ response_format: {"type":"json_object"}
```

Lesart: **400** → definitiv nicht unterstützt. **200 + invalid/truncated** → forwarded, nicht enforced (Antwort bleibt „Nein"). **200 + valide** → forwarded und einmal honoriert — *kein* Beweis serverseitiger Grammar (Beweis wäre adversarial N-Draws = Cert-Territorium, kein Probe). In allen drei Fällen bleibt §6 die bindende Konsequenz.

**Belegquellen:** docs.openserv.ai — `serv-reasoning/api/chat-completions`, `api/responses`, `api/compatibility`, `models`, `sdk-integration`, `what-is-serv` (alle 2026-07-18 abgerufen) · `llm-client.ts:237-254, 1040-1055, 1053-1054`.

*Keine Produktionsänderung vorgeschlagen oder ausgeführt. Probe erst nach Freigabe.*
