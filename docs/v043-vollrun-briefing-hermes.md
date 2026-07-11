# v0.4.3 Vollrun Briefing — Hermes

**Datum**: 2026-07-11
**Branch**: `v043-cb-latency-fix` @ `cb9d83a` (PR #11 gefixter Build)
**Rohdaten**: `runs/v043_swift_primary_recert_w1.jsonl` (workers=1, N=5, 500 Verifikationen, 0 Errors)
**Wall-Clock**: 1448s (~24 Min)
**Status**: **Vollrun-Ergebnis vorliegend, Gate-Entscheidung offen**

---

## TL;DR

1. **PR #11 funktioniert wie designed** — im Segment mit swift-primary keine spurious retry-cluster-Trips.
2. **Vollrun teilt sich in zwei Segmente**: die ersten 17 Cases laufen sauber auf swift-primary, danach ist der Circuit-Breaker persistent-OPEN für die restlichen 83 Cases (nano-fallback).
3. **Der Recovery-Blindspot aus dem v0.4.4-Roadmap-Ticket ist live vorgeführt** — der Vollrun ist unrecertifizierbar, weil 83% der Cases nicht swift, sondern nano messen.
4. **swift-primary trägt die Suite in Segment A überraschend gut** (88,2% gt_match), aber die Suite kann ohne Recovery-Fix nicht komplett auf swift laufen.

---

## Fakten

### Vollrun-Konfiguration

- Runner: `scripts/run-adversarial-suite-swift-primary.mjs`
- Build: `v043-cb-latency-fix` @ `cb9d83a` (Fix im `dist/` verifiziert: 4 `netLatency` references)
- Config: workers=1, N=5, primary=serv-swift, secondary=serv-nano
- Suite: 100 adversarial cases × 5 draws × 5 axes = 2500 axis-calls total
- Circuit-Breaker: default config (p90≥15000ms, failure_rate≥0.5, window=20 samples/60s)

### Ergebnis-Aggregat

| Metrik | Wert |
|---|---|
| cases | 100 |
| verifications | 500 |
| errors | 0 |
| stable (N=5 unanimous) | 99/100 |
| contaminated (≥1 fallback draw) | 84/100 |
| **gt_match majority** | **26/100** |
| wall time | 1448.3s |
| draw p50 latency | 0ms (dominiert von 415 fallback-draws mit ~0ms) |
| draw p90 latency | 7749ms |
| draw p99 latency | 35002ms |

### Segment-Analyse

Der Vollrun teilt sich am Case 16/17 in zwei disjunkte Regime:

| Segment | Cases | Achsen-Route | gt_match | Bemerkung |
|---|---|---|---|---|
| **A: adv_001–adv_017** | 17 | swift-primary (100% bis Case 16, adv_017 gemischt 21/25 primary) | **15/17 = 88,2%** | echtes swift-Verhalten |
| **B: adv_018–adv_100** | 83 | 100% nano-fallback | 11/83 = 13,3% | CB persistent-OPEN |

### Latenz-Verteilung Segment A (85 draws mit swift-primary-Antwort)

| p50 | p75 | p90 | p95 | p99 | min | max |
|---|---|---|---|---|---|---|
| 8138ms | 9256ms | 24097ms | 34767ms | 270331ms | 5272ms | 270331ms |

**Interpretation**: swift-Latenz für DQL-5-Achsen-Draws liegt bei p50 ~8s, p90 ~24s. Der 270s-Outlier ist adv_017 (der Kipppunkt-Case), wo ein retry-cluster einen legitimen p90-Trip ausgelöst hat.

### Wann kippt der CB?

- Last case mit 100% primary: **Case 16 (adv_016)**
- First case mit Fallback: **Case 17 (adv_017)** — 21/25 primary, 4/25 fallback (Trip während der Ausführung)
- First case mit 0% primary: **Case 18 (adv_018)** — CB persistent-OPEN, HALF_OPEN-Probes trippen sofort wieder
- Ab Case 18 bis Case 100 = 83 Cases in Folge: **kein einziger primary-Call gelingt**

---

## Was das über PR #11 beweist

**Positive Evidenz (PR #11 wirkt):**

- Segment A (17 Cases, 85 draws, echte swift-Latenz p50=8s / p90=24s): **0 spurious retry-cluster-Trips**. Vor dem Fix hätte allein ein Retry-Cluster mit 5s-Backoff die wall-clock über 15s gedrückt und einen Trip ohne echten Provider-Grund ausgelöst. Das ist im Segment A nicht mehr passiert.
- Der Trip bei adv_017 war **retry-justified** — 270s wall-clock deuten auf einen Cluster hin, aber der p90 im 60s-Fenster nach Abzug von backoffWaitedMs war offenbar tatsächlich hoch genug für einen legitimen Latenz-Trip (nicht spurious).

**Was PR #11 nicht adressiert (und auch nicht sollte):**

- Nach dem legitimen Trip bei adv_017 kann der CB nicht mehr recovern. HALF_OPEN probes werden in derselben ~24s-swift-Latenz-Umgebung ausgeführt und trippen sofort wieder. Genau der Recovery-Blindspot aus dem v0.4.4-Roadmap-Ticket.

---

## Der Gate-Kernkonflikt

Das v0.4.3-Erfolgsgate ist:

```
recall_regressions_vs_v041d == 0 AND safety_regressions_block_to_allow == 0
```

Aber die Vergleichsgröße "swift-primary Verhalten" ist **nur für 17 von 100 Cases gemessen**. Für die restlichen 83 wurde nano-fallback + CB-Overhead gemessen. Ein Recall-Vergleich in diesem Zustand wäre nicht:

- "swift-primary vs v0.4.1d (nano-primary)"

sondern:

- "swift-für-17-Cases-dann-nano-für-83-Cases-mit-CB-Overhead vs v0.4.1d (nano-primary)"

Das ist nicht die Frage, die der Vollrun beantworten soll.

---

## Drei Wege nach vorn

### Option A — v0.4.4 Recovery-Fix vorziehen, dann v0.4.3 Vollrun neu

- Recovery-Fix als **v0.4.3.1** einordnen, BLOCKING vor Recert
- Design: synthetic-probe outside HALF_OPEN (kleine Ping-Requests entkoppelt von echtem Traffic), oder Latency-basierte HALF_OPEN mit größerem Toleranz-Fenster nur für den Probe-Call
- Danach Vollrun `v043-cb-latency-fix + v043-recovery-fix` — swift kann durchlaufen ODER trippt an einer echten Provider-Anomalie (was dann eine legitime Gate-Frage wäre)
- **Wissenschaftlich sauberste Reihenfolge, längster Zeithorizont** (~1-2 Wochen für Design+Impl+Tests)

### Option B — Trip-Threshold anheben, Baseline nachrechnen

- `tripP90LatencyMs`: 15_000 → z.B. 40_000 (auf Basis der live-gemessenen p95=34,7s in Segment A)
- Begründung: der 15s-Threshold wurde für nano-primary kalibriert (v0.4.1d), nicht für swift-primary. swift's echte p90 im DQL-Kontext ist strukturell höher (mehr Reasoning-Tokens pro Achse). Der Threshold sollte pro Primary-Model gewählt werden.
- **Auflage**: Baseline v0.4.1d muss unter demselben neuen Threshold nachgerechnet werden für fairen Recall-Vergleich (sonst confounded)
- **Risiko**: Config-Änderung mid-recertification. Hermes muss den neuen Threshold begründen und ins Config-Contract aufnehmen.
- **Zeithorizont**: ~2-3 Tage (Threshold-Anpassung + Baseline-Nachlauf + neuer Vollrun)

### Option C — Vollrun so committen, v0.4.3 aufschieben

- Rohdaten + Report + SHA-Manifest als "expected-failure" auf `dql-benchmark/main` committen
- PR #11 dokumentiert als "korrekt und notwendig, aber allein nicht ausreichend für Recert"
- v0.4.3-Recert offiziell verschoben bis v0.4.4-Recovery-Fix und/oder Threshold-Neu-Kalibrierung
- **Am transparentesten**, verkauft aber die 88,2% gt_match in Segment A unter Wert

---

## Meine Empfehlung

**Option A** ist am saubersten, weil:

1. Der Recovery-Blindspot war schon **vor** dem Vollrun als BLOCKING v0.4.4 dokumentiert. Der Vollrun ist die Live-Bestätigung dieser Diagnose. Das v0.4.4-Ticket **jetzt** vorzuziehen ist konsistent mit deiner eigenen Klassifikation.
2. Option B (Threshold-Änderung) löst das Recovery-Problem **nicht** — sie schiebt den Trip-Zeitpunkt weiter nach hinten, aber sobald irgendein Trip passiert, ist die Suite in gleicher Weise unrecertifizierbar. Der 270s-Outlier bei adv_017 würde auch bei Threshold=40s trippen.
3. Option C schadet der Interpretation: die 88,2% gt_match in Segment A sind ein **positives Signal für swift-primary**, das im Aggregat 26/100 unsichtbar wird.

**Aber**: Die Entscheidung liegt bei dir. Ich bin nicht überzeugt genug von Option A gegen Option B, um sie ohne dein Vier-Augen-Signal zu wählen. Konkret: falls dein Modell von swift's Latenz-Verteilung im DQL-Kontext strukturell "swift ist ~2× langsamer als nano, das ist normal und der Threshold sollte darauf reagieren" ist, wäre Option B eher richtig.

---

## Offene Fragen für dich

1. **Ist der 15s-p90-Threshold für swift-primary strukturell falsch kalibriert?** (Option B) Oder ist er richtig kalibriert und das Recovery-Problem ist der eigentliche Fehler? (Option A)
2. **Bei Option A**: Willst du das v0.4.4-Ticket zu v0.4.3.1 hochstufen (BLOCKING) oder als eigenständige Version fahren?
3. **Bei Option B**: Welchen neuen p90-Trip-Threshold hältst du für angemessen — 30s, 40s, 60s? Und: soll der pro Model (nano vs swift) konfigurierbar sein?
4. **Recall-Vergleich gegen v0.4.1d in Segment A allein aussagekräftig?** 17 Cases sind statistisch schwach, aber 88,2% gt_match ist ein starkes Signal.

---

## Was ich bis zu deinem Signal NICHT tue

- Kein Commit der Vollrun-Rohdaten auf `dql-benchmark/main`
- Kein PR #11 Merge (der wartet ohnehin auf grünen Vollrun)
- Kein Runner- oder Config-Tweak
- Kein Recall-Vergleich (ergäbe unter aktuellen Vollrun-Daten kein aussagekräftiges Ergebnis)

## Was ich bei Freigabe tue

- **Option A**: v0.4.4-Recovery-Fix designen — Vorschlag: synthetic-probe (kleine 50-Token-Requests im HALF_OPEN-State, entkoppelt von echtem DQL-Traffic). Zusatz-Roadmap-Update, PR-Draft.
- **Option B**: `tripP90LatencyMs` per-model konfigurierbar machen, Baseline v0.4.1d unter neuem Threshold nachrechnen, dann neuer Vollrun auf `v043-cb-latency-fix`.
- **Option C**: Rohdaten+Report+Manifest-Commit vorbereiten, PR #11 mit "documented-partial-success"-Body, v0.4.3-Recert-Deferral im ROADMAP.md.
