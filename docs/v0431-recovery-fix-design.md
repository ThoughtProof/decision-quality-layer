# v0.4.3.1 CB Recovery Fix — Design

**Status**: BLOCKING v0.4.3 Recert
**Priority**: escalated from v0.4.4 roadmap → v0.4.3.1 blocking
**Author**: Perplexity (recording Hermes' decision)
**Date**: 2026-07-11

## Problem (recap)

Vollrun `v043-cb-latency-fix @ cb9d83a` (workers=1, 100 cases × N=5):

- Case 1-16: 100% swift-primary, 15/17 gt_match (88,2%) in Segment A
- Case 17: legitimer p90-Trip auf swift (retry-Cluster, 270s wall-clock)
- Case 18-100: **83 Cases in Folge kein einziger primary-Call** — CB persistent-OPEN

Root cause: HALF_OPEN probe uses the same real-traffic Achsen-Prompts, in the same swift-Latenz-Umgebung. Any probe attempt immediately re-trips (p90-Fenster wird sofort wieder überschritten). Der CB kann in dieser Konfiguration nach einem legitimen Trip **nie recovern**, bis Prozess-Restart oder manueller Redeploy.

## Verworfene Design-Option: 50-Token-Ping-Probe

Ich hatte in der ersten Session-Skizze einen "synthetic 50-token ping"-Probe vorgeschlagen. **Hermes hat das verworfen mit korrekter Begründung**:

> Der Probe muss reale Achsen-Latenz widerspiegeln. Sonst flappt der Circuit: Probe passes (weil trivial) → HALF_OPEN → echter DQL-Traffic mit realistischen 5s-Reasoning-Tokens trippt sofort wieder → OPEN. Cycle wiederholt sich ohne progress.

**Konsequenz**: Ein Probe, dessen Latenz nicht dem echten Achsen-Verhalten entspricht, ist funktional äquivalent zu "keinem Probe" — er misst eine andere Größe als der Trip-Detector, und die beiden Signale entkoppeln sich.

## Design-Anforderungen (Hermes-Freigabe erforderlich)

Der Probe MUSS:

1. **Achsen-shape haben** — vollständiger DQL-Achsen-Prompt (system + user + reasoning), 5s+ token generation, gleiche Model-Config wie echter Traffic
2. **Deterministisch reproduzierbar** — feste Achsen-Prompt-Vorlage, nicht aus dem echten Traffic gezogen (sonst wird Probe = Traffic, kein separates Signal)
3. **Trip-Threshold-konsistent** — Probe-Latenz zählt in dasselbe p90-Fenster wie echter Traffic ODER in ein probe-eigenes Fenster mit expliziter Recovery-Semantik
4. **Recovery-Signal von Trip-Signal getrennt haltbar** — sonst haben wir das gleiche Coupling-Problem wie im 50-Token-Ping, nur mit realistischen Latenzen

## Skizze — 3 Sub-Optionen zur Diskussion

### Sub-Option 1: Probe-Achse mit Toleranz-Fenster

- Probe ist ein **fixer 4-Turn-Achsen-Prompt** (system + 3 messages, ~500 tokens context, erwartete Output-Länge ~200 tokens) — bewusst gewählt aus der niedrigeren Perzentile der echten Suite-Prompt-Distribution
- Probe-Latenz wird gemessen und **nicht** ins Trip-Fenster gezählt. Stattdessen: HALF_OPEN → probe → wenn Latenz ≤ 1,3× median(letzte 10 successful pre-trip primary latencies), CLOSED; sonst zurück zu OPEN
- **Vorteil**: reale Achsen-shape, aber Recovery-Threshold ist dynamisch relativ zum pre-trip-Verhalten (nicht statisch)
- **Risiko**: 1,3×-Faktor ist Hyperparameter, muss kalibriert werden

### Sub-Option 2: Zeit-basierte Recovery + Achsen-Sample-Bootstrap

- Nach OPEN: fixe cooldown-Zeit (z.B. 5 Min, konfigurierbar)
- Nach cooldown: HALF_OPEN, aber der p90-Fenster wird **explizit geflushed** (kein Sample-Carry-over)
- 3 echte Achsen-Calls in Folge müssen unter Trip-Threshold liegen, dann CLOSED
- Falls einer trippt: zurück zu OPEN, cooldown neu
- **Vorteil**: keine Probe-Traffic-Entkoppelung, natürlicher recovery über echten Traffic
- **Risiko**: bei anhaltender Provider-Latenz wird der Circuit ewig oszillieren (OPEN → 5min wait → HALF_OPEN → trip → OPEN → 5min wait ...). Der Cooldown muss lang genug sein, dass Provider-Anomalien realistischerweise abgeklungen sind (5 Min ist evtl. zu kurz).

### Sub-Option 3: Zwei-Ebenen CB (soft-OPEN + hard-OPEN)

- Bei Trip: **soft-OPEN** — HALF_OPEN-artiges Verhalten, aber statt 1 Probe wird **jeder N-te Traffic-Call durchgelassen** (z.B. jeder 5.). Andere Calls gehen fallback.
- Wenn 3 durchgelassene Calls in Folge unter Trip-Threshold: CLOSED
- Wenn irgendein durchgelassener Call trippt: **hard-OPEN**, klassisches HALF_OPEN-mit-Cooldown (wie heute)
- **Vorteil**: kein separater Probe, natürlicher Übergang, kein Traffic-Verlust während Recovery-Test
- **Risiko**: komplexere State-Machine, mehr Test-Fläche, capitalPathMode-Semantik bei soft-OPEN nicht offensichtlich

## Meine Empfehlung (Diskussions-Basis für Hermes)

**Sub-Option 2** ist am einfachsten und am wenigsten Hyperparameter-abhängig. Aber der Cooldown-Wert ist kritisch — zu kurz = flapping, zu lang = zu träge bei echter Provider-Recovery.

Konkreter Vorschlag zur Kalibrierung:

- Base cooldown = 5 Min
- Bei re-trip innerhalb 30 Min: cooldown × 2 (exponential backoff bis max 60 Min)
- Bei 60 Min continuous CLOSED: cooldown-Zähler reset

Das ist **defensiv**: der CB gibt langsam Vertrauen zurück, verweigert es aber schnell bei wiederholtem Fehlverhalten.

**Aber**: das ist mein Vorschlag, nicht das entschiedene Design. Ich baue nichts davon ohne dein explizites Signal auf eine Sub-Option + Parameter.

## Testing-Anforderungen

Egal welche Sub-Option:

- Unit tests: state machine (CLOSED → OPEN → recovery-attempt → CLOSED oder OPEN)
- Integration test: real openserv-Call-Cluster, künstlicher Trip induziert, dann verifizieren dass Recovery innerhalb realistischer Zeit stattfindet
- **Regression test**: der Vollrun `v043_swift_primary_recert_w1.jsonl` MUSS mit dem Fix bis Case 100 primary-Anteil > 80% zeigen. Das ist das messbare Erfolgs-Signal.

## Was blockiert bis zur Fertigstellung

- v0.4.3 Recert (capitalPathMode=false auf Prod-Kapital)
- Jeder weitere swift-primary Vollrun (bringt kein neues Signal ohne Recovery)

## Was NICHT blockiert wird

- PR #11 kann so gemerged werden (der Fix ist korrekt und Voraussetzung für v0.4.3.1) — aber ohne v0.4.3.1 fertig, kein Recert-Merge auf Prod-Kapital-Pfaden
- Suite v1.2 Arbeit (unabhängig)
- Retry-Bug adv_084/adv_098 (separater Track)

## Prozess-Regel (retroaktiv seit dieser Session)

**"Fertig" = Code committed + gepusht auf origin + Rohdaten + Report + Manifest gepusht.**

Die Session hier hat gezeigt, dass "gepusht" nicht implizit angenommen werden darf. Ab jetzt gehört der Push explizit in jeden Statusbericht.
