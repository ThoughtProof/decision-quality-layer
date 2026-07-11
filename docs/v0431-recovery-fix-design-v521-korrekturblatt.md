# v0.4.3.1 CB Recovery Fix — v5.2.1 Korrekturblatt

**Status**: Korrekturblatt zu v5.2. Antwort auf Hermes-Review 2026-07-11 (71444f62).
**Priority**: v0.4.3.1 blocking
**Author**: Perplexity
**Date**: 2026-07-11
**Basis**: v5, v5.1, v5.2 bleiben Referenz. v5.2.1 ist ein präzises Korrekturblatt mit sieben Punkten. Kein Rewrite.
**Scope**: PR #12 nur. PR #11 hat separate CODE-GO-Freigabe erhalten (siehe §8).

---

## Vorab: was Hermes aus v5.2 akzeptiert hat

Sieben Punkte aus v5.1-Review inhaltlich korrekt behoben:

1. Per-Isolate-CB ehrlich als best-effort Scope
2. Kein Shared State in v0.4.3.1
3. Multi-Instance-/Cold-Start-Semantik als bewusster Test
4. Request-scoped Diagnostics statt globaler Request-ID
5. Health zeigt nur statische Deployment-/Config-Identität
6. Vercel Preflight + Health/Alias-Gate
7. Kanonischer non-secret Config-Hash + Build-Time Commit-SHA

Diese Punkte werden in v5.2.1 nicht neu verhandelt. Auch die Production-Activation-Holds bei Fragmentierung/Churn bleiben unverändert.

---

## Korrektur 1 — Call-lokaler Sink statt CB-Dispatcher-Feld

### 1a. Verworfen aus v5.2 §2e

Der v5.2-Vorschlag mit `cb.setDispatcher() / cb.clearDispatcher()` und `this.currentDispatcher` ist **aus dem Kontrollfluss heraus deterministisch concurrency-unsicher** und wird verworfen. Das v5.2-Fallback-Design (Sink als Methodenparameter) wird stattdessen zum **primären Design**. Kein Concurrency-Test entscheidet mehr zwischen zwei Optionen — nur der sichere Weg wird implementiert.

### 1b. Race-Nachweis (aus Hermes verbatim akzeptiert)

```
Request A / axis 1:
  cb.setDispatcher(A)
  await fetch(A)                  ← gibt Event Loop frei

Request B / axis 1:
  cb.setDispatcher(B)
  await fetch(B)

fetch(A) beendet zuerst:
  cb.recordSuccess(...)
  emit() liest currentDispatcher = B
  → A-Event landet in B-Collector

A finally:
  cb.clearDispatcher()

fetch(B) beendet:
  cb.recordSuccess(...)
  → Dispatcher fehlt, B-Event geht verloren
```

`try/finally` beseitigt nur den Feldwert am Ende; es verhindert kein async Interleaving während `await`.

### 1c. Verbindliches Design

```typescript
// src/engine/circuit-breaker.ts (v5.2.1 verbindlich)
export type TransitionSink = (event: StateTransitionEvent) => void;

export class CircuitBreaker {
  // KEIN currentDispatcher-Feld. KEIN setDispatcher/clearDispatcher.

  canProceed(sink?: TransitionSink): void;
  recordSuccess(latencyMs: number, sink?: TransitionSink): void;
  recordFailure(latencyMs: number, sink?: TransitionSink): void;

  // Interne Methoden propagieren denselben Sink call-lokal:
  private trip(reason: TripReason, sink?: TransitionSink): void;
  private close(cause: CloseCause, sink?: TransitionSink): void;
  private emit(event: StateTransitionEvent, sink?: TransitionSink): void;
}
```

`HttpLlmClient.call(alias, input, ctx)` erzeugt genau einen lokalen non-throwing Sink und übergibt ihn explizit:

```typescript
// src/engine/llm-client.ts (v5.2.1 verbindlich, Pseudocode für PR #12)
async call(alias: string, input: LlmCallInput, ctx?: CallContext): Promise<LlmCallOutput> {
  const sink: TransitionSink | undefined = ctx?.collector
    ? (event) => ctx.collector!.push(event)
    : undefined;

  const primaryBreaker = this.getBreaker(alias);

  try {
    primaryBreaker.canProceed(sink);
  } catch (err) {
    if (err instanceof CircuitOpenError) {
      // Fallback-Pfad: neuer Sink-Aufruf auf fallback-Breaker
      if (this.capitalPathMode) {
        throw new CircuitAllOpenError(...);
      }
      return await this.callViaFallback(alias, binding, input, err.reason, sink);
    }
    throw err;
  }

  const started = Date.now();
  try {
    const out = await this.callWithRetry(binding, input);
    const netLatency = Math.max(0, (Date.now() - started) - (out.backoffWaitedMs ?? 0));
    primaryBreaker.recordSuccess(netLatency, sink);
    return { ...out, providerRoute: 'primary' };
  } catch (err) {
    primaryBreaker.recordFailure(Date.now() - started, sink);
    if (primaryBreaker.snapshot().state === 'OPEN') {
      if (this.capitalPathMode) throw new CircuitAllOpenError(...);
      return await this.callViaFallback(alias, binding, input, ..., sink);
    }
    throw err;
  }
}
```

Der Sink lebt **ausschließlich im Stack-Frame der laufenden `call()`-Invocation**. Kein CB-Feld, kein module-globaler State, kein AsyncLocalStorage.

### 1d. Non-throwing doppelt absichern

- `CircuitBreaker.emit(event, sink)` fängt Sink-Fehler mit `try/catch`.
- `RuntimeDiagnosticsCollector.push()` selbst wirft nicht (Bounded-Array + Truncation-Flag statt Throw).
- Ein werfender Sink verändert weder State noch Routing noch Verdict.

### 1e. Pflichttest (bleibt Pflicht als Verifikation, nicht als Wahl)

Der Concurrency-Test aus v5.2 §2g Punkt 1 bleibt Pflicht. Er verifiziert, dass das gewählte call-lokale Sink-Design korrekt funktioniert, nicht mehr um zwischen zwei Optionen zu entscheiden.

---

## Korrektur 2 — Echte Cascade-Signatur

### 2a. Verifiziertes Interface

`src/engine/cascade.ts:16-28`:

```typescript
export interface CascadeInput {
  axis: Axis;
  prompt: AxisPrompt;
}

export interface CascadeOutput {
  result: AxisResult;
  modelsUsed: string[];
}

export interface Cascade {
  run(input: CascadeInput): Promise<CascadeOutput>;
}
```

Engine-Pfad `src/engine/index.ts:57`:

```typescript
return await cascade.run({ axis, prompt });
```

### 2b. Verworfen aus v5.2 §2c

Der v5.2-Vorschlag `cascade.evaluate(req, ctx)` ist eine erfundene Signatur. Wird verworfen.

### 2c. Verbindliche minimale Signaturänderung

```typescript
// src/engine/call-context.ts (neu)
export interface CallContext {
  requestId: string;
  axis?: Axis;                                  // hinzugefügt aus Hermes §Major 3
  callId?: string;                              // hinzugefügt aus Hermes §Major 3
  collector?: RuntimeDiagnosticsCollector;
}

// src/engine/cascade.ts (erweitert)
export interface CascadeInput {
  axis: Axis;
  prompt: AxisPrompt;
  ctx?: CallContext;                            // NEU, optional
}

// src/engine/llm-client.ts (erweitert)
export interface LlmClient {
  call(
    modelAlias: string,
    input: LlmCallInput,
    ctx?: CallContext,                          // NEU, optional
  ): Promise<LlmCallOutput>;
}
```

`CascadeOutput` bleibt unverändert (Diagnostics werden über den Collector im ctx-Feld transportiert, nicht als Rückgabewert).

### 2d. Engine-Integration (PR #12)

`src/engine/index.ts`:

```typescript
export async function runVerification(input: EngineInput): Promise<DqlResponse> {
  const requestId = generateRequestId();
  const collector = ENV.DQL_RUNTIME_DIAGNOSTICS === '1'
    ? new RuntimeDiagnosticsCollector(requestId)
    : undefined;

  const axes = input.axes;
  const axisResults = await Promise.all(
    axes.map(async (axis) => {
      const callId = generateCallId();
      const ctx: CallContext = { requestId, axis, callId, collector };
      return cascade.run({ axis, prompt, ctx });
    })
  );

  // ... aggregation

  return {
    ...,
    meta: {
      ...existing,
      ...(collector ? { runtime: buildRuntimeDiagnostics(collector, client) } : {}),
    },
  };
}
```

### 2e. PotCliCascade-Integration

`src/engine/cascade-pot.ts`:

```typescript
async run(input: CascadeInput): Promise<CascadeOutput> {
  const { axis, prompt, ctx } = input;
  // ...
  const out = await this.callAxis(alias, axis, prompt, ctx);
  // ...
}

private callAxis(alias: string, axis: Axis, prompt: AxisPrompt, ctx?: CallContext) {
  return this.client.call(alias, llmInput, ctx);
}
```

### 2f. Stub/Sandbox

`StubCascade` und `SandboxCascade` ignorieren `ctx` — keine unnötige Signaturfamilie. Bestehende Tests brechen nicht, weil `ctx?` optional bleibt.

---

## Korrektur 3 — Semantik von `circuit_snapshot_after`

### 3a. Verifiziertes Problem

Nach `Promise.all` erfasst der Handler einen Snapshot des gemeinsam genutzten Clients. Bei überlappenden Requests kann dieser Snapshot Samples enthalten, die durch andere Requests derselben warmen Instanz entstanden sind.

Das ist für Deployment-Beobachtung nützlich, darf aber nicht als "ausschließlich durch diesen Request erzeugter Zustand" beschrieben werden.

### 3b. Verbindliche v5.2.1-Umbenennung

Das Feld in `RuntimeDiagnostics` heißt in Zukunft:

```typescript
export interface RuntimeDiagnostics {
  schema_version: 1;
  commit_sha: string;
  config_hash: string;
  instance_id: string;
  cold_start_at: number;
  transitions: StateTransitionEvent[];
  isolate_circuit_snapshot_observed_after: Record<string, CircuitSnapshot>;  // umbenannt
  truncated: boolean;
}
```

**Docstring**:

> Best-effort snapshot of the shared in-memory breaker state observed by this request after its axis work completed; it may include effects from concurrently executing requests in the same isolate.

### 3c. Transition-Attribution bleibt request-scoped

Transitions im Collector sind weiterhin sauber request-korreliert, weil sie über den call-lokalen Sink aus Korrektur 1 gepusht werden. Kein State-Bleed.

### 3d. Erweiterung der StateTransitionEvent

Für exakte Attribution zusätzlich pro Event:

```typescript
export interface StateTransitionEvent {
  schema_version: 1;
  event: 'circuit_state_transition';
  alias: string;
  from: CircuitState;
  to: CircuitState;
  cause: TransitionCause;
  reason_code?: string;                 // v5.2.1 §7 kleine Korrektur 3
  at: number;
  latencyMs?: number;
  boundMs?: number;
  sampleCount?: number;
  windowP90?: number;
  windowFailureRate?: number;

  // NEU (v5.2.1)
  requestId?: string;                   // aus ctx
  axis?: Axis;                          // aus ctx (Hermes §Major 3)
  callId?: string;                      // aus ctx (Hermes §Major 3)
}
```

Keine Payload-Inhalte (Prompts, Claims, API-Keys, User-IDs) — bleibt aus v5.1/§3c unverändert.

### 3e. Engine-Kontext pro Achse

`runVerification` erzeugt pro Achse ein Child-Context mit stabiler `axis` und frischer `callId`. Fünf parallele Achsen desselben Requests sind so unterscheidbar (siehe Korrektur 4 Test).

---

## Korrektur 4 — HALF_OPEN-Single-flight bei fünf parallelen Achsen

### 4a. Verifiziertes Semantik-Bild

`src/engine/index.ts:57` startet fünf Achsen parallel über `Promise.all`. Nach Cooldown:

1. Erste Achse ruft `canProceed()` → transitioniert OPEN → HALF_OPEN → wird Probe
2. Achsen 2-5 rufen `canProceed()` → sehen HALF_OPEN → werden abgewiesen (throw `CircuitOpenError`)
3. Bei `capitalPathMode=false`: Achsen 2-5 gehen auf Fallback
4. Bei `capitalPathMode=true`: Achsen 2-5 werden fail-closed (`CircuitAllOpenError` → engine mappt auf `UNCERTAIN@0`)

Das ist erwartete existierende Semantik, hat aber sichtbaren Verdict-/Route-Impact auf denselben Request.

### 4b. Pflicht-Integrationstest (v5.2.1 verbindlich, PR #12)

Neue Datei `src/engine/engine-half-open-single-flight.test.ts`:

**Setup**: Fake-Clock, injizierte Slow-Sequenz um CB zu trippen, dann Cooldown-Ablauf, dann fünf-Achsen-Verifikation.

**Assertions bei `capitalPathMode=false`**:

- Genau eine Achse hat `providerRoute='primary'` (die HALF_OPEN-Probe)
- Höchstens vier Achsen haben `providerRoute='fallback'`
- Keine zweite HALF_OPEN-Probe: nur eine `probe-started`-Transition im Collector
- Alle Events im richtigen Request-/Axis-Collector (via `requestId`, `axis`, `callId`)
- Aggregierter Verdict bleibt fail-safe (BLOCK/UNCERTAIN, niemals ALLOW aus Fehler-Pfad)

**Assertions bei `capitalPathMode=true`**:

- Genau eine Achse hat `providerRoute='primary'` (die HALF_OPEN-Probe)
- Null Achsen haben `providerRoute='fallback'`
- Vier Achsen erhalten `CircuitAllOpenError` → gemappt auf `UNCERTAIN@0`
- Aggregierter Verdict bleibt fail-safe

### 4c. Live-Drill-Report-Präzision

Der Live-Drill-Report (v5.1 §6) muss die Mischroute ehrlich ausweisen:

- „Der Request recovert auf Primary" bedeutet **nicht**, dass alle fünf Achsen dieses einen Requests Primary nutzten.
- Report zeigt pro Request: N_axes_primary / N_axes_fallback / N_axes_fail_closed
- Report zeigt: nach wie vielen Requests ab dem ersten HALF_OPEN-Probe-Erfolg die Route vollständig auf Primary geht

Das Recovery-Zeitfenster ist damit "erste erfolgreiche Probe → nachfolgende Requests komplett Primary", nicht "alle Achsen desselben Requests sind Primary".

---

## Korrektur 5 — Mode-aware Config-Validation

### 5a. Verifizierter Modus-Zoo

`api/dql/verify.ts:43`:

```
DQL_CASCADE=stub      → StubCascade (default)
DQL_CASCADE=pot-cli   → PotCliCascade (live LLM)
sandbox: true         → SandboxCascade (regardless of DQL_CASCADE)
```

Die strikte v0.4.3.1-CB-Config darf lokale Stub-/CI-Pfade nicht grundlos unstartbar machen.

### 5b. Verbindliche Validation-Matrix

| DQL_CASCADE | DQL_V0431_ACTIVE | sandbox | CB-Config erforderlich | Verhalten |
|---|---|---|---|---|
| `stub` | not set / 0 | any | nein | Defaults ok |
| `stub` | `1` | any | nein | v0431 ist irrelevant für Stub |
| `pot-cli` | not set / 0 | false | nein | v0.4.3-Verhalten |
| `pot-cli` | `1` | any | **JA vollständig** | Canary/Prod-Pfad |
| any | any | true | nein für Sandbox-Aufruf, JA für Cold-Start-Live-Service | Sandbox bypassed CB, aber Live-Service-Config wurde beim Cold-Start bereits validiert |

**Konkret** (v5.2.1 verbindlich):

- Wenn `DQL_V0431_ACTIVE=1` **und** `DQL_CASCADE=pot-cli`: `resolveProductionConfig` **muss** vollständige per-Alias-Config (`circuitBreakerConfigByAlias` für serv-nano und serv-swift), gültige `productLatencyCeilingMs`, `requiredHealthyHeadroom` und `DQL_RUNTIME_DIAGNOSTICS=1` (siehe Korrektur 7 Punkt 5) auflösen können. Fehlt eines: Config-Error, Health = 503 `CONFIG_INVALID`, Verify = 503 (siehe Korrektur 7 Punkt 1).

- Wenn `DQL_V0431_ACTIVE=1` **und** `DQL_CASCADE=stub`: v0431-Flag ist ohne Wirkung; Stub braucht keine CB-Config. Health = ok, aber `config_hash` reflektiert die geladenen v0431-Werte nicht (weil sie ignoriert wurden). Der Health-Response enthält zusätzlich `active_cascade: 'stub'`, damit Preflight-Probes das erkennen können.

- Wenn `DQL_CASCADE=pot-cli` **und** `DQL_V0431_ACTIVE` fehlt: v0.4.3-Verhalten (kein per-Alias, kein Diagnostics). Health = ok. Kein CPM=false erlaubt (implizit).

- Für **`sandbox: true`**-Aufrufe: SandboxCascade wird verwendet, aber Cold-Start hat bereits `resolveProductionConfig` gegen den DQL_CASCADE-Wert validiert. Sandbox darf einen Live-Service mit ungültiger Prod-Config nicht "durchbrechen".

### 5c. Pflichttests

Test-Datei `src/engine/production-config.test.ts` erhält die vollständige Matrix als parametrisierten Test. Mindestens fünf Fälle:

1. `DQL_CASCADE=stub`, `DQL_V0431_ACTIVE=0`, sandbox=false → resolver ok, no CB-config required
2. `DQL_CASCADE=pot-cli`, `DQL_V0431_ACTIVE=1`, sandbox=false, vollständige Config → resolver ok
3. `DQL_CASCADE=pot-cli`, `DQL_V0431_ACTIVE=1`, sandbox=false, fehlende `circuitBreakerConfigByAlias['serv-swift']` → resolver wirft
4. `DQL_CASCADE=pot-cli`, `DQL_V0431_ACTIVE=1`, sandbox=false, `DQL_RUNTIME_DIAGNOSTICS` fehlt/0 → resolver wirft (v5.2.1 §7 Punkt 5)
5. `DQL_CASCADE=stub`, `DQL_V0431_ACTIVE=1` → resolver ok, `active_cascade='stub'` im Health-Fingerprint

Kein "Health ok" auf Canary, wenn Live-Cascade-Config ungültig ist.

---

## Korrektur 6 — CI-Preflight ≠ echte Vercel-Env-Validation

### 6a. Klare Trennung der Claims

- **CI `validate:prod-config`**: Parser-/Schema-/fixture-Validation gegen ein versioniertes `config/canary.example.json` (non-secret Platzhalter-Werte). Beweis: Schema ist korrekt und Parser wirft nicht auf plausiblen Config-Shapes. **Kein** Beweis über die tatsächlich in Vercel gespeicherten Werte.

- **Preview-Deploy Health-Probe**: `GET /dql/health` gegen die Vercel-Preview-URL nach Deploy, vor Alias-Setzen. Beweis: die im Vercel-Projekt gespeicherten Env-Werte lösen zu einer gültigen Config auf und produzieren den erwarteten `config_hash`.

- **Alias-Gate**: Vergleich `health.commit_sha == expected_commit_sha` **und** `health.config_hash == expected_config_hash` aus Deployment-Manifest. Beweis: der aliased Endpoint ist derselbe wie der geprüfte Preview.

CI darf **nicht** als Beweis formuliert werden, dass die aktuelle Vercel-Env korrekt ist.

### 6b. Config-Artefakt-Flow (v5.2.1 verbindlich)

Präferierter Flow:

```
1. dql-benchmark/config/canary-v0431.json (versioniert, non-secret)
   {
     "capitalPathMode": false,
     "disableCircuitBreaker": false,
     "circuitBreakerConfigByAlias": {
       "serv-nano": { "tripP90LatencyMs": ..., "probeMaxLatencyMs": ..., "cooldownMs": 30000, ... },
       "serv-swift": { "tripP90LatencyMs": ..., "probeMaxLatencyMs": ..., "cooldownMs": 30000, ... }
     },
     "productLatencyCeilingMsByAlias": { "serv-nano": ..., "serv-swift": ... },
     "requiredHealthyHeadroom": 0.2
   }

2. Deployment-Skript liest canary-v0431.json → berechnet expected_config_hash
3. Deployment-Skript setzt Vercel-Env-Variablen aus canary-v0431.json (over vercel CLI oder API)
4. Deploy triggern
5. Preview-URL /dql/health → assert config_hash == expected_config_hash
6. Alias setzen
```

Wenn Bounds weiterhin nur manuell in Vercel-Env liegen (kein Deploy-Skript, das aus Datei setzt): das Manifest muss aus einem separat versionierten Snapshot der Vercel-Env-Werte kommen, und Health muss dagegen verglichen werden. Keine Secrets im Manifest.

### 6c. Deployment-Manifest-Struktur

Bereits in v5.2 §5c definiert. Bleibt unverändert. Erweiterung: `expected_config_hash` wird vor Deploy aus dem Config-Artefakt berechnet und im Manifest festgehalten.

---

## Korrektur 7 — Sieben kleine Korrekturen

### 7.1. HTTP-Codes für invalid config

- **Verify** bei Config-Error: HTTP **503** `CONFIG_INVALID` (nicht 500). Bekannter Betriebszustand.
- **Health** bei Config-Error: HTTP **503** `config_invalid` (bereits so in v5.2 §4b).
- 500 nur für unerwartete Serverfehler ohne bekannte Ursache.

### 7.2. `cooldownRemainingMs`-Semantik

Im `CircuitSnapshot`:

- Bei `state='OPEN'`: `cooldownRemainingMs = max(0, cooldownMs - (now - openedAt))`
- Bei `state='HALF_OPEN'` oder `state='CLOSED'`: `cooldownRemainingMs = 0` oder Feld absent
- **Niemals negativ.**

### 7.3. `lastTripReason` bounded/redacted

`lastTripReason` kann intern technische Details enthalten (Sample-Werte, Timestamps). Vor öffentlichem `meta.runtime`:

- Neuer Enum `reason_code: 'p90_over_bound' | 'failure_rate_over_bound' | 'probe_over_bound' | 'probe_failure' | 'cooldown_elapsed'` im `StateTransitionEvent` und `CircuitSnapshot`
- Freier `reason`-Text nur im geschützten Drill-Artefakt (JSONL, nicht in Consumer-Response)
- `meta.runtime` exponiert nur `reason_code`, nicht `reason`

### 7.4. OpenAPI-Update als Teil von PR #12

`meta.runtime` wird tatsächlich in PR #12 ausgeliefert (env-gated OFF default, aber im Canary an). Daher:

- OpenAPI-Spec (`openapi.yaml` oder gleichwertig) wird in PR #12 aktualisiert
- `RuntimeDiagnostics` als optional-Feld in der Response-Schema
- Nicht als "später, falls stabilisiert" aufgeschoben

Wenn heute keine `openapi.yaml` existiert, wird sie in PR #12 minimal für die betroffenen Endpoints angelegt oder eine adäquate Alternative (Response-Schema in Types + Testfixtures) genutzt.

### 7.5. Runtime-Diagnostics im Canary Pflicht

`DQL_V0431_ACTIVE=1` im Canary verlangt `DQL_RUNTIME_DIAGNOSTICS=1` — sonst würde die Canary ohne Messung starten und §4a/§1d-Metriken (Instance-ID, Cold-Start-Count etc.) wären nicht verfügbar. Config-Resolver-Regel (v5.2.1 §5b Punkt 3):

> Wenn `DQL_V0431_ACTIVE=1` und `DQL_CASCADE=pot-cli` und `DQL_RUNTIME_DIAGNOSTICS` fehlt oder `!=1`: Config-Error.

### 7.6. `instance_id` und `cold_start_at` sind module-scope

Erzeugung genau einmal beim ersten Import der jeweiligen Vercel-Function (verify.ts / health.ts):

```typescript
// api/dql/verify.ts (module scope)
const INSTANCE_ID = randomUUID();
const COLD_START_AT = Date.now();
```

**Nicht** pro Request. Alle Requests desselben warmen Isolates teilen dieselben Werte. Das ist gewollt (§1d-Metriken zählen Requests pro Instance-ID).

### 7.7. Config-Hash-Inklusionsregel

`config_hash` enthält:

- Alle resolved non-secret CB-Config-Werte
- `disableCircuitBreaker`
- `capitalPathMode`
- **`DQL_RUNTIME_DIAGNOSTICS`-Flag** (v5.2.1 neu)
- `DQL_V0431_ACTIVE`-Flag
- `DQL_CASCADE`-Wert
- `productLatencyCeilingMsByAlias`, `requiredHealthyHeadroom`

`config_hash` enthält **nicht**:

- API-Keys
- Secret URLs / Tokens
- Funktionen (`now`, `onStateTransition`, `fetchImpl`, `sleep`)
- Volatile `instance_id`, `cold_start_at` (das ist Deployment-Metadata, nicht Config)

---

## §8 — PR #11 Status

**PR #11 hat separate CODE-GO-Freigabe erhalten** (Hermes v5.2-Review 71444f62).

**Aktueller Stand** (2026-07-11):

- Branch `v043-cb-latency-fix-clean` erstellt von `origin/main @ 423089b`
- Cherry-picks `0dd07ae` + `cb9d83a` durchgeführt
- `docs/ROADMAP.md` aus zweitem Cherry-pick entfernt (keine Design-Docs im Code-PR)
- Finaler Diff: nur `src/engine/llm-client.ts` + `src/engine/llm-client.test.ts`
- `npm test`: 105/105 grün
- `npx tsc --noEmit`: clean
- `npm run build`: clean
- Push nach `origin/v043-cb-latency-fix-clean`
- **PR eröffnet: [decision-quality-layer#11](https://github.com/ThoughtProof/decision-quality-layer/pull/11)**

**Nicht gemergt** — wartet auf Vier-Augen-Review.

---

## §9 — PR #12 Reihenfolge (unverändert außer Sink-Design)

1. **v5.2.1 freigeben** (dieses Korrekturblatt)
2. **PR #11 Vier-Augen-Review + Merge**
3. **PR #12 als Draft** von frischem `main`:
   - `CallContext` + `RuntimeDiagnosticsCollector` neu
   - `Cascade.run(input.ctx)` erweitert (kein Refactor der Signatur)
   - `LlmClient.call(alias, input, ctx)` erweitert
   - `CircuitBreaker` mit `TransitionSink`-Parameter, **kein** Dispatcher-Feld
   - `createProductionLlmClient` + gemeinsamer `resolveProductionConfig` + `computeConfigHash`
   - Mode-aware Config-Validation
   - Bounded `meta.runtime` env-gated
   - OpenAPI-Update
   - 12 v5-Tests + Multi-Instance + Concurrency + HALF_OPEN-Single-flight + Config-Matrix
4. **Tests vollständig grün**
5. **Isolated Build aus PR-#12-Commit**
6. **Kalibrierung + controlled live-provider drill** mit genau diesem SHA
7. Rohdaten + Report + Manifest pushen auf `dql-benchmark/main`
8. **PR #12 Vier-Augen-Review** und Merge
9. Gemergtes `main` erneut testen
10. Vercel Canary aus gemergtem SHA
11. CI-Preflight ≠ echte Vercel-Probe: siehe Korrektur 6
12. Alias-Gate mit `expected_config_hash`
13. **48h Shadow/Paper Canary** + **Gold-Safety alle 6h**
14. **Erst dann Production-Konfig/Rollout**

Trennung explizit (unverändert seit v5.1):

```
PR #12 merge criteria = Tests + Kalibrierung + Drill + Review
Production activation criteria = Merge + Gate 1 + 48h Canary + Gold
```

---

## Freigabestatus

- **PR #11**: eröffnet auf sauberem Branch, wartet auf Review + Merge. Kein Design-Doc-Rauschen.
- **PR #12**: HOLD bis v5.2.1-Freigabe. Sieben Korrekturen umgesetzt. Nach Freigabe: Code-Go.

Prozess-Regel unverändert: „Fertig" = Code committed + gepusht + Rohdaten + Report + Manifest gepusht.

Kein neuer Rewrite, kein Shared Store, kein Prozent-Router.
