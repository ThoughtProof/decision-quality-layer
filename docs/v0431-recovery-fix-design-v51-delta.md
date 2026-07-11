# v0.4.3.1 CB Recovery Fix — v5.1 Delta

**Status**: Delta zu v5. Antwort auf Hermes-Review 2026-07-11 (b8cc010f).
**Priority**: v0.4.3.1 blocking
**Author**: Perplexity
**Date**: 2026-07-11
**Basis**: `v0431-recovery-fix-design.md` (v5) bleibt Referenz; dieses Delta korrigiert die vier Blocker + zwei Majors + fünf kleine Punkte. Kein Rewrite.

---

## Vorab: was Hermes akzeptiert hat

- P2-korrigiert (kein Router-/soft-OPEN-Code)
- Gate 1 via `disableCircuitBreaker=true`
- Client-Recovery-Test als Beweis (6e88224 verifiziert)
- Per-Alias Config grundsätzlich
- Shallow merge grundsätzlich (mit Bedingungen — siehe §7)
- Structured state-transition telemetry grundsätzlich (mit Non-Throw-Invariante — siehe §3)
- Unit + live-provider drill
- Separate PR #11 / PR #12

**PR #11-Cleanup darf nach v5.1-Freigabe sofort starten. Noch kein PR-#12-Code.**

---

## Blocker 1 — Bound-Ableitungsregel wird durch SLO-Eligibility + CB-Replay ersetzt

**Verworfen**: Die v5-§5b-Formel `tripP90LatencyMs = max(rounded healthy p95, product/client SLO)`. Hermes-Argument akzeptiert: das Produkt-SLO ist eine Obergrenze für den Service, kein Mindestwert für den Breaker-Bound. Zusätzlich ist der CB-Trip auf nearest-rank p90 im rollenden Fenster mit `minSamples=5` effektiv das Maximum der letzten fünf Samples, nicht die globale Kalibrierungs-p95.

### 1a. Zweistufige v5.1-Regel

**Stufe A — SLO-Eligibility (Ausschluss-Test)**

Pro Alias werden **vor** dem Kalibrierungs-Run definiert und festgeschrieben:

```
productLatencyCeilingMs        # maximal akzeptable netto Per-Axis-Latenz
requiredHealthyHeadroom        # z. B. 20% oder absoluter Abstand in ms
```

Wenn der gemessene `healthy p95` das `productLatencyCeilingMs` überschreitet:
- **Alias ist NICHT freigabefähig** für den Pfad
- Bound wird nicht hochkalibriert
- v0.4.3.1 blockiert; Ursache Provider- oder Alias-Wahl, nicht CB-Konfiguration

Wenn `healthy p95 + requiredHealthyHeadroom > productLatencyCeilingMs`: kein ausreichender Kopfraum → gleiche Entscheidung.

**Kein nachträgliches Verschieben der Grenze, um den Run grün zu machen.** Die Grenzen werden in einem Config-Freeze-Commit vor Kalibrierungs-Start eingefroren und mit dem Kalibrierungs-Report referenziert.

**Stufe B — exakte CB-Replay-Kalibrierung**

Aus den timestamped per-axis Samples des Kalibrierungs-Runs (workers=1, ≥20 Cases, ≥50 successful samples pro Alias) wird der finale Config-Kandidat durch **direkten Replay in der echten `CircuitBreaker`-Implementation** in Originalreihenfolge validiert.

Zwei diskriminierende Datensätze müssen bestanden werden:

1. **Healthy replay**: Kalibrierungs-Samples in Originalreihenfolge → höchstens vorab hart begrenzter false-trip count (v5.1 verbindlich: `0` für den Kandidatenwert; wenn `1..N` tolerierbar, muss das explizit vorab dokumentiert werden).
2. **Degraded replay/fixture**: definierte langsame/fehlgeschlagene Sequenz — pro Alias eine standardisierte Fixture in Datei `scenarios/cb-degraded-fixtures.json` (Latenz-Sequenzen + Fehler-Patterns) — muss innerhalb des vorab festgelegten `detectionSampleBoundMax` (z. B. „innerhalb `windowSize + minSamples` Samples ab Beginn der Degradation") den CB in OPEN überführen.

Ein Bound-Kandidat, der Healthy nicht trippt, aber Degradation nie erkennt, ist **kein bestandener Kandidat**.

### 1b. Report-Struktur pro Alias

Der Kalibrierungs-Report (`reports/v0431-calibration.md` + Rohdaten JSONL) enthält pro Alias:

- rohe p50/p90/p95/max netto Achsen-Latenz
- gewählter `tripP90LatencyMs`, `probeMaxLatencyMs`, `cooldownMs`, `minSamples`, `windowSize`, `windowAgeMs`
- Healthy-Replay: false-trip count + falls >0 Zeitpunkte + Sample-Index
- Degraded-Replay: time-to-open (Wall-Clock + Sample-Index-to-open)
- HALF_OPEN-Probe-Outcome (im Replay-Setup)
- Flapping-Gegentest: OPEN↔CLOSED-Transitions über N Zyklen einer Grenz-Latenz-Sequenz

### 1c. `probeMaxLatencyMs = tripP90LatencyMs` als Default

Bleibt Default. Aber nicht als mathematischer Beweis. Beide Werte müssen zusammen den Replay + Live-Drill bestehen. Abweichung nur mit explizitem Hysterese-Test in derselben Report-Struktur.

---

## Blocker 2 — Production Factory + Config-Wiring + Fail-closed Validation

Verifiziert (`api/dql/verify.ts:43`, `PotCliCascade`-Default-Konstruktor, `HttpLlmClient`-Default-Konstruktor): heute wird auf Vercel weder `capitalPathMode` noch `disableCircuitBreaker` noch `circuitBreakerConfig` weitergereicht. Die typed Options wären ohne Wiring toter Code.

### 2a. Zentrale Factory

Neue Datei `src/engine/llm-client-factory.ts`:

```typescript
// Signatur (Implementation folgt in PR #12)
export function createProductionLlmClient(env: NodeJS.ProcessEnv): HttpLlmClient;

export interface ResolvedProductionConfig {
  capitalPathMode: boolean;
  disableCircuitBreaker: boolean;
  circuitBreakerConfig: CircuitBreakerConfig;
  circuitBreakerConfigByAlias: Record<string, CircuitBreakerConfig>;
  telemetryHandler: (event: StateTransitionEvent) => void;
  configHash: string;   // hash über die resolved Config für Fingerprint
}
```

**Verantwortlichkeiten**:

- parse/validate ENV einmal beim Cold-Start
- konstruiert `HttpLlmClient` mit allen fünf Feldern
- wird in `PotCliCascade`-Konstruktor injiziert (oder Cascade nimmt eine `LlmClient`-Instanz als Parameter statt eine intern zu erzeugen)
- `api/dql/verify.ts` ruft die Factory einmal (Cold-Start-Cache) und übergibt an Cascade

### 2b. Fail-closed Config-Validation

Vor Konstruktion:

- ungültige Zahl / NaN / negative Bound → `throw new ProductionConfigError(...)`, kein Default
- `probeMaxLatencyMs > tripP90LatencyMs` → reject, außer explizite Env-Variable `DQL_CB_ALLOW_ASYMMETRIC_HYSTERESIS=1` mit vorab dokumentierter Begründung im Config-Commit
- unbekannter Alias in `DQL_CB_CONFIG_BY_ALIAS` (JSON) → reject, kein stilles Ignorieren
- fehlende finale per-Alias-Config nach Aktivierung von v0.4.3.1 (Env-Flag `DQL_V0431_ACTIVE=1`) → reject
- fehlende `productLatencyCeilingMs`/`requiredHealthyHeadroom` bei aktivem v0.4.3.1 → reject

Config-Error führt bei Cold-Start zu Vercel-Deployment-Fehler; kein Runtime-Fallback auf Defaults.

### 2c. Diskriminierender Wiring-Test

Test-Datei `src/engine/llm-client-factory.test.ts` (Teil von PR #12):

- setzt `env` mit swift threshold A ms, nano threshold B ms (A ≠ B)
- konstruiert Client über `createProductionLlmClient(env)`
- simuliert Sequenzen von Achsenanfragen mit deterministischen Latenzen zwischen A und B
- assertions:
  - swift-Alias trippt bei Latenz > A
  - nano-Alias bleibt CLOSED bei derselben Latenz (weil B > A)
  - state-transition-events referenzieren beide unterschiedlichen Bounds
- weiterer Test-Case: ungültige Env-Variable → `createProductionLlmClient` wirft
- weiterer Test-Case: `probeMaxLatencyMs > tripP90LatencyMs` ohne Escape-Flag → wirft

Damit ist bewiesen, dass Env-Werte bis zur State-Machine reichen.

### 2d. Cascade-Integrationstest

Zusätzlich `PotCliCascade` mit gefaktem Client-Path: Cascade delegiert an den via Factory konstruierten Client — kein neuer `new HttpLlmClient()` im Konstruktor. Reihenfolge:

```
verify.ts (cold-start) → createProductionLlmClient(env) → PotCliCascade(client, ...) → engine
```

---

## Blocker 3 — Telemetrie darf niemals Produktverhalten verändern

Verifiziert: `recordSuccess()` läuft innerhalb des `try`-Blocks um `callWithRetry` in `llm-client.ts:340-355`. Ein throw aus `onStateTransition` würde in den catch-Block fallen, `recordFailure(wallClock)` triggern und potentiell Fallback auslösen. Hermes-Blocker ist real.

### 3a. Non-throwing Invariante im CircuitBreaker

`CircuitBreaker` emittiert Events nur über eine private `emit()`-Methode:

```typescript
private emit(event: StateTransitionEvent): void {
  const handler = this.config.onStateTransition;
  if (!handler) return;
  try {
    // Freeze für Sicherheit: Empfänger darf nicht mutieren
    handler(Object.freeze({ ...event }));
  } catch (err) {
    // Best-effort diagnostic. Wir schreiben einen bounded fallback-Log
    // (max 1 Zeile) direkt via console.warn, damit Runtime nicht bricht.
    // NIEMALS rethrow. NIEMALS recordFailure aus diesem Pfad.
    try {
      // eslint-disable-next-line no-console
      console.warn(`[cb:${this.name}] telemetry handler threw; event=${event.cause}`);
    } catch {
      /* even the log fallback is best-effort */
    }
  }
}
```

**Zwei zusätzliche Härtungen**:

1. Event-Objekt wird `Object.freeze()`d bevor es an den Handler geht → Handler kann State nicht mutieren.
2. Handler bekommt eine flache Kopie der Event-Daten (kein interner CB-Zustand).

### 3b. Pflichttest im CB

`src/engine/circuit-breaker.test.ts` erhält:

```
test: onStateTransition throws on every event
  → identischer CB-State
  → identische Success-/Failure-Counts
  → keine zusätzliche recordFailure
  → identischer canProceed()-Rückgabewert
```

Zusätzlich Client-Ebene: `llm-client.recovery-regression.test.ts` erhält Assertion, dass ein werfender Handler `providerRoute` und Call-Output nicht verändert (kein Fallback, keine zweite Provider-Anfrage).

### 3c. Kanonisches Event-Schema

Ein einziges Event pro State-Transition (Hermes-Vorgabe, alte v5-Aufzählung mit sechs Event-Namen ist SUPERSEDED):

```typescript
export interface StateTransitionEvent {
  schema_version: 1;
  event: 'circuit_state_transition';
  alias: string;
  from: CircuitState;        // 'CLOSED' | 'OPEN' | 'HALF_OPEN'
  to: CircuitState;
  cause:
    | 'trip-p90'
    | 'trip-failure-rate'
    | 'cooldown-elapsed'
    | 'probe-success'
    | 'probe-failure'         // Transportfehler in HALF_OPEN
    | 'probe-over-bound';     // Erfolg, aber latency > probeMaxLatencyMs
  reason: string;             // freie Beschreibung wie bestehende lastTripReason
  at: number;                 // via config.now() — dieselbe Clock wie CB-State
  latencyMs?: number;         // bei probe-*
  boundMs?: number;           // bei probe-over-bound
  sampleCount?: number;       // aktuelle Fenster-Größe (umbenannt von windowSize um Verwechslung mit Config-Maximum zu vermeiden)
  windowP90?: number;         // bei trip-p90
  windowFailureRate?: number; // bei trip-failure-rate
  correlationId?: string;     // optional, wenn vom Client durchgereicht
}
```

**Verbotene Felder** (keine Sensitive Data): Prompts, Claims, API-Keys, Response-Inhalte, User-IDs.

**Report-Anzeigenamen** (`half_open_probe_succeeded` etc.) sind Ableitungen aus `from/to/cause` und existieren nur im Report-Renderer, nicht in der Event-Stream-Struktur.

### 3d. Consumer-Persistenz

- Live-Drill: JSONL-Dump direkt in Datei (`runs/v0431-live-drill-<sha>.jsonl`).
- Canary: strukturierter Log in Vercel-Runtime-Log **und** in Consumer-Verifikation-Records (damit 48h abrufbar ist, wenn Vercel-Console-Retention kürzer ist).

---

## Blocker 4 — Canary ist dedizierter Vercel-Endpunkt + paper/shadow Consumer

Verifiziert: kein Prozent-Router im DQL-Repo; Consumer sind getrennte PM2-Arme. Ein PM2-Shadow-Arm gegen `dql.thoughtproof.ai` würde dieselbe serverseitige CB-Konfig sehen wie Production — kein echter Config-Canary.

### 4a. Canary-Mechanik (v5.1 verbindlich)

1. Dediziertes Vercel Canary Deployment/Alias aus dem exakt zu testenden Commit (z. B. `dql-canary.thoughtproof.ai` oder Vercel Preview URL, an eine stabile Canary-Domain aliased).
2. Eigene Env-Config im Vercel Canary Project mit:
   - `capitalPathMode=false` (Ziel: reale P2-korrigiert Resilience)
   - finalen per-Alias-Bounds aus §1
   - v0.4.3.1-Feature-Flags aktiv
3. **Kein Production-Alias-Umschalten**. Der Prod-Endpunkt (`dql.thoughtproof.ai`) bleibt auf der bisherigen sicheren Posture (aktuell `capitalPathMode=true`).
4. Genau ein dedizierter Shadow/Paper-Consumer-Arm PM2 zeigt auf die Canary-URL.
5. Dieser Arm hat **keine Execution-Autorität / kein reales Kapital**. Konfigurationsseitig muss `PAPER_ONLY=1` oder equivalent verifiziert sein.
6. Kontrollarm bleibt auf bisherigem Prod-Endpunkt.
7. 48h Vergleich.
8. Erst nach grüner Canary dieselbe verifizierte Config auf Production ausrollen (Config-Deploy, nicht Code-Deploy).

### 4b. Pre-Start-Verifikation (v5.1 verbindlich)

Vor Canary-Start live verifizieren und im Startup-Report festhalten:

- Canary-Health-Endpoint (`/api/health` oder gleichwertig) liefert `commit_sha` **und** `config_hash` (SHA-256 über resolved Config aus §2a)
- Consumer-Records persistieren tatsächlich die Canary-URL und/oder den `config_hash` pro Verifikation
- `models_used`, `provider_route` und State-Transition-Events landen im Consumer-Record oder in einem abrufbaren Log/Artefakt-Pfad
- `execution_mode = paper` ist nachweislich aus dem Canary-Env-Feld gelesen, nicht aus einem ähnlich benannten Prod-Feld defaulted (Test: gezielte Env-Fehl-Konfig muss Startabbruch produzieren)

### 4c. Rollback

Reversibel via Deployment-Rollback des Canary-Deployments (bricht dedizierten Endpunkt), Umleitung des Consumer-Arms auf Prod (paper-only-Consumer bleibt aber paper), oder Vercel-Alias-Redirect. Kein Prod-Config-Change nötig.

---

## Major 5 — Canary-Safety-Ampeln werden messbar getrennt

V5-Ampel „0 Safety-Regressionen" wird durch drei nachweisbare Kategorien ersetzt.

### 5a. Direkt beobachtbare harte Canary-Invarianten

Alle müssen 48h grün sein (aus Log/Consumer-Record-Traces direkt messbar, keine externe Labelquelle nötig):

- 0 Error→ALLOW: kein Fehler-/Timeout-Pfad liefert im Consumer-Record `verdict = ALLOW`
- 0 fehlende/ungültige Verdicts, die als ALLOW behandelt werden (Consumer-Post-Processing)
- 0 fremde/unvalidierte Provider: `models_used` nur `serv-nano` oder `serv-swift`
- 0 Execution-Autorität im Canary-Arm: `execution_mode = paper` in 100% der Records
- 0 unkorrelierte State-Transitions: jedes `circuit_state_transition`-Event hat einen zeitlich benachbarten Verifikations-Record oder Cooldown-Ablauf-Trigger als Ursache; keine Ghost-Transitions
- 0 Flapping-Serien: keine >3 OPEN↔CLOSED-Transitions pro Alias in 5 Minuten

### 5b. Behavioral Delta gegen Kontrollarm

Auf byte-identischen oder korrelierten Requests (Consumer sendet dieselben Cases an beide Arme):

- Vollständige Liste von BLOCK/UNCERTAIN→ALLOW-Deltas, manuell/gold-basiert reviewt vor Production-Aktivierung
- ALLOW→UNCERTAIN/BLOCK separat ausgewiesen (Recall-Impact-Analyse)
- Route/Latency/Cost-Vergleich per Alias, per Case-Kategorie

Kein Auto-Pass/Auto-Fail; das ist Analyse-Material für Vier-Augen-Review.

### 5c. Periodische Gold-Safety-Suite gegen Canary

Während der 48h mehrfach (v5.1 verbindlich: mindestens alle 6h) die feste adversariale Safety-Suite (100-Case v0.4.1d + adversarial-Ergänzung, konkrete Referenz in Report) gegen den Canary-Endpunkt laufen lassen.

Dort ist `0 BLOCK→ALLOW` tatsächlich messbar, weil Gold-Labels existieren.

Ampel: 0 BLOCK→ALLOW-Regressionen vs. v0.4.1d-Baseline in jeder Iteration.

### 5d. Was Canary-Live-Traffic nicht darf

Canary-Live-Traffic (ohne Gold-Labels) darf **nicht** als Ground-Truth-Safety-Beweis bezeichnet werden. Nur §5a + §5c sind harte Safety-Ampeln; §5b ist Delta-Analyse.

---

## Major 6 — Live-Drill-Grenze präzisiert

V5-§3b wird ersetzt durch:

**Verbindliche Form**:

- Isolierter Drill-Runner (`scripts/v0431-live-drill.mjs`) importiert die echte gebaute `HttpLlmClient`-/CB-Implementation (aus `dist/` oder direkt aus TS über `tsx`).
- Fetch-Wrapper (injiziert via `HttpLlmClientConfig.fetchImpl`) liefert für die definierte Pre-Trip-Sequenz deterministische Fehler/Slow-Samples.
- Danach delegiert derselbe Wrapper an den echten SERV-Endpunkt (`inference-api.openserv.ai/v1`) für die HALF_OPEN-Probe.
- Reale Wall-Clock für Cooldown (keine Zeit-Injektion; `now = Date.now` wie in Prod).
- **Keine öffentliche `forceOpen()`- oder Debug-API** — die Trip-Injection wird ausschließlich über den Fetch-Wrapper erreicht.
- Keine Production-Requests werden manipuliert; Drill hat eigene ephemere Session/Bindings.
- Kompletter JSONL-Trace + Config-Hash + Commit-SHA als Report-Artefakt.

**Gegenlauf-Cases (v5.1 verbindlich)**:

- Probe-Transportfehler → `cause = probe-failure`
- Probe-Erfolg über Bound → `cause = probe-over-bound`
- Beide setzen frischen Cooldown mit korrektem `openedAt`, verifiziert im Trace.

---

## §7 — Antwort auf offene Frage 1 (aktualisiert)

Shallow merge akzeptiert, aber mit fünf Bedingungen (Hermes verbindlich):

1. `undefined` darf keinen globalen Wert unbeabsichtigt löschen: entweder Config normalisieren (undefined keys vor Merge entfernen) oder explizit dokumentiertes Verhalten in `resolveCircuitBreakerConfig()`.
2. `now`, `onStateTransition`, `windowSize`, `windowAgeMs`, `minSamples` können aus der globalen Config kommen; per-Alias überschreibt nur wenn explizit gesetzt.
3. Finale resolved Config pro Alias wird nach dem Merge validiert (fail-closed).
4. Unbekannte Aliases und ungültige Bounds führen nicht still zu Defaults — Config-Error.
5. Diskriminierender Wiring-Test (§2c) beweist echte unterschiedliche Alias-Semantik über den Production-Factory-Pfad.

**Implementation**: explizite Resolver-Funktion statt ad-hoc object spread:

```typescript
// src/engine/circuit-breaker-config-resolver.ts
export function resolveCircuitBreakerConfig(
  alias: string,
  global: CircuitBreakerConfig | undefined,
  byAlias: Record<string, CircuitBreakerConfig> | undefined
): CircuitBreakerConfig;
```

Separat unit-getestet: undefined-drop, alias-override, Validation-Reject.

---

## §8 — PR- und Aktivierungs-Reihenfolge (korrigiert)

V5-§8 wird ersetzt durch die explizite Trennung „PR-Merge-Kriterien" ≠ „Production-Activation-Kriterien":

1. **v5.1-Design freigeben** (dieser Delta-Draft).
2. **PR #11 sauber erstellen** auf `v043-cb-latency-fix-clean` von `main`, nur `0dd07ae` + `cb9d83a`, keine Design-Docs. Tests grün. Review. Merge.
3. **PR #12 als Draft** von frischem `main` implementieren:
   - `circuitBreakerConfigByAlias` + Resolver
   - `onStateTransition` mit Non-Throw-Invariante
   - `createProductionLlmClient` Factory + Fail-closed Validation
   - `PotCliCascade` nimmt Client via DI
   - `api/dql/verify.ts` nutzt Factory
   - 12 Unit/Integration-Tests + Wiring-Tests
   - `llm-client.recovery-regression.test.ts` bleibt (bereits committed)
4. **Tests vollständig grün**.
5. **Aus dem PR-#12-Commit isoliertes Build erzeugen** (`npm run build` auf dem exakten SHA).
6. **Kalibrierung** (§1a Stufe A + Stufe B) + **controlled live-provider drill** (§6) mit **genau diesem SHA**.
7. Rohdaten + Report + Manifest pushen auf `dql-benchmark/main`.
8. **PR #12 Vier-Augen-Review** und Merge.
9. Gemergtes `main` erneut testen (105/105+).
10. Dedizierten Vercel-Canary aus gemergtem SHA deployen.
11. **48h Shadow/Paper Canary** (§4) + **Gold-Safety-Wiederholungen** (§5c).
12. **Erst dann Production-Konfig/Rollout**.
13. Gate 1 kann nach PR #11 und vor oder parallel zu PR #12 laufen, muss aber dieselbe swift-Binding/Prompt-Version zertifizieren, die final deployed wird; bei relevanter Änderung erneut laufen.

**Trennung explizit**:

```
PR #12 merge criteria (Schritt 8):
  - Tests 105/105+ grün
  - Kalibrierungs-Report grün (§1a + §1b)
  - Live-Drill-Report grün (§6)
  - Vier-Augen-Review

Production activation criteria (nach Schritt 12):
  - alles oben +
  - 48h Canary grün (§4 + §5)
  - Gold-Safety-Wiederholungen grün
```

Die 48h-Canary ist kein PR-#12-Merge-Gate — sie ist ein **Production-Activation-Gate**.

---

## §9 — Fünf kleine Korrekturen

1. **Test #1-Präzision**: „5 slow calls → CB=OPEN via **p90-only**" (nicht failure_rate). Erfolgreiche langsame Calls haben `success=true` und tragen nicht zur failure_rate bei; sie trippen ausschließlich über den p90-Latenz-Pfad. Test-Assertion in v5-§3a Tabellenzeile 1 entsprechend korrigiert.

2. **Recovery-Test / Date.now-Monkey-Patching**: `llm-client.recovery-regression.test.ts` restauriert Date.now bereits in `finally`. Zusätzliche Härtung in PR #12:
   - Vitest-Config: sicherstellen dass die drei Tests in dieser Datei **sequenziell** laufen (`test.sequential` oder file-level `describe.sequential`).
   - Pflichttest „Parallel-Test-Leakage-Guard": ein separater Test misst `Date.now()` vor und nach der Test-Datei und asserted, dass es dem realen `Date.now` entspricht (nicht dem gefakten).
   - Mittelfristig (v0.4.4): Latenz-Clock injizieren statt Date.now zu patchen — `HttpLlmClient` bekommt einen optionalen `nowForLatency`-Hook. Nicht Teil von v0.4.3.1.

3. **Unbenutzte Variablen in `llm-client.recovery-regression.test.ts` bereinigen** vor PR #12:
   - `fetchCallLog` und `phase` sind Leftovers aus einer früheren Draft-Version, werden entfernt.
   - Der erste `fetchImpl.mockImplementation` wird direkt mit der finalen Version deklariert, ohne den überschriebenen Zwischenstand.

4. **Telemetrie-Persistenz explizit benennen**: Vercel-Console allein reicht nicht als Gate-Artefakt.
   - Live-Drill: JSONL direkt in `runs/v0431-live-drill-<sha>.jsonl` gepusht auf `dql-benchmark/main` (Auflage-konform).
   - Canary: State-Transition-Events landen im Consumer-Verifikation-Record (persistent) **und** parallel in Vercel-Log-Sink. Der Consumer ist die maßgebliche Quelle für 48h-Retention.

5. **`recoveryMode = KEIN`** entfernen als Config-Feld: v5-§3 „deployte Prod-Konfiguration" listet `recoveryMode = KEIN`. Das ist irreführend — es existiert kein `recoveryMode`-Feld im Code. Ersetzt durch:

   > „Kein `recoveryMode`-Feld; die klassische CB-State-Machine (CLOSED → OPEN → HALF_OPEN → CLOSED/OPEN) ist das Recovery-Verhalten."

---

## §10 — Acceptance-Kriterien für v0.4.3.1-Close (aktualisiert)

**PR #12 Merge-Kriterien** (alle sechs müssen erfüllt sein):

1. PR #11 gemergt auf `main`, 105/105 Tests grün nach Merge.
2. Kalibrierungs-Run gepusht auf `dql-benchmark/main` mit Stufe-A-SLO-Eligibility-Report + Stufe-B-CB-Replay-Report + Rohdaten + Manifest.
3. 12 Unit/Client-Integration-Tests aus v5-§3a (mit Präzisierung §9.1) grün.
4. Wiring-Tests aus §2c + §2d grün.
5. Non-Throw-Telemetrie-Test aus §3b grün.
6. Live-Drill-Report gepusht auf `dql-benchmark/main` mit vollständigen State-Transition-Timestamps + Config-Hash + Commit-SHA.

**Production-Activation-Kriterien** (zusätzlich zu PR-#12-Merge):

7. Gate 1 grün auf dem finalen Merge-SHA (swift-Binding/Prompt-Version).
8. 48h-Canary grün mit allen §5a-Invarianten + §5b-Delta-Review + §5c-Gold-Safety-Wiederholungen alle 6h grün.

Erst nach 8: `capitalPathMode=false` auf Prod-Kapital-Pfaden per Config-Deploy.

---

## §11 — Was v5.1 nicht ändert

- Root-Cause-Analyse aus v5-§0
- Kein neuer Recovery-Code (existing HALF_OPEN state machine)
- P3 verworfen (soft-OPEN)
- kein Router-Kadenz-Change
- kein `recoverFromOpen()`-Public-API
- Retry-Bug adv_084/adv_098 → v0.4.4
- Suite v1.2 → v0.4.4
- AgentDojo Track → nach v0.4.2 stabil

---

## Freigabestatus

Kein PR-#12-Code. Auf Hermes v5.1-Freigabe warten. Nach Freigabe:

1. PR #11 auf sauberem Branch (Schritt 2 aus §8)
2. Danach v5.1 als PR #12 implementieren

Prozess-Regel unverändert: „Fertig" = Code committed + gepusht + Rohdaten + Report + Manifest gepusht.
