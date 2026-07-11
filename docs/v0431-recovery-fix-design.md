# v0.4.3.1 CB Recovery Fix — Design Draft v5

**Status**: DECISION-DRIVEN. Hermes hat gewählt: P2-korrigiert, 2a, 3a+, 4b.
**Priority**: v0.4.3.1 blocking
**Author**: Perplexity (implementing Hermes' Gate-Architecture-Decision 2026-07-11)
**Date**: 2026-07-11
**Iteration**: v5 (v4 SUPERSEDED — Hermes hat Router-Kadenz-Claim als Code-Fehldiagnose korrigiert)
**Supersedes**: v4, v3, v2 (alle SUPERSEDED)

---

## 0. Root-Cause-Korrektur — verifiziert

Meine v4-Root-Cause-Hypothese („nach OPEN wird `canProceed()` nie wieder aufgerufen") war **falsch**.

**Verifizierter Kontrollfluss** auf `origin/v043-cb-latency-fix` (`src/engine/llm-client.ts:325-338`):

```
Engine pro Achse
  → PotCliCascade.callAxis(primaryAlias)
    → HttpLlmClient.call(primaryAlias)
      → primaryBreaker.canProceed()  ← wird bei JEDER Achsenanfrage aufgerufen
```

`canProceed()` implementiert bereits die Transition OPEN → HALF_OPEN nach Cooldown-Ablauf (`circuit-breaker.ts:157-160`). Ein `call()` nach Cooldown-Ablauf löst die HALF_OPEN-Probe aus, ohne dass irgendwo im Router etwas geändert werden muss.

**Client-Level Regressionstest** in `src/engine/llm-client.recovery-regression.test.ts` beweist auf aktuellem Code (3/3 grün):

1. Cooldown-Ablauf → nächster primary-Call = HALF_OPEN-Probe → schneller Erfolg → CB CLOSED
2. Langsamer Probe (> `probeMaxLatencyMs`) → re-Trip mit frischem Cooldown
3. `capitalPathMode=true`: vor Cooldown fail-closed; nach Cooldown → primary-Probe (nie fallback)

**Konsequenz**: Der v4-Draft mit soft-OPEN, Router-Sampling, Recovery-Epochen, `recoverFromOpen()` ist **komplett überflüssig**. Bestehende cooldown → HALF_OPEN → CLOSED/OPEN-State-Machine ist funktional und ausreichend.

**Erklärung für Segment B im Vollrun**: Nach dem Trip liefen 415 nano-Fallback-Draws mit ~0 ms Latenz. Bei 5 Achsen × 83 Cases (415 Draws) und ~0 ms pro Draw endete der Run vermutlich vor Ablauf der 30s-Cooldown → HALF_OPEN wurde nie erreicht. Report-Satz „HALF_OPEN probes trippen sofort wieder" war spekulativ; State-Transition-Timestamps fehlten, um das zu beweisen.

---

## 1. Was v5 tatsächlich baut

**Kein neuer Recovery-Code.** Vier Arbeitspakete:

1. **Client-Level Regressionstest**: Bereits committed als `llm-client.recovery-regression.test.ts`. Bleibt in der Suite und dokumentiert die verifizierte Recovery-Semantik.
2. **Per-Alias-Bound-Konfiguration**: `circuitBreakerConfigByAlias` als Erweiterung von `HttpLlmClientConfig`, weil `tripP90LatencyMs=15s` bei swift-Realität ~24s p90 flapping erzeugen würde.
3. **State-Transition-Telemetrie**: `circuit_opened`, `half_open_probe_started`, `half_open_probe_succeeded`, `half_open_probe_failed`, `half_open_probe_over_bound`, `circuit_closed` — heute nicht als strukturierte Events emittiert, für Live-Drill und Canary aber Pflicht.
4. **Kalibrierungs-Run**: Instrumentierter workers=1-Run auf gesundem swift + nano zur Ableitung `tripP90LatencyMs` und `probeMaxLatencyMs` pro Alias — separat vor Gate 2, weil `ced1915`-Draw-Latenzen nicht per-axis netto sind.

Danach: Gate 1 + Gate 2 + 48h-Canary.

---

## 2. Gate 1 — Model Quality (Hermes-Entscheidung 2a)

**Ziel**: Trägt swift-primary 100 Cases ohne Recall-/Safety-Regression?

**Konfiguration**:

```
primary alias         = serv-swift (ausschließlich, kein Fallback)
disableCircuitBreaker = true
workers               = 1
N                     = 5 draws pro Case
capitalPathMode       = irrelevant (CB nicht instanziiert)
```

**Gate-1-Invarianten** (Hermes verbindlich):

- 100/100 Cases werden tatsächlich an swift adressiert
- Kein stilles Fallback
- `models_used`/`model_id` und Route pro Rohrecord zeigen, welcher Provider wirklich antwortete
- Provider-/Transport-Fehler werden separat ausgewiesen und dürfen nicht als gültige Model-Verdicts in die Quality-Metrik eingehen
- Vor Aggregation mindestens einen echten Roh-Call inspizieren

**Erfolgs-Formel**:

```
swift_route_coverage                 == 100%
AND successful_draw_completeness     == 100%  (oder vorab definierter harter Validity-Bound)
AND recall_regressions_vs_v041d      == 0
AND safety_regressions_BLOCK_to_ALLOW == 0
```

**Wichtig**: Wenn nicht alle Draws erfolgreich sind, darf der Run nicht still durch `UNCERTAIN@0` als „vollständig" gelten. Entweder vorab definierte Wiederholungsregel oder Gate invalid — **nicht nachträglich** die Regel ändern.

**Kein neues `neutralizedForBenchmark`-Flag.** Wir nutzen die bestehende klare Trennung via `disableCircuitBreaker=true`.

---

## 3. Gate 2 — Runtime Resilience (Hermes-Entscheidung 3a+)

**Ziel**: Recovert exakt die deployte Prod-Konfiguration nach einem realen CB-Trip sicher?

**Deployte Prod-Konfiguration** (das ist P2-korrigiert):

```
capitalPathMode          = false
disableCircuitBreaker    = false
recoveryMode             = KEIN — bestehende cooldown → HALF_OPEN → CLOSED/OPEN-State-Machine
circuitBreakerConfigByAlias = {
  'serv-nano':  { tripP90LatencyMs, probeMaxLatencyMs, cooldownMs, minSamples, windowSize },
  'serv-swift': { tripP90LatencyMs, probeMaxLatencyMs, cooldownMs, minSamples, windowSize },
}
```

Kein `soft-open`. Kein Router-Sampling. Kein `recoverFromOpen()`.

### 3a. Unit / Client-Integration Tests (12 Pflicht-Assertions)

Test-Datei bereits vorhanden: `src/engine/llm-client.recovery-regression.test.ts` (3 initiale Tests grün). v5 erweitert auf mindestens diese 12:

| # | Assertion | Was er beweist |
|---|---|---|
| 1 | 5 slow calls (>tripP90) → CB=OPEN via failure_rate/p90 | Trip deterministisch |
| 2 | Vor Cooldown, CPM=false → next call routes fallback | Bestehendes Fallback-Verhalten |
| 3 | Vor Cooldown, CPM=true → CircuitAllOpenError, 0 Fallback | Kapital fail-closed |
| 4 | Nach Cooldown, CPM=false → nächster primary-Call = HALF_OPEN-Probe | Existing HALF_OPEN transition |
| 5 | Schneller Probe (≤probeMaxLatencyMs) → CB=CLOSED, Fenster reset | Recovery-Success |
| 6 | Probe-Failure (throw) → CB=OPEN, neuer openedAt/Cooldown | Fresh cooldown on re-trip |
| 7 | Probe über Bound (>probeMaxLatencyMs) → CB=OPEN, neuer Cooldown | Bound-Enforcement |
| 8 | Parallelität: nur 1 HALF_OPEN-Probe erlaubt, konkurrierende Calls → fallback (CPM=false) bzw. fail-closed (CPM=true) | Single-flight probe |
| 9 | Nach erfolgreichem CLOSE: normale Calls sammeln wieder Samples für nächste Trip-Evaluierung | Closed-Windows-Reset |
| 10 | Flapping-Gegentest: konsistente trip/probe-Bounds (probe=trip) → gesunder Traffic bleibt CLOSED; inkonsistent (probe>trip) → sichtbarer Re-Trip nach Recovery | Bound-Konsistenz-Enforcement |
| 11 | `disableCircuitBreaker=true`: keine Breaker instanziiert, keine Fallback-Logik aktiv | Gate-1-Neutralisierung |
| 12 | Beide Aliases OPEN → Engine bleibt fail-closed (`UNCERTAIN@0`), niemals ALLOW über Error-Pfad | Safety-Invariante |

Alle Tests via Fake-Clock (`CircuitBreakerConfig.now`), Fake-Sleep (`HttpLlmClientConfig.sleep`), Fake-Fetch (`HttpLlmClientConfig.fetchImpl`). Kein Netzwerk.

### 3b. Kontrollierter Live-Drill

**Konfiguration** — exakt die spätere Prod-Config:

```
capitalPathMode          = false
finale per-alias Bounds  (aus Kalibrierungs-Run in §5)
soft-open                = aus (existiert nicht)
```

**Ablauf**:

1. Test-only Factory / injizierte deterministische Failure-Sequenz trippt swift-CB. Keine öffentliche `forceOpen()`-API.
2. Vor Cooldown: nächste Achsenanfrage übernimmt via nano-Fallback.
3. Nach realem Cooldown (per Wall-Clock, keine Zeit-Injektion im Live-Drill): nächste `client.call(swift)` wird HALF_OPEN-Probe.
4. Gesunder swift-Probe schließt CB.
5. Nachfolgender Traffic bleibt primary.
6. Gegenlauf mit zu langsamem/fehlgeschlagenem Probe → CB bleibt OPEN, setzt frischen Cooldown.
7. CPM=true Gegenprobe: vor Cooldown 0 Fallback / fail-closed; nach Cooldown darf Primary-Probe stattfinden, aber niemals nano.

**Report-Pflicht**: Echte State-Transition-Timestamps aus §4-Telemetrie:

- `circuit_opened`
- `half_open_probe_started`
- `half_open_probe_succeeded` / `half_open_probe_failed` / `half_open_probe_over_bound`
- `circuit_closed`

Keine Behauptung „Probe lief" nur aus `provider_route`. Log-Trace muss Zustandsübergänge zeigen.

**Kein 100-Case-Trip-Injection-Vollrun** (Hermes: würde Modellqualität und Runtime-Resilience wieder vermischen). Die 48h-Canary in §6 liefert reale passive Volumen-Evidenz.

---

## 4. Telemetrie — State-Transition-Events

Der `CircuitBreaker` emittiert heute die Trip-Reason via `lastTripReason`-Feld, aber keine strukturierten State-Transition-Events. v5 fügt einen Event-Callback-Hook hinzu (kein Product-Behavior-Change):

```typescript
interface CircuitBreakerConfig {
  // ... bestehende Felder
  onStateTransition?: (event: StateTransitionEvent) => void;
}

interface StateTransitionEvent {
  alias: string;
  from: CircuitState;
  to: CircuitState;
  at: number;              // via config.now()
  cause: 'trip-p90' | 'trip-failure-rate' | 'cooldown-elapsed' | 'probe-success' | 'probe-failure' | 'probe-over-bound';
  reason: string;          // freie Beschreibung (bestehende lastTripReason-Semantik)
  latencyMs?: number;      // bei probe-*
  boundMs?: number;        // bei probe-over-bound: der Bound gegen den geprüft wurde
  windowSize?: number;     // bei trip: aktuelle Fenster-Größe
  windowP90?: number;      // bei trip-p90
  windowFailureRate?: number; // bei trip-failure-rate
}
```

Der `HttpLlmClient` registriert einen Standard-Handler, der die Events als strukturiertes JSON in denselben Log-Sink schreibt wie bestehende CB-Logs.

**Kein produkt-verhaltensrelevanter Change**. Nur observable Events, damit Live-Drill und Canary aus Log-Traces echte State-Transitions rekonstruieren können.

---

## 5. Bound-Kalibrierung — vor Gate 2

### 5a. Datenquelle

**`ced1915`-Draw-Latenzen sind ungeeignet** (Hermes: verifiziert). Draw-Latenz ≈ max der parallelen 5 Achsen-Calls, nicht die per-axis-Verteilung, gegen die der CB p90 misst.

**Kalibrierungs-Run** vor Gate 2:

- separater instrumentierter workers=1-Lauf
- mindestens 20 Cases
- mindestens 50 erfolgreiche Samples je Alias (nano + swift)
- pro Achsen-Call instrumentiert: `alias`, `axis`, `success`, `attemptCount`, `wallClockMs`, `backoffWaitedMs`, `netLatencyMs`, `timestamp`
- gesunder Providerzustand — keine bekannten Ausfälle während des Runs
- keine Draw-Latenz als Ersatz
- Report mit p50/p90/p95/max pro Alias, plus Rohdaten
- Rohdaten + Report + Manifest auf `dql-benchmark/main` gepusht **vor** Gate 2

### 5b. Bound-Ableitungsregel

Standard-Regel für v0.4.3.1:

```
probeMaxLatencyMs = tripP90LatencyMs
```

Diese Gleichheit vermeidet OPEN → HALF_OPEN → CLOSED → OPEN-Flapping-Zyklen (Hermes: verifiziert). Abweichung nur mit expliziter Hysterese-Begründung + Flapping-Test.

**Wertfindung** (v5 verbindlich):

```
tripP90LatencyMs pro Alias = max(
  aufgerundeter beobachteter p95(netLatency) auf gesundem Provider,
  begründetes Produkt-/Client-SLO
)
```

Aufrunden auf 5s-Vielfache für Config-Lesbarkeit. Blindes „p95 aufrunden" ist verboten wenn p95 eine Provider-Anomalie enthält — Bound muss **beides** berücksichtigen: beobachtete Realität + akzeptable Service-Grenze.

**Der konkrete Bound wird erst nach dem Kalibrierungs-Run bestimmt** und dann in einem separaten Design-Delta-Commit dokumentiert. Kein spekulativer Wert in v5.

### 5c. `circuitBreakerConfigByAlias` — Implementation

Der aktuelle `HttpLlmClient` hält nur eine globale `circuitBreakerConfig`. v5 erweitert:

```typescript
interface HttpLlmClientConfig {
  // ... bestehende Felder
  circuitBreakerConfig?: CircuitBreakerConfig;                  // fallback für alle Aliases (bestehend)
  circuitBreakerConfigByAlias?: Record<string, CircuitBreakerConfig>;  // per-alias override (neu)
}
```

`getBreaker(alias)` löst wie folgt auf:

```typescript
const perAlias = this.circuitBreakerConfigByAlias?.[alias];
const merged = { ...this.circuitBreakerConfig, ...perAlias };
cb = new CircuitBreaker(alias, merged);
```

Wenn ein Alias in `circuitBreakerConfigByAlias` fehlt, fällt er auf die globale `circuitBreakerConfig` zurück. Wenn beide fehlen, `CircuitBreaker`-Defaults.

**Test-Anforderung**: `circuitBreakerConfigByAlias` muss durch mindestens einen der zwölf Unit-Tests aus §3a explizit geprüft werden (z.B. nano cooldown=30s, swift cooldown=60s → zwei verschiedene HALF_OPEN-Zeitpunkte im selben Client).

---

## 6. Canary (Hermes-Entscheidung 4b)

Nach Gate 1 + Gate 2 beide grün:

```
10% Traffic für 48h → nur dann 100%
```

**Realitäts-Check**: Falls die Deployment-Schicht heute kein echtes prozentuales Routing unterstützt, ist „10%" nur in Doku nicht ausreichend. Alternativen (Hermes verbindlich):

- Klar benannte Kapitalpfad-Integration / Canary-Deployment
- Shadow-Traffic ohne Execution-Autorität
- Expliziter Anteil über vorhandenen Router/Feature-Flag

**Was für ThoughtProof heute realistisch ist**: TBD, muss vor Canary-Start geklärt sein. Vermutlich Feature-Flag im Client mit prozentualer Auswahl per Verifikation-ID-Hash.

**Kein neuer komplexer Routing-Code nur für „10%"**. Entscheidend: begrenzter Blast Radius + messbarer echter Traffic.

### 6a. Canary-Ampeln (v5 vorab definiert)

Alle müssen 48h grün sein:

- **Safety**: 0 Safety-Regressionen, 0 Error→ALLOW
- **Route-Integrität**: kein Fallback auf fremde/unvalidierte Provider
- **Observability**: OPEN/HALF_OPEN/CLOSED-Transitions vollständig beobachtbar (§4-Events)
- **Recovery-Zeit**: Recovery innerhalb definierter Zeit nach Provider-Gesundheit (Wert TBD in v5-Delta nach Kalibrierung, z.B. „innerhalb `cooldownMs + probeMaxLatencyMs` nach dem letzten schlechten Sample")
- **Flapping**: keine OPEN↔CLOSED-Flapping-Serie (definiert als >3 Transitions in 5 Minuten pro Alias)
- **Route-Verteilung**: Fallback-Rate und primary-route-share ausgewiesen und stabil
- **Latenz**: p50/p90/p95 per Alias auf netto Achsen-Latenz
- **Fehler-/Timeout-Rate**: ausgewiesen und stabil
- **Delta zu Kontrollgruppe**: Kosten- und Latenzdelta gegenüber pre-Canary-Traffic

### 6b. Rollback

Reversibel via Config/Feature-Flag → CPM=true oder vorherige sichere Posture. **Kein hektischer Code-Revert als primärer Rollback.** Rollback-Trigger: eine der obigen Ampeln rot > 5 Minuten.

---

## 7. Release-Regel (Hermes verbindlich)

```
Gate 1 grün                 → swift qualitativ rezertifiziert
Gate 2 grün                 → konkrete Runtime-Konfiguration resilient
capitalPathMode=false auf Prod-Kapitalpfaden  → erst wenn BEIDE Gates + 48h-Canary grün
```

---

## 8. PR-Struktur (Hermes verbindlich)

### 8a. PR #11 — jetzt separat eröffnen auf sauberem Branch

Der aktuelle `origin/v043-cb-latency-fix` enthält inzwischen 2 Code-Commits + 5 Design-/Roadmap-Commits + fast 2000 Diff-Zeilen inkl. superseded Designs. Das würde den kleinen Latency-Fix im Dokumentrauschen verstecken.

Saubere Reihenfolge:

1. Neuer Branch `v043-cb-latency-fix-clean` von `origin/main`
2. Nur diese zwei Code-Commits übernehmen:
   - `0dd07ae` — Retry-/Backoff-Instrumentierung (`LlmCallOutput.{attemptCount, backoffWaitedMs, retryReasons}`)
   - `cb9d83a` — Netto-Latenz an CB (netLatency = wallClock - backoffWaitedMs in 2 Sites)
3. Tests/Typecheck/Build auf `v043-cb-latency-fix-clean` — muss 105/105 grün sein
4. PR #11 eröffnen mit Links auf verifizierte `ced1915`-Artefakte im dql-benchmark-Repo
5. Diff enthält nur `llm-client.ts` und `llm-client.test.ts` (bzw. wirklich notwendige Code-Pfade)
6. Nach PR-#11-Merge: `main` erneut vollständig verifizieren (Tests + Manifest)
7. v5-Recovery-Branch erst dann von frischem `main`

Die Design-Dokumente (`v0431-*.md`, `sync-hermes-perplexity-*.md`, `ROADMAP.md`-Escalations) bleiben historisch auf `v043-cb-latency-fix` oder gehen später in einen separaten Docs-PR. Sie gehören **nicht** in PR #11.

### 8b. PR #12 — v0.4.3.1 auf Basis von PR-#11-Merge

Neuer Branch `v043-cb-recovery-fix` **von frischem `main` nach PR-#11-Merge**. Enthält:

1. `llm-client.recovery-regression.test.ts` (existiert bereits, wird in diesen PR verschoben)
2. `circuitBreakerConfigByAlias`-Erweiterung in `HttpLlmClient` (§5c)
3. `CircuitBreakerConfig.onStateTransition`-Hook + Event-Emissionen im CB (§4)
4. Standard-Handler im `HttpLlmClient` der Events als strukturiertes JSON in Log-Sink schreibt
5. 12 Unit/Client-Integration-Tests aus §3a
6. Kalibrierungs-Run-Ergebnisse als separater Report auf `dql-benchmark/main` referenziert (§5)
7. Live-Drill-Report auf `dql-benchmark/main` referenziert (§3b)

**PR-Merge nur nach Hermes-Vier-Augen-Review** aller drei Reports (Kalibrierung + Live-Drill + Test-Suite).

---

## 9. Was NICHT Teil von v0.4.3.1 ist

- **soft-OPEN als deploybares Produktverhalten** (P3): Verworfen — unnötige Angriffsfläche.
- **Router-Kadenz-Änderung**: Nicht nötig — bestehender Kontrollfluss ist korrekt.
- **`recoverFromOpen()`-Public-API**: Nicht nötig — HALF_OPEN via `canProceed()` reicht.
- **Router-Sampling / Probe-Buffer**: Nicht nötig.
- **Retry-Bug adv_084/adv_098**: v0.4.4.
- **Suite v1.2**: v0.4.4.
- **AgentDojo Track**: nach v0.4.2 stabil.

---

## 10. Acceptance-Kriterien für v0.4.3.1-Close

Alle sechs müssen erfüllt sein:

1. **PR #11 gemergt** auf `main`, 105/105 Tests grün nach Merge
2. **Kalibrierungs-Run gepusht** auf `dql-benchmark/main` mit p50/p90/p95/max pro Alias + Rohdaten + Manifest
3. **12 Unit/Client-Integration-Tests** aus §3a grün, inkl. der drei bereits existierenden aus `llm-client.recovery-regression.test.ts`
4. **Live-Drill-Report gepusht** auf `dql-benchmark/main` mit vollständigen State-Transition-Timestamps
5. **Gate 1 grün** mit vier Erfolgs-Formel-Bedingungen
6. **48h-Canary grün** mit allen neun Ampeln aus §6a

Erst danach: `capitalPathMode=false` auf Prod-Kapital-Pfaden.

---

## 11. Zusammenfassung der Hermes-Kritikpunkte-Antworten

| # | Hermes-Punkt | Wo in v5 adressiert |
|---|---|---|
| 0 | Root-Cause-Korrektur (`canProceed()` wird bei jeder Achse aufgerufen) | §0 mit Regressionstest-Nachweis |
| 1 | P2-korrigiert (keine neue State-Machine) | §1 Arbeitspaket-Liste, §3 Gate 2 auf realer Prod-Config |
| 2 | Kalibrierung nicht nur `probeMaxLatencyMs`, auch `tripP90LatencyMs` | §5b Standardregel `probe=trip`, §5a Kalibrierungs-Run |
| 3 | Kalibrierung nicht aus `ced1915`-Draw-Latenzen | §5a expliziter neuer Kalibrierungs-Run |
| 4 | Gate 1 mit `disableCircuitBreaker=true` | §2 Gate-1-Konfiguration und -Invarianten |
| 5 | Kein `neutralizedForBenchmark`-Flag | §2 letzter Absatz |
| 6 | Gate-1-Invarianten (100% Coverage, keine stille UNCERTAIN@0-Vervollständigung) | §2 Invarianten und Erfolgs-Formel |
| 7 | Gate 2 als Unit + Live-Drill (kein Trip-Injection-Vollrun) | §3a + §3b, kein separater Vollrun |
| 8 | Live-Drill braucht echte State-Transition-Timestamps | §3b Report-Pflicht + §4 Telemetrie |
| 9 | 48h-Canary mit vorab definierten Ampeln | §6a neun Ampeln, §6b Rollback |
| 10 | PR #11 auf sauberem Branch, nicht direkt aktueller Remote | §8a saubere Reihenfolge |

---

## 12. Zwei offene Punkte für Hermes-Review dieses v5

1. **`circuitBreakerConfigByAlias`-Merge-Semantik**: v5 sagt „shallow merge" (`{ ...global, ...perAlias }`). Ist das für dich okay, oder willst du dass perAlias die globale Config komplett ersetzt (kein Merge)? Meine Empfehlung: shallow merge, weil dann `onStateTransition`-Handler und andere gemeinsame Felder nicht pro Alias dupliziert werden müssen.

2. **Canary-Routing-Mechanik**: §6 nennt drei Alternativen. Ist eine davon in ThoughtProof-Deployment heute wirklich verfügbar? Wenn nicht, wird das ein v5-Delta-Design bevor Canary starten kann. Was ist der Status?

---

## 13. Prozess-Regel (unverändert)

„Fertig" = Code committed + auf origin gepusht + Rohdaten + Report + Manifest gepusht und verifizierbar. Kein Status-„grün" ohne alle vier.

Erst v5-Review, dann PR #11 auf sauberem Branch, dann Kalibrierungs-Run, dann PR #12 Implementation, dann Gate 1, dann Gate 2, dann Canary. Kein Schritt darf einen vorherigen überspringen.
