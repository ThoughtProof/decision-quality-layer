# Design-Skizze v2 — v0.4.3.1 §E + §C (Hermes-korrigiert)

**Repo-Basis**: `77c3345` auf `v0431-recovery-code`
**Vorgänger**: `v2_dql_v0431_c_e_design_briefing.md` (v1) + Hermes-Review `v0431-c-e-design-review.md`
**Urteil v1**: "Änderungen erforderlich vor Codebeginn"
**Status v2**: umgestellt auf Hermes' korrigierten Vertrag; zur Freigabe.

---

## 0. Was sich gegenüber v1 ändert

| Punkt | v1 (verworfen) | v2 (aktuell) |
|---|---|---|
| Framing I3 | "Race behoben" | "Bestehendes synchrones Single-flight explizit tokenisieren" |
| Event-Attribution | Snapshot-Diff (Option A) | State-Machine gibt Events als Return-Value zurück (Option C) |
| Token-Scope | nur Probes | **jede** Admission (I7) |
| API-Shape | `canProceed(): {admitted, generation}` + `recordSuccess/Failure(gen)` | `admit(): CircuitAdmission` (throws bei Ablehnung) + `recordOutcome(token, outcome): CircuitMutationResult` |
| I4-Sequenz | "Probe hängt, Cooldown läuft, Probe B startet" | Unmöglich mit State-Machine. Stale-Weg = **ergebnisbasierte Epochen**, kein Lease-Takeover |
| Attempt-Grenze-Check | Regex-Guard | Behavioral tests + flacher `attemptAlias`-Helper |
| Retry ↔ CB | Sample pro Fetch | **Ein** finales Binding-Outcome pro Primary/Fallback; `AttemptEvent` nur für Diagnostics |
| Resolver-Erweiterung | offengelassen | I11: `windowSize`, `windowAgeMs`, `minSamples`, `probeMaxLatencyMs` müssen resolver-sichtbar werden, wenn ACTIVE darauf baut |
| Commit-Struktur | ein kombinierter Commit | zwei aufeinander folgende, jeweils grüne Commits (E-core, dann C+integration), gleicher Draft-PR |

Ich implementiere nichts, was Hermes explizit ausgeschlossen hat: kein Snapshot-Diff, kein constructor-bound sink, kein separater `claimProbe()`, keine hängende-Probe-Generation ohne Lease-Definition, kein Regex-Rekursionsbeweis, kein kommentarlos verworfener Collector.

---

## 1. Semantischer Vertrag (Invarianten)

### I1 — Request-scoped Eventtransport
Kein Module-scope Sink. Ein `RuntimeDiagnosticsCollector` pro Verify-Request, erzeugt in `api/dql/verify.ts`, durchgereicht via `CallContext.diagnostics` an den Client und an alle Engine-Axis-Forks desselben Requests (gleiche Referenz, nicht Kopie).

### I2 — Exactly-once Transition-Capture
Ein Domain-Event wird genau von der State-Machine-Mutation erzeugt, die den Zustand ändert. Nie via Beobachter, Diff oder Listener.

### I3 — Synchrones Single-flight-Claim (bestehend, wird tokenisiert)
Der aktuelle Breaker garantiert bereits: OPEN nach Cooldown → synchron HALF_OPEN → nur der aktuelle Call ist Probe; jedes weitere `admit()` wirft `CircuitOpenError`, weil kein `await` zwischen Prüfung und Claim liegt. Der neue Code **erhält** diese Eigenschaft und **verpackt** sie in ein diskriminierendes Admission-Token. Er behauptet nicht, einen Race zu beheben, der nie existierte.

### I4 — Stale-Result-Abwehr via ergebnisbasierte Epochen
Kein `probeLeaseMs`, kein Lease-Takeover, kein Timeout-triggered Generation-Bump.
Der einzige Weg, wie ein Probe-Outcome verworfen wird:

- Probe A erhält Token `(tripGeneration=G, recoveryEpoch=E)`.
- `recordOutcome(A, failure)` → `HALF_OPEN→OPEN`, frischer Cooldown.
- Nach Cooldown macht der nächste Call `admit()` → Token `(G, E+1)`.
- Wenn Callback A doch noch (spät, dupliziert) mit `recordOutcome(A, success)` reinkommt → **stale**, verworfen, Event `stale_result` emittiert, Zustand unverändert.

Damit ist die stale-Invariante beweisbar, ohne einen unmöglichen Netzwerkverlauf zu behaupten.

### I5 — Non-rekursive Attempt-Grenze
Genau **ein** flacher `attemptAlias`-Helper pro Binding. Kein re-entranter `client.call()` aus `callViaFallback`. Zyklische Fallback-Maps (`nano→swift→nano`) führen niemals zu einem dritten Branch. Behavioral tests, kein Source-Regex.

### I6 — Latency-Symmetrie (Bugfix, nicht nur Diagnostics)
`netLatencyMs = Math.max(0, wallClockMs - backoffWaitedMs)` auf Success- **und** Failure-Pfad; auf Primary- **und** Fallback-Route. Aktuell fließt Wall-clock in `p90LatencyMs` ein und bläht bei Backoff+Failure den Latenz-Trip auf. Deshalb ist die Symmetrie eine echte Korrektur.

### I7 — Alle Admissions sind tokenisiert
Nicht nur HALF_OPEN-Probes. Auch spät zurückkehrende CLOSED-Calls aus einem alten Zustand dürfen weder ein aktuelles HALF_OPEN schließen noch Samples in einen späteren CLOSED-Zyklus schreiben. Das Token trägt `closedEpoch` bzw. `tripGeneration + recoveryEpoch`.

### I8 — Transition-Attribution ist state-machine-owned
Nur die Mutation, die den State ändert, erzeugt und returned das Event. Keine Snapshot-Diffs im Client, keine mutablen `currentSink`-Listener.

### I9 — Diagnostics bounded, redacted, no-throw
Feste Max-Zahl pro Eventtyp; `droppedEventCount` im Snapshot; keine Prompts/API-Keys/Rohantworten/vollständige Provider-Fehlertexte; Snapshot immutable; Collector- und Flush-Fehler dürfen den Verify-Pfad nicht verändern; injizierbare Clock.

### I10 — Diagnostics-on darf nicht still fehlen
Wenn ProductionConfig `diagnostics_on=true` verlangt, wird ein fehlender `CallContext.diagnostics` vor dem ersten Fetch als Invariant-Fehler erkannt (oder mindestens explizit ERROR-telemetriert). Kein Canary, der `diagnostics_on=true` hasht und dann sinkless calls ausführt.

### I11 — Recovery-Policy vollständig im Resolver
Aktuell auflösbare CB-Felder pro Alias (bestätigt in `production-runtime.ts:247-249`): `tripP90LatencyMs`, `tripFailureRate`, `cooldownMs`.
Bereits im CB verwendet, aber **nicht** resolver-sichtbar: `windowSize`, `windowAgeMs`, `minSamples`, `probeMaxLatencyMs`.
Sobald ACTIVE/HALF_OPEN auf diese Felder baut, müssen sie:

1. resolver-sichtbar sein (`resolveCbByAlias` weitergibt);
2. bei ACTIVE explizit gesetzt sein (analog H2);
3. Bounds + Cross-Field-Checks (`minSamples <= windowSize`, `probeMaxLatencyMs <= tripP90LatencyMs*1.5` oder ähnlich, `windowAgeMs > 0`);
4. in `configHash` eingehen (nicht ignorieren);
5. via Factory an dieselbe Breaker-Instanz gelangen.

`probeLeaseMs` wird **nicht** eingeführt und gehört nicht in die Config.

### I12 — AttemptEvent-Semantik
Ein `AttemptEvent` pro tatsächlichem `singleCall`/Fetch (also pro Retry-Iteration), plus **ein** `BindingAttemptSummary` pro Primary-/Fallback-Branch. Circuit-Breaker erhält genau ein finales Binding-Outcome, nicht einen Sample pro Retry.

---

## 2. §E — CircuitBreaker Token-API

### 2.1 Types

```ts
// src/engine/circuit-breaker.ts (Neubau der API-Oberfläche)

export type CircuitDomainEvent =
  | {
      kind: 'closed_to_open';
      reason: 'failure_rate' | 'latency' | 'probe_failed' | 'probe_slow';
      at: number;
      tripGeneration: number;   // ID der neuen OPEN-Phase
    }
  | {
      kind: 'open_to_half_open';
      at: number;
      tripGeneration: number;   // aktuelle OPEN-Gen wird zur Probe hin verlängert
      recoveryEpoch: number;    // startet bei 0, +1 bei jedem probe_failed
    }
  | {
      kind: 'half_open_to_closed';
      at: number;
      tripGeneration: number;   // wird geschlossen
      closedEpoch: number;      // ID der neuen CLOSED-Phase
    }
  | {
      kind: 'stale_result';
      at: number;
      reason: 'wrong_epoch' | 'wrong_generation' | 'wrong_state';
    };

export type CircuitAdmission =
  | {
      kind: 'normal';
      token: {
        readonly closedEpoch: number;
        readonly stateRevision: number; // monoton, für Debug/Attribution
      };
      readonly events: readonly CircuitDomainEvent[];
    }
  | {
      kind: 'probe';
      token: {
        readonly tripGeneration: number;
        readonly recoveryEpoch: number;
        readonly probeSequence: number;
        readonly stateRevision: number;
      };
      readonly events: readonly CircuitDomainEvent[];
    };

export type CircuitAdmissionToken = CircuitAdmission['token'];

export interface CircuitMutationResult {
  readonly accepted: boolean; // false = stale
  readonly events: readonly CircuitDomainEvent[];
}
```

### 2.2 Neue öffentliche API

```ts
class CircuitBreaker {
  // throws CircuitOpenError wenn abgelehnt
  admit(now?: number): CircuitAdmission;

  // ersetzt recordSuccess / recordFailure
  recordOutcome(
    token: CircuitAdmissionToken,
    outcome: { ok: boolean; netLatencyMs: number },
    now?: number,
  ): CircuitMutationResult;

  snapshot(): CircuitSnapshot; // immutable, bleibt read-only
  reset(): void;               // test-only, unverändert
}
```

`recordSuccess` und `recordFailure` werden **entfernt**. Alle Callsites im Repo werden umgestellt (siehe §4).

### 2.3 Interner Zustand (Ergänzungen)

- `closedEpoch: number` — inkrementiert bei jedem CLOSED-Eintritt.
- `tripGeneration: number` — inkrementiert bei jedem `closed_to_open`.
- `recoveryEpoch: number` — auf 0 beim CLOSED, +1 bei `probe_failed → OPEN`.
- `probeSequence: number` — pro `open_to_half_open`.
- `stateRevision: number` — monotoner Counter aller Zustandsänderungen (für Debug/Attribution).

Nur ein aktives Probe-Token existiert je Zeit, weil HALF_OPEN synchron auf `probeInFlight` prüft.

### 2.4 Stale-Rejection-Logik in `recordOutcome`

```
Fall 1 — Token ist 'normal' (closedEpoch = X):
  Wenn aktueller state === CLOSED && this.closedEpoch === X:
    Sample in Fenster, evtl. tripCheck → closed_to_open Event zurückgeben
  Sonst:
    accepted = false, event = stale_result{reason:'wrong_epoch'}

Fall 2 — Token ist 'probe' (tripGeneration=G, recoveryEpoch=E, probeSequence=P):
  Wenn state === HALF_OPEN && this.tripGeneration === G && this.recoveryEpoch === E && this.probeSequence === P:
    Wenn ok && netLatencyMs <= probeMaxLatencyMs:
      HALF_OPEN → CLOSED, closedEpoch++, event = half_open_to_closed
    Sonst:
      HALF_OPEN → OPEN, recoveryEpoch++, event = closed_to_open{reason:'probe_failed'|'probe_slow'}
  Sonst:
    accepted = false, event = stale_result{reason:'wrong_generation'|'wrong_state'}
```

### 2.5 Resolver-Erweiterung (I11)

`src/engine/production-runtime.ts:resolveCbByAlias` gibt zusätzlich weiter:

```ts
{
  tripP90LatencyMs,
  tripFailureRate,
  cooldownMs,
  windowSize,        // NEU
  windowAgeMs,       // NEU
  minSamples,        // NEU
  probeMaxLatencyMs, // NEU
}
```

Und `ProductionConfig.circuit_breaker_config_by_alias[alias]` bekommt diese vier Felder. Bei ACTIVE (`v0431_active=true`) sind sie **required**; H2 wird analog erweitert. Cross-Field-Checks:

- `minSamples > 0 && minSamples <= windowSize`
- `windowSize > 0 && windowSize <= 1000`
- `windowAgeMs >= 1000`
- `probeMaxLatencyMs > 0 && probeMaxLatencyMs >= tripP90LatencyMs` (Probe darf nicht strenger sein als Trip; sonst trippt HALF_OPEN sofort wieder)

Alle vier Felder gehen in `configHash` ein. Der Fingerprint-Test (T13 unten) flipst jedes einzeln und verifiziert, dass sich `configHash` **und** das reale Breaker-Verhalten ändern.

### 2.6 CircuitOpenError

Bleibt bestehen. `admit()` wirft ihn bei OPEN (Cooldown nicht abgelaufen) oder HALF_OPEN mit `probeInFlight=true`. Kein Payload-Change.

---

## 3. §C — RuntimeDiagnosticsCollector + attemptAlias

### 3.1 Types

```ts
// src/engine/diagnostics.ts (neu)

export interface AttemptEvent {
  alias: string;
  route: 'primary' | 'fallback';
  requestId: string;
  axis?: string;
  callId?: string;
  attempt: number;              // 1-basiert
  outcome: 'success' | 'failure';
  attemptLatencyMs: number;     // reine Fetch-Zeit, ohne Backoff
  backoffBeforeMs: number;      // Backoff VOR diesem Fetch
  at: number;
  errorCategory?: 'timeout' | 'rate_limit' | 'network' | 'http_5xx' | 'other';
}

export interface BindingAttemptSummary {
  alias: string;
  route: 'primary' | 'fallback';
  requestId: string;
  axis?: string;
  callId?: string;
  finalOutcome: 'success' | 'failure';
  attemptCount: number;
  wallClockMs: number;          // Summe aller Fetch-Zeiten
  backoffWaitedMs: number;      // Summe aller Backoffs
  netLatencyMs: number;         // max(0, wallClockMs - backoffWaitedMs)
  at: number;
}

export interface RuntimeDiagnosticsSnapshot {
  readonly circuit: readonly CircuitDomainEvent[];
  readonly attempts: readonly AttemptEvent[];
  readonly summaries: readonly BindingAttemptSummary[];
  readonly droppedCounts: {
    circuit: number;
    attempts: number;
    summaries: number;
  };
}

export class RuntimeDiagnosticsCollector {
  constructor(opts?: {
    maxCircuitEvents?: number;      // default 64
    maxAttemptEvents?: number;      // default 256
    maxBindingSummaries?: number;   // default 32
    now?: () => number;             // injectable clock
  });

  addCircuitEvents(events: readonly CircuitDomainEvent[]): void;
  addAttempt(event: AttemptEvent): void;
  addSummary(summary: BindingAttemptSummary): void;
  snapshot(): RuntimeDiagnosticsSnapshot; // immutable defensive copy
}
```

Alle Add-Methoden sind no-throw. Cap-Überschreitung inkrementiert `droppedCounts.*`. Snapshot ist ein deep-frozen immutable Objekt.

### 3.2 CallContext-Erweiterung

`src/engine/call-context.ts` bekommt optional `diagnostics?: RuntimeDiagnosticsCollector`. Bei ACTIVE + `diagnostics_on=true` ist es required (I10).

### 3.3 attemptAlias-Helper (flat)

```ts
// src/engine/attempt-alias.ts (neu)

async function attemptAlias(
  binding: { alias: string; providerConfig; clientOptions },
  input: LlmCallInput,
  ctx: CallContext,
  route: 'primary' | 'fallback',
): Promise<AttemptResult>
```

Wo `AttemptResult`:

```ts
type AttemptResult =
  | { ok: true; output: LlmCallOutput; telemetry: AttemptTelemetry }
  | { ok: false; error: unknown; telemetry: AttemptTelemetry };

interface AttemptTelemetry {
  attemptCount: number;
  wallClockMs: number;
  backoffWaitedMs: number;
  netLatencyMs: number;
  retryReasons: readonly string[];
}
```

Verantwortlichkeiten:

- exakt eine Retry-Schleife (`maxAttempts`);
- kein Fallback (das entscheidet der äußere `call()`);
- pro `singleCall` ein `AttemptEvent` an `ctx.diagnostics` (falls gesetzt);
- am Ende ein `BindingAttemptSummary`;
- kein rekursiver `client.call()`.

### 3.4 `LlmClient.call()` — neu

```
1) admission = breaker.admit()
   emit(admission.events → ctx.diagnostics)
2) primary = await attemptAlias(primaryBinding, input, ctx, 'primary')
3) mutation = breaker.recordOutcome(admission.token,
     { ok: primary.ok, netLatencyMs: primary.telemetry.netLatencyMs })
   emit(mutation.events → ctx.diagnostics)
   // Beachte: mutation.accepted könnte false sein → stale_result Event
   // Verhalten bleibt: wenn primary.ok, return primary.output
4) if (!primary.ok) und Fallback definiert:
     fallbackAdmission = fallbackBreaker.admit()
     emit(fallbackAdmission.events → ctx.diagnostics)
     fallback = await attemptAlias(fallbackBinding, input, ctx, 'fallback')
     fmutation = fallbackBreaker.recordOutcome(fallbackAdmission.token,
       { ok: fallback.ok, netLatencyMs: fallback.telemetry.netLatencyMs })
     emit(fmutation.events → ctx.diagnostics)
     if (fallback.ok) return fallback.output
5) throw fail-closed
```

Keine Rekursion. `attemptAlias` wird höchstens zweimal aufgerufen. Zyklische Fallback-Maps werden vom äußeren `call()` erkannt und ignoriert (nur ein Fallback-Hop).

### 3.5 Handler-Verdrahtung

`api/dql/verify.ts`:

```ts
const diagnosticsOn = productionConfig.diagnostics_on === true;
const collector = diagnosticsOn ? new RuntimeDiagnosticsCollector() : undefined;

const ctx: CallContext = {
  requestId,
  diagnostics: collector,
  // ...
};

try {
  const result = await runVerify(input, ctx);
  return jsonResponse(result);
} catch (err) {
  return handleError(err);
} finally {
  if (collector) {
    try {
      const snap = collector.snapshot();
      structuredTelemetryLog({
        kind: 'dql.runtime_diagnostics',
        requestId,
        circuit: snap.circuit,
        attempts: snap.attempts.slice(0, 128),   // sekundäre Cap
        summaries: snap.summaries,
        droppedCounts: snap.droppedCounts,
      });
    } catch (flushErr) {
      // no-throw: structured log intern; darf Response nicht mutieren
      logInternalError('diagnostics_flush_failed', flushErr);
    }
  }
}
```

Der Flush ist:
- bounded (Caps im Collector + sekundäre Cap beim Log-Emit);
- redacted (keine Prompts, kein `errorMessage` außerhalb `errorCategory`);
- no-throw (`catch` schluckt);
- in `finally` (Success, 4xx, 5xx, fail-closed alle abgedeckt).

Kein neues `/dql/verify`-Antwortfeld. Keine `/dql/health`-Änderung. `RuntimeDiagnosticsSnapshot` wird nur intern beobachtbar.

### 3.6 I10 — Diagnostics-on ohne Collector

In der Production-`LlmClient`-Konfiguration:

```ts
if (productionConfig.diagnostics_on && !ctx.diagnostics) {
  throw new Error(
    'DQL invariant: diagnostics_on=true but CallContext.diagnostics missing',
  );
}
```

Wird **vor** dem ersten Fetch geprüft.

### 3.7 Engine-Axis-Fork (Zusatz)

Wo der Verify-Pfad in mehrere Axis-Kontexte forkt (Reasoning/Plan/Sentinel), wird **dieselbe** `collector`-Referenz durchgereicht, nur `axis`/`callId` ergänzt. Kein Kopieren, kein Wrapper.

---

## 4. Betroffene Callsites (E-core-Commit)

Alle Aufrufe von `recordSuccess`/`recordFailure` im Repo werden auf `recordOutcome(token, outcome)` umgestellt:

- `src/engine/llm-client.ts` — `call()`, `callViaFallback()`, `callWithRetry()` werden Teil des neuen `attemptAlias` + äußeren `call()` (aber attemptAlias kommt erst im C-Commit; im E-Commit wird der bestehende Client so umgebaut, dass er Token entgegennimmt und Events verwirft)
- `src/engine/circuit-breaker.test.ts` — Tests auf neue API umschreiben
- Andere Callsites: `grep -rn "recordSuccess\|recordFailure" src/` prüft; alle updates.

**E-core-Commit-Grün-Kriterium**: Alle bestehenden Tests laufen, State-Machine ist tokenisiert, Client verwirft `events` noch (kein Collector-Ziel).

---

## 5. Korrigierter Testplan (13 Tests)

Aus Hermes' Testkorpus, unverändert übernommen:

1. **Existing single-flight regression**: unresolved Probe + paralleler Call → exakt 1 Primary-Probe-Fetch; zweite Admission wirft `CircuitOpenError`.
2. **Probe-token stale**: A `admit()` → `recordOutcome(A, failure)` → nach Cooldown B `admit()` → spätes `recordOutcome(A, success)` liefert `accepted=false` + `stale_result`; State bleibt HALF_OPEN; nur `recordOutcome(B, success)` schließt.
3. **Late normal result**: zwei parallele CLOSED-Admissions; eine trippt via `recordOutcome`; spätes `recordOutcome` der anderen mit gleichem `closedEpoch` wird akzeptiert (Sample landet noch im alten Fenster? — hier wird die Regel festgezurrt: `closedEpoch`-Match reicht, aber Zustand bleibt OPEN, Event = `stale_result` weil `state !== CLOSED`). Alternativ: `accepted=false` mit `stale_result{reason:'wrong_state'}`. **Design-Entscheidung**: `wrong_state` ist strenger und sicherer → wir verwerfen den späten CLOSED-Sample, sobald der Breaker OPEN oder HALF_OPEN ist.
4. **Exactly-once Domain-Events**: 30 healthy calls → 0 Transitions; 1 Trip → genau 1 `closed_to_open`; Recovery → genau 1 `open_to_half_open` + 1 `half_open_to_closed`.
5. **Attribution race**: zwei parallele Requests mit je eigenem Collector teilen einen Breaker → nur der verursachende Collector erhält das Transition-Event (weil State-Machine-owned Return-Value).
6. **Fetch-Budget**: `maxAttempts=3`, Primary + Fallback exhaust → exakt 6 Fetches, nicht 12.
7. **Cyclic fallback map**: `nano→swift→nano` → maximal 2 Bindings ausgeführt; kein dritter Branch.
8. **Latency symmetry**: Success und exhausted Failure mit gleichen Provider-Zeiten + Backoffs liefern denselben `netLatencyMs`.
9. **Attempt telemetry**: N Fetches → N AttemptEvents; genau 1 `BindingAttemptSummary` pro Binding; CB bekommt genau 1 `recordOutcome`-Call pro Binding.
10. **Collector isolation**: parallele Verify-Requests → separate Collector-Instanzen; 5 Axis-Kontexte desselben Requests → identische Referenz.
11. **Bounded/no-throw**: Event-Cap greift, `droppedCounts.*` wächst; absichtlich werfender Flush verändert Response nicht.
12. **Diagnostics completeness**: ACTIVE + `diagnostics_on=true` ohne Collector → Invariant-Fehler vor Fetch.
13. **Policy fingerprint**: Einzeln jedes ACTIVE-CB-Feld (7 Felder) flipsen → jeweils anderer `configHash` **und** verifizierbar anderes Breaker-Verhalten (z. B. anderer Trip-Zeitpunkt).

---

## 6. Commit-Aufteilung

### Commit E-core (State-Machine + Resolver)

Files:
- `src/engine/circuit-breaker.ts` (Token-API, returned events, epochs, stale-rejection)
- `src/engine/circuit-breaker.test.ts` (auf neue API umgeschrieben + Tests 1-4, 6, 13)
- `src/config/production-config.ts` (H2 erweitert um windowSize/windowAgeMs/minSamples/probeMaxLatencyMs für ACTIVE)
- `src/engine/production-runtime.ts` (`resolveCbByAlias` erweitert)
- `src/config/config-hash.ts` (falls existiert; sonst inline) — hash-Basis erweitert
- `src/engine/llm-client.ts` (call() nutzt `admit` + `recordOutcome`; Events werden noch verworfen — Zwischenschritt)
- `src/engine/llm-client.test.ts` (Signatur-Updates)

Grün-Kriterium: **alle 205 bestehenden Tests + neue CB-Tests grün**; Client-Events landen in `void 0`.

### Commit C+integration (Diagnostics + attemptAlias + Symmetrie + Flush)

Files:
- `src/engine/diagnostics.ts` (neu)
- `src/engine/attempt-alias.ts` (neu)
- `src/engine/call-context.ts` (`diagnostics?` erweitert)
- `src/engine/llm-client.ts` (attemptAlias eingezogen, Symmetrie, Events → Collector)
- `api/dql/verify.ts` (Collector + Flush in finally)
- `src/engine/diagnostics.test.ts` (neu) + Integration-Tests 5, 7-12

Grün-Kriterium: alle Tests inkl. 13-Punkte-Plan grün.

Beide Commits sind Teil desselben Draft-PR #12. Freigabe erfolgt gemeinsam.

---

## 7. Was NICHT in §E+§C ist

- Kein OpenAPI-Delta (bleibt spätere Aufgabe; Snapshot wird nur intern geloggt).
- Keine `/dql/health`-Aggregat-Feld-Änderung (Serverless kann request-scoped Collector nicht selbst aggregieren; braucht später separaten process-scope Aggregator).
- Kein `probeLeaseMs`, kein Lease-Takeover.
- Kein `alias_gate_ready`-Feld-Change über H1 hinaus.
- Keine Kalibrierungs-Runs (separate Aufgabe #5).

---

## 8. Offene Bestätigungen an Hermes

1. **T3 (Late normal result)** — Design-Entscheidung `wrong_state` verwerfen, sobald Breaker OPEN/HALF_OPEN ist, auch wenn `closedEpoch` matcht. OK?
2. **I11 Cross-Field-Check `probeMaxLatencyMs >= tripP90LatencyMs`** — willst du strenger (`>=` statt `<=`)? Rationale: Probe muss laxer sein als Trip, sonst schlägt sie sofort wieder fehl. Aktuelle Defaults haben `probeMaxLatencyMs = tripP90LatencyMs`, was Grenzfall ist.
3. **AttemptTelemetry retryReasons** — behalten wir das im BindingSummary, oder nur pro AttemptEvent als `errorCategory`? Empfehlung: nur AttemptEvent, Summary bleibt schlank.
4. **Flush-Zielort** — `structuredTelemetryLog` als generischer JSON-Log-Emitter; oder gibt es einen dedizierten Telemetry-Pfad im Repo, den ich verwenden soll? (Ich schaue vor E-core-Commit selbst nach.)
5. **`stale_result`-Event-Cap** — soll ein Cap-Overflow von stale_results den Test failen lassen, oder ist stale_results droppable wie andere Events? Empfehlung: droppable, aber `droppedCounts.circuit` wird im Test überwacht.

Bei OK zu diesen fünf Punkten (oder Änderungswunsch) starte ich sofort mit dem **E-core-Commit** auf Basis `77c3345`.
