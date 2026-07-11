# v0.4.3.1 CB Recovery Fix — v5.2 Delta

**Status**: Delta zu v5.1. Antwort auf Hermes-Review 2026-07-11 (220e1973).
**Priority**: v0.4.3.1 blocking
**Author**: Perplexity
**Date**: 2026-07-11
**Basis**: `v0431-recovery-fix-design.md` (v5) + `v0431-recovery-fix-design-v51-delta.md` (v5.1) bleiben Referenz; dieses Delta ergänzt drei neue Blocker + zwei Majors ehrlich. Kein Rewrite.

---

## Vorab: was Hermes aus v5.1 akzeptiert hat

- SLO als Eligibility-Ceiling statt Bound-Minimum
- Replay gegen echte CB-Implementation mit healthy + degraded Datensatz
- Diskriminierender Degraded-Test
- Zentrale Production Factory + fail-closed Config-Validation
- Per-Alias Resolver mit shallow merge
- Non-throwing Telemetrie
- Ein kanonisches Event pro State-Transition
- Dedizierter Vercel-Canary statt erfundenem Prozent-Router
- Messbare Safety-Invarianten + Gold-Suite
- Präzisierter live-provider Drill
- Trennung PR-#12-Merge vs Production-Aktivierung

Diese Punkte werden in v5.2 nicht neu verhandelt.

---

## Blocker 1 — Vercel macht den CB zu per-Isolate-State

### 1a. Scope-Korrektur (verbindlich)

Der v5.1-Sprachgebrauch „die deployte Prod-Config recovert" ist irreführend. Korrigierte Formulierung für v5.2 und alle nachfolgenden Reports:

> „Jede warme DQL-Serverless-Instanz führt einen unabhängigen per-alias CircuitBreaker. Gate 2 zertifiziert die lokale State-Machine. Die 48h-Canary misst das resultierende verteilte Deployment-Verhalten. **Es gibt keine globale OPEN-Garantie über Instanzen hinweg.**"

Diese Formulierung wird wörtlich in Gate-2-Report, Canary-Report und Aktivierungs-Entscheidungsprotokoll übernommen.

### 1b. Architekturentscheidung — Option I akzeptiert

**Per-isolate best-effort CB. Kein externer shared state in v0.4.3.1.**

Begründung:

- Shared Redis/KV-CB-State würde Atomicity, Leases, TTL, Netzwerkausfälle und neue fail-open/fail-closed-Entscheidungen einführen — eine neue verteilte State-Machine.
- Widerspricht dem bounded P2-korrigiert-Scope.
- Für diesen Release: CB als lokale Schutzschicht; Total-Outage-Sicherheit kommt aus Engine fail-closed, nicht aus globaler CB-Koordination.

### 1c. Multi-Instance-Test (v5.2 verbindlich, PR #12)

Zusätzlich zu den 12 v5-Tests: `src/engine/llm-client-multi-instance.test.ts` — die bewusst akzeptierte Semantik wird explizit dokumentiert, nicht versteckt.

Test-Szenario:

1. Instance A wird konstruiert, erhält Slow-Sequenz → CB trippt.
2. Instance B wird parallel konstruiert, bleibt CLOSED und unabhängig.
3. Instance A routet fallback; B routet primary.
4. A recovert nach Cooldown via HALF_OPEN → CLOSED (existing test-pattern).
5. Instance C wird nach A's Trip neu konstruiert, startet CLOSED/0 Samples — dokumentiert Cold-Start-Reset-Semantik.
6. Assertion: Instance A/B/C-States sind vollständig unabhängig, keine gemeinsamen Samples.

Der Test ist bewusst ein **Semantik-Dokumentations-Test**, nicht ein Regression-Test gegen ein nicht-existierendes globales Verhalten.

### 1d. Deployment-Ebene in Canary (§4 ergänzt)

Die 48h-Canary muss zusätzlich zu §5a-Ampeln aus v5.1 messen und im Report ausweisen:

- **Anteil Requests pro Runtime-Instance-ID** (aus Response-`meta.runtime.instance_id`)
- **CB-State-Snapshot pro Instance-ID und Alias** (aus `meta.runtime.circuit_snapshot_after`)
- **Cold-Start-Count** in 48h
- **`CLOSED with sampleCount=0` nach vorherigem OPEN derselben Config** — Reset-Indikator; deutet auf Instance-Recycling statt zertifizierter HALF_OPEN-Recovery hin
- **Route-Verteilung pro Instance-ID** (`provider_route` × `instance_id`)
- **Sind Degradationsperioden über Instanzen fragmentiert?** — Analyse: läuft ein Provider-Ausfall über mehrere Instanzen, ohne dass irgendeine `minSamples` erreicht?

Keine künstliche Behauptung, Vercel garantiere Sticky Routing. Der Report enthält Rohdaten und Interpretation getrennt.

### 1e. Production-Activation-Hold (v5.2 verbindlich)

Wenn die Canary zeigt:

- Sample-Fragmentierung verhindert Trips praktisch (in einer definierten Degradations-Periode löst kein Isolate einen Trip aus), **oder**
- Instance-Churn hebt Schutzwirkung auf (Cold-Start-Rate so hoch, dass OPEN-Zustand faktisch nie länger als wenige Sekunden hält),

**dann kein CPM=false-Rollout.** Stattdessen separates Design für shared/durable CB oder Wechsel auf stateful Runtime — als eigenständiges Folgeprojekt, nicht als still verankerter TODO in PR #12.

### 1f. Roadmap-Eintrag (nicht Teil von v0.4.3.1)

Als eigenständiges Folgeprojekt (v0.4.4+) im ROADMAP.md verankert:

- Shared/distributed CB (Redis/KV atomic windows)
- distributed HALF_OPEN lease (single-flight probe global)
- TTL/Recovery
- Redis-Outage-Policy (fail-open lokal oder fail-closed?)
- Latency-Overhead-Budget
- Cost-Analyse
- Split-Brain-Vermeidung

Kein Teil von v0.4.3.1.

---

## Blocker 2 — Transition-Events erreichen den Consumer heute nicht

### 2a. Verifiziertes Problem

Aktueller `DqlResponse.meta` (`src/types.ts:158-168`):

```typescript
meta: {
  duration_ms: number;
  models_used: string[];
  axes_evaluated: Axis[];
  sandbox: boolean;
};
```

Kein Feld für Transitions, Circuit-Snapshots, `config_hash`, `commit_sha` oder `instance_id`. Der Consumer kann `onStateTransition`-Events also nicht persistieren.

Zusätzlich Correlation-Problem: `onStateTransition`-Handler wird bei Cold-Start registriert, Client-Singleton bedient parallele Requests. Ein statischer Handler kennt `requestId` nicht.

### 2b. Verbindliche v5.2-Lösung: request-scoped Runtime-Diagnostics

**Kein neuer State-Store, kein Redis, kein externer Sink.** Der Datenpfad läuft durch die bestehende Request-Response.

Architektur:

```
handler (verify.ts)
  → const collector = new RuntimeDiagnosticsCollector(requestId)
  → cascade.evaluate(request, { collector })       // context param
    → llm-client.call(alias, input, { collector }) // context param
      → circuitBreaker emits transition
      → registered per-client handler resolves collector via context
      → collector.push(event)
  → response.meta.runtime = collector.snapshot()
consumer persists meta.runtime verbatim
```

### 2c. Kontext-Passing-Design (v5.2 verbindlich)

**Option gewählt: explizites Context-Objekt durch Engine→Cascade→Client.** Grund: bessere Sichtbarkeit und Testbarkeit als `AsyncLocalStorage`, kein Concurrency-Risiko.

Neue Signaturen (Umsetzung in PR #12):

```typescript
export interface CallContext {
  requestId: string;
  collector: RuntimeDiagnosticsCollector;
  // zukünftig erweiterbar
}

// LlmClient
interface LlmClient {
  call(alias: string, input: LlmCallInput, ctx?: CallContext): Promise<LlmCallOutput>;
}

// Cascade
interface Cascade {
  evaluate(req: DqlRequest, ctx?: CallContext): Promise<AxisResult[]>;
}
```

`ctx?` bleibt optional, damit bestehende Tests und Stub-/Sandbox-Cascade nicht brechen. Wenn `ctx` fehlt, werden Diagnostik-Events verworfen (v5.1-Blocker-3-Konform: non-throwing).

**Kein `AsyncLocalStorage`** in v0.4.3.1. Zukünftige Timer/Background-Probes würden das erfordern, sind aber nicht Teil des Releases (siehe Hermes-Hinweis §Transition-außerhalb-Request-Kontext).

**Keine module-globale mutable Request-ID.** Statischer Lint-Rule-Vorschlag (kann optional in v0.4.4 kommen).

### 2d. RuntimeDiagnosticsCollector

```typescript
// src/engine/runtime-diagnostics.ts
export class RuntimeDiagnosticsCollector {
  private readonly events: StateTransitionEvent[] = [];
  private readonly maxEvents = 32; // bounded
  private truncated = false;

  constructor(public readonly requestId: string) {}

  push(event: StateTransitionEvent): void {
    if (this.events.length >= this.maxEvents) {
      this.truncated = true;
      return;
    }
    this.events.push(Object.freeze({ ...event }));
  }

  snapshot(): RuntimeDiagnostics {
    return {
      schema_version: 1,
      transitions: [...this.events],
      truncated: this.truncated,
    };
  }
}
```

### 2e. Handler-Registrierung: Request-Scope-Lookup

Der `onStateTransition`-Handler wird beim Client konstruiert (Cold-Start-Singleton). Damit er request-scoped funktioniert, wird der Collector durch die Aufrufkette gereicht und der Handler bekommt sowohl das Event als auch den Collector als Parameter:

```typescript
// CB emittiert an einen internen Dispatcher
private emit(event: StateTransitionEvent): void {
  const dispatcher = this.currentDispatcher;
  if (!dispatcher) return;
  try {
    dispatcher(Object.freeze({ ...event }));
  } catch { /* non-throw invariant */ }
}
```

`this.currentDispatcher` wird vor jedem `canProceed`/`recordSuccess`/`recordFailure`-Aufruf **aus dem Client** heraus gesetzt und danach zurückgesetzt — das läuft im synchronen Aufrufpfad einer einzelnen `call()`-Invocation, kein Race-Fenster:

```typescript
// HttpLlmClient.call() (Pseudocode für PR #12)
async call(alias, input, ctx) {
  const cb = this.getBreaker(alias);
  cb.setDispatcher((event) => ctx?.collector.push(event));
  try {
    // canProceed / recordSuccess / recordFailure emittieren synchron
    ...
  } finally {
    cb.clearDispatcher();
  }
}
```

**Concurrency-Test in §2g** beweist, dass parallele `call()`-Aufrufe (echte async parallelism) auf demselben CB-Objekt keine Cross-Contamination erzeugen. Falls dieser Test scheitert (weil zwei `call()`s auf demselben Alias in async concurrent verschränkt sind), fällt der Fix auf: **eigener Dispatcher pro `call()` als lokales Closure**, nicht auf CB-Feld:

```typescript
// Fallback-Design falls Concurrency-Test rot:
canProceed(dispatcher?: (e: StateTransitionEvent) => void): boolean
recordSuccess(latencyMs: number, dispatcher?: ...): void
recordFailure(latencyMs: number, dispatcher?: ...): void
```

Vor PR #12 wird der Concurrency-Test entscheiden welcher Weg verwendet wird. Beide Varianten sind lint-sauber und ohne globalen Mutable State.

### 2f. Bounded Response-Schema

Neue Erweiterung von `DqlResponse.meta` (env-gated, default OFF via `DQL_RUNTIME_DIAGNOSTICS=1`):

```typescript
export interface DqlResponse {
  id: string;
  version: string;
  axes: AxisResult[];
  aggregate: AggregateResult;
  meta: {
    duration_ms: number;
    models_used: string[];
    axes_evaluated: Axis[];
    sandbox: boolean;
    runtime?: RuntimeDiagnostics;      // NEU, optional, env-gated
  };
}

export interface RuntimeDiagnostics {
  schema_version: 1;
  commit_sha: string;
  config_hash: string;
  instance_id: string;                  // ephemeral per Cold Start
  cold_start_at: number;                // Cold-Start-Timestamp
  transitions: StateTransitionEvent[];
  circuit_snapshot_after: Record<string, CircuitSnapshot>;
  truncated: boolean;
}

export interface CircuitSnapshot {
  state: 'CLOSED' | 'OPEN' | 'HALF_OPEN';
  sampleCount: number;                  // aktuelle Fenster-Größe (nicht Config-Maximum)
  windowP90Ms?: number;
  windowFailureRate?: number;
  openedAt?: number;
  cooldownRemainingMs?: number;
  lastTripReason?: string;
}
```

**Regeln**:

- Keine Prompts, Claims, API-Keys, User-IDs, Provider-Rohantworten
- Harte Grenze: `maxEvents = 32` pro Response
- `truncated: true` wenn die Grenze erreicht wurde
- `instance_id` ist ephemeral (random UUID beim Cold-Start), keine Infrastruktur-Metadaten
- `cold_start_at` = Cold-Start-Timestamp; `cold_start_id` als separates Feld nicht nötig (Hermes-Vorschlag akzeptiert: `instance_id` reicht)
- Feld nur wenn `DQL_RUNTIME_DIAGNOSTICS=1` gesetzt ist (Canary-Env)
- OpenAPI wird in PR #12 aktualisiert (falls öffentlich verfügbar); default OFF → kein Contract-Break für bestehende Konsumenten

### 2g. Pflichttests (v5.2 verbindlich, PR #12)

Aus Hermes verbatim übernommen:

1. **Concurrency-Sicherheit**: Zwei parallele Requests mit unterschiedlichen IDs und unterschiedlichen CB-Ereignissen → keine Cross-Contamination im jeweiligen Collector.
2. Transition-Event erscheint im richtigen Response-Collector.
3. Keine Transition → leeres `transitions`-Array (feature-consistent) oder Feld absent (wenn Diagnostics OFF).
4. Event-Cap: >32 Transitionen → `truncated: true`, erste 32 Events präsent.
5. **Diagnostic mode OFF**: bisheriger Response-Contract byte-/shape-kompatibel; `meta.runtime` absent, keine anderen Felder verändert.
6. Consumer-Test (paper/shadow): `meta.runtime` wird tatsächlich im persistenten Verifikations-Record gespeichert.
7. **Telemetry-handler wirft**: Produktoutput/CB-State unverändert; `meta.runtime.transitions` darf leer sein, `verdict` nicht.

### 2h. Alternative Sinks

Ein vorhandener Vercel Log Drain / Axiom / Datadog-Sink wäre möglich, ist aber im aktuellen Stack nicht nachgewiesen. **v5.2 setzt keinen externen durable Sink voraus.** Falls in PR #12 einer verifiziert vorhanden ist, kann er zusätzlich parallel geschrieben werden — aber die Response-`meta.runtime` bleibt die maßgebliche Quelle.

---

## Blocker 3 — Health-Fingerprint via gemeinsamem Resolver

### 3a. Verifiziertes Problem

`api/dql/health.ts` liefert heute:

```json
{"status":"ok","service":"decision-quality-layer","version":"0.2.0","timestamp":"..."}
```

Es ist eine **separate Vercel Function** von `api/dql/verify.ts`. Kein CB-Zugriff, kein gemeinsames Client-Singleton garantiert.

### 3b. V5.2-Regel

Health liefert ausschließlich **statische Deployment-/Config-Identität**:

```typescript
{
  status: 'ok' | 'config_invalid';
  service: 'decision-quality-layer';
  version: string;
  commit_sha: string;
  config_hash: string;
  config_schema_version: number;
  v0431_active: boolean;
  timestamp: string;
}
```

**Keine Circuit-State-Auslieferung** aus Health. Es hätte keine Bedeutung, weil Verify-Isolate und Health-Isolate verschiedene Speicher haben.

### 3c. Gemeinsamer Config-Resolver

Neue Datei `src/engine/production-config.ts` (in PR #12):

```typescript
// Pure function — kein Client, kein CB, keine Seiteneffekte
export function resolveProductionConfig(env: NodeJS.ProcessEnv): ResolvedProductionConfig;
export function computeConfigHash(config: ResolvedProductionConfig): string;
```

Sowohl `verify.ts` als auch `health.ts` rufen dieselbe pure Funktion. Keine zweite handgeschriebene Env-Interpretation.

**Wenn `resolveProductionConfig` wirft** (Config-Error), gibt Health `status: 'config_invalid'` mit HTTP 503. Verify wirft im Handler und liefert 500 mit `code: 'CONFIG_INVALID'`.

### 3d. Config-Hash-Berechnung (kanonisch)

`computeConfigHash` produziert einen SHA-256 über canonical JSON:

```typescript
export function computeConfigHash(config: ResolvedProductionConfig): string {
  const canonical = canonicalize(sanitize(config));
  return sha256Hex(canonical);
}
```

Wo:

- **`sanitize()`** entfernt: `now` (Funktion), `onStateTransition` (Funktion), API-Keys, sekret-haltige URLs, `fetchImpl`, `sleep`.
- **`canonicalize()`** produziert JSON mit alphabetisch sortierten Object-Keys, normalisierten Zahlen (kein `1e6`, sondern `1000000`), sortierten Alias-Keys.
- **`sha256Hex`** via Node `crypto.createHash('sha256')`.

### 3e. Pflichttests (v5.2 verbindlich, PR #12)

```
1. same env → health resolver hash == verify factory resolved hash
2. one bound changed → hash changes
3. key order in Env-JSON changed → hash STABLE (canonical serialization)
4. SERV_API_KEY changed → hash UNCHANGED (secret ausgeschlossen)
5. resolveProductionConfig throws → health returns 503 config_invalid;
   verify returns 500 CONFIG_INVALID
6. computeConfigHash produces identical hash for byte-identical resolved config
```

### 3f. Pre-Start-Probe

V5.1 nannte `/api/health`. Korrektur: **`/dql/health`** (verifiziert der reale Pfad). Live Pre-Start-Verifikation des Canary-Deployments:

```
1. GET /dql/health
2. assert commit_sha == expected canary commit SHA
3. assert config_hash == expected canary config hash (aus Deployment-Manifest)
4. assert v0431_active == true
5. assert status == 'ok'
```

Erst nach diesen Assertions wird der Vercel-Alias auf das Canary-Deployment gesetzt (siehe §4a).

---

## Major 4 — Vercel-Config-Failure realistisch behandeln

### 4a. Korrektur

V5.1-Formulierung „Config-Error führt bei Cold-Start zu Vercel-Deployment-Fehler" ist falsch. Vercel kann Build erfolgreich deployen und erst beim ersten Request instanziieren.

### 4b. Preflight-Pipeline (v5.2 verbindlich)

Mehrstufige Verteidigung:

1. **CI-Schritt `validate-production-config`**: `npm run validate:prod-config` läuft in GitHub Actions vor Deploy. Nutzt `resolveProductionConfig` mit dem Env-Shape des Ziel-Environments (Secrets als Placeholder). Fehlerhafte Env-Struktur → CI-Fail, kein Deploy.

2. **Vercel Deploy**: Läuft trotzdem, weil Secrets in Vercel-Env liegen und nicht im CI.

3. **Function Cold-Start**: `verify.ts` und `health.ts` rufen `resolveProductionConfig(process.env)` beim ersten Import. Bei Config-Error:
   - `verify.ts`: Handler liefert `500 CONFIG_INVALID` für alle Requests.
   - `health.ts`: liefert `503 config_invalid` mit `code: 'CONFIG_INVALID'` und Detail-Feld (ohne Secrets).

4. **Pre-Alias-Probe** (v5.2 verbindlich): Vor Setzen des Vercel-Alias auf ein neues Canary-Deployment:
   - GET `/dql/health` gegen die Vercel-Preview-URL
   - assert status == 'ok', commit/config hashes stimmen mit Deployment-Manifest überein
   - **Nur bei grüner Probe** wird der Canary-Alias gesetzt.
   - Fehlt commit_sha, ist config_hash `unknown`, oder ist status `config_invalid`: Preflight fail, kein Alias-Switch.

### 4c. Keine falschen Behauptungen

Kein Text in v5.2/PR-#12/Reports schreibt „Vercel deployment fails" ohne zu erklären, dass das nur mit Preflight erreicht wird.

---

## Major 5 — Kanonische Config-Hash und Commit-SHA

### 5a. Spezifikation (bereits in §3d/§3e umgesetzt, hier verbindlich fixiert)

```
computeConfigHash:
  SHA-256 über canonical JSON
  nur resolved non-secret config
  alphabetisch sortierte Object-Keys
  Zahlen als JSON numbers (keine Exponentschreibweise)
  Alias-Keys sortiert
  keine Functions (now, onStateTransition callbacks)
  keine API-Keys, keine environment-specific secret URLs
```

### 5b. Commit-SHA

- Build-Time-Env: `VERCEL_GIT_COMMIT_SHA` (von Vercel automatisch gesetzt) ODER explizit via `DQL_COMMIT_SHA=$(git rev-parse HEAD)` injiziert
- **Nicht** aus lokalem Git zur Runtime auslesen
- Fehlt `commit_sha` im Canary → Preflight fail (§4b Punkt 4). Kein `unknown` akzeptieren.

### 5c. Manifest-Konsistenz

Deployment-Manifest (im `dql-benchmark`-Repo als Teil des Canary-Startup-Reports):

```yaml
canary:
  commit_sha: <SHA>
  config_hash: <SHA-256>
  vercel_deployment_url: https://...
  canary_alias: dql-canary.thoughtproof.ai
  paper_consumer_pm2_id: <id>
  control_consumer_pm2_id: <id>
  started_at: <ISO>
```

Live-Probe vor Canary-Start prüft byte-genaue Übereinstimmung zwischen Manifest und `/dql/health`-Response.

---

## §6 — Aktualisierte Acceptance-Kriterien

**PR #12 Merge-Kriterien** (v5.2 verbindlich, ersetzt v5.1 §10 Punkte 1-6):

1. PR #11 gemergt, Tests grün.
2. Kalibrierungs-Report grün (v5.1 §1a + §1b).
3. Alle Unit/Client-Integration-Tests grün, inkl.:
   - 12 aus v5.1
   - Multi-Instance-Test aus §1c
   - Concurrency-Test aus §2g Punkt 1
   - Diagnostic-mode-OFF-Contract-Test aus §2g Punkt 5
   - Werfender-Handler-Test aus §2g Punkt 7
   - Config-Hash-Reproduzierbarkeit aus §3e
4. Wiring-Tests aus v5.1 §2c + §2d grün.
5. Live-Drill-Report grün (v5.1 §6).
6. Health/Verify-Config-Hash-Identität verifiziert (Test aus §3e).
7. Preflight-Pipeline aus §4b vollständig implementiert und in CI grün.

**Production-Activation-Kriterien** (zusätzlich zu PR-#12-Merge, ersetzt v5.1 §10 Punkte 7-8):

8. Gate 1 grün auf finalem Merge-SHA.
9. **48h-Canary aus Vercel-Canary-Deployment gemergtem SHA** grün mit:
   - v5.1 §5a Invarianten
   - v5.1 §5c Gold-Suite alle 6h grün
   - §1d Deployment-Ebene: Cold-Start-Count/Reset-Indikatoren/Fragmentierungs-Analyse dokumentiert und nicht disqualifizierend (§1e)
10. Behavioral Delta gegen Kontrollarm reviewt (§5b aus v5.1).
11. Pre-Alias-Probe grün gegen Canary-URL bevor Traffic startete (§4b Punkt 4).

Erst nach 11: `capitalPathMode=false` auf Prod-Kapital-Pfaden per Config-Deploy.

---

## §7 — PR #11 Freigabestatus

Nach v5.2-Freigabe darf PR #11 sofort auf sauberem Branch erstellt werden. Die neuen Blocker aus v5.2 betreffen PR #12/Canary, nicht den isolierten PR-#11-Latency-Fix.

Reihenfolge unverändert:

1. v5.2 freigeben
2. PR #11 auf `v043-cb-latency-fix-clean` von `main`, nur `0dd07ae` + `cb9d83a`, keine Design-Docs → tests → review → merge
3. PR #12 Draft von frischem `main` mit v5 + v5.1 + v5.2 vereint

**Noch kein PR-#12-Code vor v5.2-Freigabe.**

---

## §8 — Was v5.2 nicht ändert

- Root-Cause-Analyse (v5 §0)
- Kein neuer Recovery-Code (existing HALF_OPEN state machine)
- P3 verworfen (soft-OPEN)
- Kein Router-Kadenz-Change
- Bound-Ableitung (v5.1 §1)
- Factory-Architektur (v5.1 §2, jetzt um Preflight §4b + gemeinsamen Resolver §3c erweitert)
- Non-throwing Telemetrie (v5.1 §3)
- Canary-Mechanik-Kern (v5.1 §4, jetzt um §1d Deployment-Messungen + §3f Pre-Start-Probe erweitert)
- Safety-Ampeln (v5.1 §5)
- Live-Drill (v5.1 §6)
- Shallow-Merge-Resolver (v5.1 §7)
- Fünf kleine Korrekturen (v5.1 §9)

---

## §9 — Explizite Roadmap für v0.4.4+

Aus v5.2 als eigenständiges Folgeprojekt verankert:

1. **Distributed CB** (shared state über Isolates)
2. **AsyncLocalStorage** oder anderer request-scope-Ansatz falls Timer/Background-Probes eingeführt werden
3. **Latenz-Clock-Injection** in HttpLlmClient statt Date.now-Monkey-Patch (v5.1 §9.2)
4. **Lint-Rule** gegen module-globale mutable Request-ID
5. **OpenAPI-Update** für `meta.runtime` falls Feld stabilisiert und für externe Konsumenten geöffnet wird
6. **External durable sink** (Axiom/Datadog/Vercel Log Drain), verifiziert und getestet

---

## Freigabestatus

Kein PR-#12-Code. Kein PR #11 vor v5.2-Freigabe. Auf Hermes v5.2-Review warten.

Prozess-Regel unverändert: „Fertig" = Code committed + gepusht + Rohdaten + Report + Manifest gepusht.

Sieben Punkte aus Hermes-Freigabestatus wurden verbindlich adressiert:

1. Per-isolate CB ist bewusster Scope → §1a + §1b
2. Multi-instance/Cold-start-Semantik getestet und in Canary gemessen → §1c + §1d
3. Request-scoped Transport der Transition-/Snapshot-Diagnostik → §2b–§2f
4. Kein mutable global request context; Parallelitäts-Gegentest → §2c + §2g Punkt 1
5. Health nutzt gemeinsamen pure Resolver, zeigt nur statische Config-/Commit-Identität → §3a–§3c
6. Vercel Config-Validation braucht Preflight + Health/Alias-Gate → §4b
7. Canonical non-secret config hash + build-time commit SHA → §3d + §5

Kein neuer State-Store, kein Prozent-Router.
