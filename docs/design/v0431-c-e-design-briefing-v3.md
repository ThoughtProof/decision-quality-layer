# Design-Skizze v3 — v0.4.3.1 §E + §C (Hermes-freigegeben mit Vertrag K1–K5)

**Repo-Basis**: `77c3345` auf `v0431-recovery-code`
**Vorgänger**: v2 + Hermes-Review `v0431-c-e-design-v2-review.md`
**Urteil v2**: "Bedingte Freigabe. Codebeginn freigegeben, sofern K1–K5 als bindender Vertrag."
**Status v3**: verpflichtende Korrekturen als Implementierungsvertrag; keine Restfragen mehr offen.

---

## 0. Δ zu v2

| Punkt | v2 | v3 (bindender Vertrag) |
|---|---|---|
| K1 — Event-Union | HALF_OPEN→OPEN als `closed_to_open{probe_failed}` | eigener `half_open_to_open`-Kind; `stale_result` separater Event-Typ außerhalb Transition-Union |
| K1 — tripGeneration | inkrementiert auch bei probe_failed | inkrementiert **nur** bei CLOSED→OPEN; HALF_OPEN→OPEN bumpt nur `recoveryEpoch` |
| K2 — Token-Identität | Epoch-Felder | `Object.freeze()`+ private `WeakSet<object>` im Breaker; one-shot; breaker-gebunden; fälschungssicher; `admissionSequence`-Feld |
| K3 — `now`-Parameter | `admit(now?)`, `recordOutcome(..., now?)` | entfernt; nur konstruktor-injected Clock |
| K3 — `reset()` | vorgesehen (test-only) | nicht hinzugefügt; existiert im aktuellen Breaker nicht, Tests konstruieren frisch |
| K4 — Routing | „if !primary.ok → fallback" | exakte 4×2-Matrix; kein Fallback bei ordinary failure/CLOSED; kein Fallback in CPM |
| K5 — Admission-Safety | `if diagnostics_on && !collector throw` in Client-Konfig | Preconditions VOR `admit()`; `try/finally` **um** attemptAlias, bei unerwartetem Throw defensives `recordOutcome(_, failure)` |
| Retry-Semantik | `wallClockMs = Summe Fetch-Zeiten` | `wallClockMs` = gesamte Binding-Dauer inkl. Backoffs; `attemptLatencyMs → attemptElapsedMs` |
| Diagnostics-Pflicht | Client-side Check | `requireDiagnostics` als Factory-Safety-Config; nicht via `clientOptionsOverride` abschaltbar |
| Caps | ein gemeinsamer `maxCircuitEvents` | separater `maxTransitionEvents` + `maxStaleResultEvents`; separate `droppedCounts.transitions`/`.staleResults` |
| Collector-Init | `new Collector()` | `new Collector(requestId, opts)`; Axis-Fork prüft `ctx.requestId === collector.requestId` |
| Attempt-Clock | nur Breaker-Clock injizierbar | zusätzlich `now`, `random` in Client/Attempt-Config injizierbar |
| ACTIVE-Bounds | `probeMaxLatencyMs >= tripP90LatencyMs` | keine Cross-Field-Relation; nur `> 0` |
| T13 | Hash-Flip pro Feld | Hash-Flip + behavioral counter-proof pro Feld |
| E-core-Deploy | offen | E-core-SHA nicht Canary-ready; nur C+integration-HEAD claimt `alias_gate_ready` |

---

## 1. Semantischer Vertrag (Invarianten I1–I12, unverändert aus v2)

Verweise: v2 Abschnitt 1. In v3 präzisiert:

- **I4 Stale-Priorität**: `invalid_token > already_consumed > wrong_state > wrong_epoch|wrong_generation`.
- **I8** wird durch K2 verschärft: State-Machine-owned + fälschungssichere Token-Identität.
- **I9** wird durch separate Caps verschärft.
- **I10** wird durch `requireDiagnostics`-Factory-Safety verschärft.

---

## 2. §E — CircuitBreaker Token-API (v3)

### 2.1 Event-Typen (K1)

Zwei disjoint Unions:

```ts
export type CircuitTransitionEvent =
  | {
      kind: 'closed_to_open';
      reason: 'failure_rate' | 'latency';
      alias: string;
      from: 'CLOSED';
      to: 'OPEN';
      at: number;
      tripGeneration: number;
      stateRevision: number;
    }
  | {
      kind: 'open_to_half_open';
      alias: string;
      from: 'OPEN';
      to: 'HALF_OPEN';
      at: number;
      tripGeneration: number;
      recoveryEpoch: number;
      probeSequence: number;
      stateRevision: number;
    }
  | {
      kind: 'half_open_to_open';
      reason: 'probe_failed' | 'probe_slow';
      alias: string;
      from: 'HALF_OPEN';
      to: 'OPEN';
      at: number;
      tripGeneration: number;      // dieselbe Trip-Gen wie beim vorherigen closed_to_open
      recoveryEpoch: number;
      probeSequence: number;
      stateRevision: number;
    }
  | {
      kind: 'half_open_to_closed';
      alias: string;
      from: 'HALF_OPEN';
      to: 'CLOSED';
      at: number;
      tripGeneration: number;
      recoveryEpoch: number;
      probeSequence: number;
      closedEpoch: number;
      stateRevision: number;
    };

export type CircuitStaleResultEvent = {
  kind: 'stale_result';
  reason:
    | 'invalid_token'
    | 'already_consumed'
    | 'wrong_state'
    | 'wrong_epoch'
    | 'wrong_generation';
  alias: string;
  at: number;
  stateRevision: number;
};

export type CircuitDomainEvent = CircuitTransitionEvent | CircuitStaleResultEvent;
```

**Regeln**:

- `tripGeneration++` nur bei `closed_to_open`.
- `recoveryEpoch++` bei jedem `half_open_to_open` innerhalb derselben Trip-Gen.
- `probeSequence++` bei jedem `open_to_half_open`.
- `closedEpoch++` bei jedem `half_open_to_closed`.
- `stateRevision++` monoton bei jeder State-Mutation.

### 2.2 Admission-Token (K2)

```ts
export type CircuitAdmissionToken =
  | Readonly<{
      kind: 'normal';
      admissionSequence: number;
      closedEpoch: number;
      stateRevision: number;
    }>
  | Readonly<{
      kind: 'probe';
      admissionSequence: number;
      tripGeneration: number;
      recoveryEpoch: number;
      probeSequence: number;
      stateRevision: number;
    }>;

export type CircuitAdmission =
  | { kind: 'normal'; token: CircuitAdmissionToken; events: readonly CircuitTransitionEvent[] }
  | { kind: 'probe';  token: CircuitAdmissionToken; events: readonly CircuitTransitionEvent[] };
```

**Fälschungssicherheit** (privater Breaker-State):

```ts
private readonly issued  = new WeakSet<object>();
private readonly consumed = new WeakSet<object>();
private admissionSequence = 0;
```

`admit()` erzeugt Token, `Object.freeze(token)`, `issued.add(token)`. `recordOutcome(token, ...)`:

1. Wenn `!issued.has(token)` → `stale_result{invalid_token}`; **keine** State-Mutation.
2. Wenn `consumed.has(token)` → `stale_result{already_consumed}`; keine State-Mutation.
3. Sonst: `consumed.add(token)`, dann Zustandsprüfung.

Ein plain-object-Nachbau (gleiche Felder, aber andere Objekt-Identität) landet in Regel 1. Ein Token von Breaker A landet bei Breaker B in Regel 1 (nicht in B's `issued`-Set).

### 2.3 Öffentliche API

```ts
class CircuitBreaker {
  constructor(config: CircuitBreakerConfig, opts?: { now?: () => number });

  admit(): CircuitAdmission;                              // throws CircuitOpenError

  recordOutcome(
    token: CircuitAdmissionToken,
    outcome: { ok: boolean; netLatencyMs: number },
  ): CircuitMutationResult;

  snapshot(): CircuitSnapshot;                             // immutable
}

interface CircuitMutationResult {
  readonly accepted: boolean;
  readonly events: readonly CircuitDomainEvent[];          // Union, nicht nur transitions
}
```

**Kein** `now?`-Parameter an `admit`/`recordOutcome`. **Kein** öffentliches `reset()`. `recordSuccess`/`recordFailure` werden entfernt.

### 2.4 State-Machine-Mutation

```
admit():
  now = this.now()
  Prüfe Zustand:
    OPEN + (now - openedAt) < cooldownMs → throw CircuitOpenError
    OPEN + (now - openedAt) >= cooldownMs → synchron HALF_OPEN, probeSequence++, probeInFlight=true, event=open_to_half_open
    HALF_OPEN + probeInFlight → throw CircuitOpenError
    CLOSED → keine Transition
  Token bauen (frozen, in issued-Set), admissionSequence++
  return { kind, token, events: [...transitions] }

recordOutcome(token, outcome):
  1. Identitätsprüfung (K2): invalid_token / already_consumed → stale_result, exit
  2. Kind-Prüfung:
     token.kind === 'normal':
       Wenn state !== CLOSED oder closedEpoch !== token.closedEpoch:
         → stale_result{wrong_state|wrong_epoch}
       Sonst:
         Sample ins Fenster; tripCheck() → evtl. closed_to_open (tripGeneration++)
     token.kind === 'probe':
       Wenn state !== HALF_OPEN oder tripGeneration/recoveryEpoch/probeSequence mismatch:
         → stale_result{wrong_state|wrong_generation}
       Sonst:
         probeInFlight=false
         Wenn ok && netLatencyMs <= probeMaxLatencyMs:
           HALF_OPEN → CLOSED, closedEpoch++, event=half_open_to_closed
         Sonst:
           HALF_OPEN → OPEN, recoveryEpoch++, openedAt=now, event=half_open_to_open
  return { accepted: true|false, events }
```

### 2.5 Config-Erweiterung (I11)

`ProductionConfig.circuit_breaker_config_by_alias[alias]` bekommt vier neue Felder. Für **ACTIVE** required:

```ts
{
  tripP90LatencyMs: number;
  tripFailureRate: number;
  cooldownMs: number;
  windowSize: number;         // NEU
  windowAgeMs: number;        // NEU
  minSamples: number;         // NEU
  probeMaxLatencyMs: number;  // NEU
}
```

**OFF byte-kompatibel** zu bestehenden Constructor-Defaults:
- `windowSize=20`, `windowAgeMs=60_000`, `minSamples=5`, `probeMaxLatencyMs=tripP90LatencyMs`.

**Bounds** (ohne unbelegte Cross-Field-Regel):

- `windowSize`: positive Ganzzahl, sinnvoll gedeckelt (z. B. `<= 1000`).
- `windowAgeMs > 0`.
- `minSamples`: positive Ganzzahl und `minSamples <= windowSize`.
- `probeMaxLatencyMs > 0`. **Keine** Relation zu `tripP90LatencyMs`.
- Bestehende Bounds für `tripP90LatencyMs`, `tripFailureRate`, `cooldownMs` unverändert.

Alle sieben Felder gehen in `configHash` ein. `resolveCbByAlias` gibt alle sieben zurück.

### 2.6 K5 — Admission-Safety

`LlmClient.call()`:

```ts
// PHASE A — Preconditions vor Admission
verifyAliasKnown(alias);
verifyApiKeyPresent(alias);
verifyRequireDiagnostics(ctx);      // I10: wenn requireDiagnostics && !ctx.diagnostics → throw
verifyInputShape(input);

// PHASE B — Admission (kann werfen: CircuitOpenError)
let admission: CircuitAdmission;
try {
  admission = breaker.admit();
} catch (e) {
  if (e instanceof CircuitOpenError) { /* Routing-Matrix K4 */ }
  throw e;
}
emit(admission.events, ctx.diagnostics);

// PHASE C — Attempt mit garantiertem Abschluss
let outcome: { ok: boolean; netLatencyMs: number } | null = null;
try {
  const result = await attemptAlias(binding, input, ctx, 'primary');
  outcome = { ok: result.ok, netLatencyMs: result.telemetry.netLatencyMs };
  if (result.ok) return handleSuccess(result);
  // Fallschritte: siehe Routing-Matrix K4
} catch (unexpectedThrow) {
  // Sollte nicht passieren; attemptAlias muss immer AttemptResult liefern.
  // Defensiver Failure-Outcome-Report, damit Breaker nicht in HALF_OPEN strandet.
  outcome = { ok: false, netLatencyMs: 0 };
  throw unexpectedThrow;
} finally {
  if (outcome !== null) {
    const mutation = breaker.recordOutcome(admission.token, outcome);
    emit(mutation.events, ctx.diagnostics);
  }
}
```

`attemptAlias` verspricht: Provider-/Parsing-/Retry-Fehler werden in `AttemptResult{ok:false}` verpackt; kein Throw für normale Fehler. Der äußere `catch` fängt nur pathologische Bugs und garantiert trotzdem `recordOutcome`.

### 2.7 K4 — Routing-Matrix (exakt erhalten)

| Primary-Situation | CPM=false | CPM=true |
|---|---|---|
| `admit()` wirft `CircuitOpenError` (OPEN oder HALF_OPEN+probeInFlight) | Fallback versuchen | sofort fail-closed, kein Fetch |
| Primary-Attempt returns `{ok:false}`, Breaker bleibt CLOSED nach `recordOutcome` | ursprünglichen Fehler werfen (kein Fallback) | ursprünglichen Fehler werfen |
| Primary-Attempt returns `{ok:false}`, `recordOutcome` liefert `closed_to_open` (trippt) oder Breaker war schon OPEN/HALF_OPEN post-mutation | Fallback versuchen | fail-closed, kein Fallback |
| Primary-Attempt returns `{ok:true}` | Erfolg zurückgeben | Erfolg zurückgeben |

**Fallback**:

- höchstens einmal (kein tertiärer Route);
- eigenes `fallbackBreaker.admit()` + `recordOutcome`;
- `attemptedRoutes`-Provenienz exakt korrekt (Primary immer eingetragen; Fallback nur wenn tatsächlich versucht).

Zyklische Fallback-Maps (`nano→swift→nano`) erkennt der äußere `call()` und macht **keinen** zweiten Fallback-Hop — der Ausgangs-Fehler wird geworfen.

---

## 3. §C — RuntimeDiagnosticsCollector (v3)

### 3.1 Types

```ts
export interface AttemptEvent {
  alias: string;
  route: 'primary' | 'fallback';
  requestId: string;
  axis?: string;
  callId?: string;
  attempt: number;                  // 1-basiert
  outcome: 'success' | 'failure';
  attemptElapsedMs: number;         // HTTP-Roundtrip + Response-Verarbeitung in singleCall
  backoffBeforeMs: number;
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
  wallClockMs: number;              // gesamte Binding-Dauer inkl. Backoffs
  backoffWaitedMs: number;
  netLatencyMs: number;             // max(0, wallClockMs - backoffWaitedMs)
  retryCategoryCounts?: Record<string, number>;  // z. B. { timeout: 2, rate_limit: 1 }
  at: number;
}

export interface RuntimeDiagnosticsSnapshot {
  readonly requestId: string;
  readonly transitions: readonly CircuitTransitionEvent[];
  readonly staleResults: readonly CircuitStaleResultEvent[];
  readonly attempts: readonly AttemptEvent[];
  readonly summaries: readonly BindingAttemptSummary[];
  readonly droppedCounts: {
    readonly transitions: number;
    readonly staleResults: number;
    readonly attempts: number;
    readonly summaries: number;
  };
}

export class RuntimeDiagnosticsCollector {
  constructor(
    requestId: string,
    opts?: {
      maxTransitionEvents?: number;   // default 32
      maxStaleResultEvents?: number;  // default 128
      maxAttemptEvents?: number;      // default 256
      maxBindingSummaries?: number;   // default 32
      now?: () => number;
    },
  );

  readonly requestId: string;

  addCircuitEvents(events: readonly CircuitDomainEvent[]): void;  // routet Union
  addAttempt(event: AttemptEvent): void;
  addSummary(summary: BindingAttemptSummary): void;
  snapshot(): RuntimeDiagnosticsSnapshot;                          // deep-frozen
}
```

`addCircuitEvents` verteilt Union-Members auf zwei separate Puffer. Cap-Overflow: separate Counter, **nie** verdrängt ein stale_result eine Transition oder umgekehrt.

Alle Add-Methoden no-throw. Snapshot ist immutable (deep-frozen defensive Kopie).

### 3.2 CallContext-Erweiterung

Da im realen Engine derzeit kein Root-`CallContext` existiert:

```ts
interface EngineInput {
  // bestehend
  requestId: string;
  // NEU
  diagnostics?: RuntimeDiagnosticsCollector;
}

// Engine-Axis-Fork:
const ctx: CallContext = {
  requestId: input.requestId,
  axis,
  callId: generateCallId(),
  diagnostics: input.diagnostics,
};

// Invariant beim Fork:
if (ctx.diagnostics && ctx.diagnostics.requestId !== ctx.requestId) {
  throw new Error('DQL invariant: diagnostics.requestId mismatch');
}
```

### 3.3 `attemptAlias`-Helper (flat, K5-kompatibel)

```ts
async function attemptAlias(
  binding: BindingConfig,
  input: LlmCallInput,
  ctx: CallContext,
  route: 'primary' | 'fallback',
): Promise<AttemptResult>

type AttemptResult =
  | { ok: true;  output: LlmCallOutput; telemetry: AttemptTelemetry }
  | { ok: false; error: unknown;        telemetry: AttemptTelemetry };

interface AttemptTelemetry {
  attemptCount: number;
  wallClockMs: number;         // Binding-Dauer inkl. Backoffs
  backoffWaitedMs: number;
  netLatencyMs: number;
  retryCategoryCounts: Record<string, number>;
}
```

**Verantwortlichkeiten**:

- exakt eine Retry-Schleife (`maxAttempts`);
- kein Fallback;
- pro `singleCall` ein `AttemptEvent` an `ctx.diagnostics` (falls gesetzt);
- am Ende ein `BindingAttemptSummary`;
- **niemals** rekursiver `client.call()`;
- **fängt** Provider-/Parsing-/Timeout-Fehler und verpackt sie in `AttemptResult`; wirft nur bei tatsächlichen Programmierfehlern (z. B. `TypeError`);
- injizierbare `now`, `random` aus Client-Config.

### 3.4 Handler-Verdrahtung (`api/dql/verify.ts`)

```ts
const productionConfig = /* ... */;
const requireDiagnostics = productionConfig.diagnostics_on === true;
const requestId = extractRequestId(req);

// Collector nur bauen, wenn requireDiagnostics (sonst kein Flush)
const collector = requireDiagnostics
  ? new RuntimeDiagnosticsCollector(requestId, { /* caps */ })
  : undefined;

let flushEmitted = false;

try {
  const engineInput: EngineInput = { requestId, /* ... */, diagnostics: collector };
  const result = await runVerify(engineInput);
  return jsonResponse(result);
} catch (err) {
  return handleError(err);
} finally {
  if (collector) {
    try {
      const snap = collector.snapshot();
      diagnosticsEmitter({
        schemaVersion: 'dql.runtime_diagnostics.v1',
        kind: 'dql.runtime_diagnostics',
        requestId,
        runtimeIdentity: {
          configHash: productionConfig.__hash,
          v0431Active: productionConfig.v0431_active === true,
        },
        transitions: snap.transitions,
        staleResults: snap.staleResults.slice(0, 64),   // sekundäre Cap
        attempts: snap.attempts.slice(0, 128),
        summaries: snap.summaries,
        droppedCounts: snap.droppedCounts,
      });
      flushEmitted = true;
    } catch (flushErr) {
      try {
        console.error(JSON.stringify({
          kind: 'dql.runtime_diagnostics.flush_failed',
          requestId,
          errorName: (flushErr as Error)?.name,
        }));
      } catch { /* swallow */ }
    }
  }
}
```

**`diagnosticsEmitter`**: default `(envelope) => console.info(JSON.stringify(envelope))`, injizierbar (Tests + zukünftige Telemetry).

### 3.5 K5 + I10 — Factory-Safety

`ProductionConfig` bringt `diagnostics_on` mit. Der Client-Factory-Builder liest daraus:

```ts
const requireDiagnostics = config.diagnostics_on === true;
```

`requireDiagnostics` fließt in die Client-Instanz **außerhalb** von `clientOptionsOverride`:

```ts
const clientConfig = mergeSafety(
  {
    requireDiagnostics,
    capitalPathMode,
    disableCircuitBreaker,
  },
  {
    ...clientOptionsOverride,   // test-only
    ...baseClientOptions,       // production-safety wins
  },
);
```

`requireDiagnostics` gehört zur Safety-Ebene (wie CPM/disable_circuit_breaker) und wird nach dem Test-Override gemerged. Test kann es nicht abschalten.

Prüfung in Phase A:

```ts
if (clientConfig.requireDiagnostics && !ctx.diagnostics) {
  throw new Error(
    'DQL invariant: requireDiagnostics=true but ctx.diagnostics missing',
  );
}
```

---

## 4. Test-Plan v3 (21 Tests)

Aus v2 unverändert: 1–13. Ergänzung aus Hermes K1–K5:

| # | Test |
|---|---|
| 1 | Existing single-flight regression: unresolved Probe + paralleler Call → 1 Primary-Probe-Fetch |
| 2 | Probe-token stale: `wrong_generation` verworfen; nur neues Token schließt |
| 3 | Late normal result → `wrong_state` (Priorität nach K2-Regeln) |
| 4 | Exactly-once Transitions: 30 healthy → 0 events; 1 Trip → 1 `closed_to_open` |
| 5 | Attribution race: 2 Requests + 1 Breaker → nur verursachender Collector erhält Transition |
| 6 | Fetch-Budget: `maxAttempts=3`, Primary+Fallback exhaust → exakt 6 Fetches |
| 7 | Cyclic fallback map: `nano→swift→nano` → max 2 Branches |
| 8 | Latency symmetry: Success und exhausted Failure gleiche Times/Backoffs → gleicher `netLatencyMs` |
| 9 | Attempt telemetry: N Fetches → N `AttemptEvent`; 1 `BindingAttemptSummary`; 1 `recordOutcome` |
| 10 | Collector isolation: 2 Requests → 2 Collectors; 5 Axes desselben Requests → 1 Collector |
| 11 | Bounded/no-throw: Cap greift; werfender Flush verändert Response nicht |
| 12 | Diagnostics completeness: `requireDiagnostics=true` + fehlender Collector → Invariant-Fehler vor Fetch |
| 13 | Policy fingerprint: 7 ACTIVE-Felder einzeln flipsen → anderer `configHash` **UND** behavioral counter-proof (z. B. `windowAgeMs`: Age-Eviction; `minSamples`: Trip-Zeitpunkt; `cooldownMs`: Admission-Zeitpunkt) |
| **14** | HALF_OPEN-Failure erzeugt genau `half_open_to_open`, niemals `closed_to_open` |
| **15** | Normaler Token doppelt an `recordOutcome` → 1 Sample, 1 `stale_result{already_consumed}` |
| **16** | Cross-Breaker-Token: Token von A an B → `stale_result{invalid_token}`, keine State-Mutation in beiden |
| **17** | Plain-object-Kopie eines Tokens → `stale_result{invalid_token}` |
| **18** | Routing-Matrix vollständig: 4 Zeilen × 2 CPM-Werte = 8 behavioral tests |
| **19** | Unexpected throw nach Probe-Admission (defensiver `catch`) → Breaker verlässt HALF_OPEN via `recordOutcome(_, failure)` |
| **20** | Stale-Storm: 1000 `stale_result` verdrängen keine echte `closed_to_open`-Transition |
| **21** | `requireDiagnostics=true` bleibt aktiv trotz `clientOptionsOverride={requireDiagnostics:false}` |

Test 22 (Axis-Fork requestId-Match) als sanity check bei Bedarf zusätzlich.

---

## 5. Commit-Aufteilung + Deploy-Regel

### Commit E-core

Files:
- `src/engine/circuit-breaker.ts` — Event-Unions (K1), Tokens (K2), `admit`/`recordOutcome`, WeakSet, kein `now?`-Parameter, kein `reset()`
- `src/engine/circuit-breaker.test.ts` — auf neue API + Tests 1–4, 6, 13–17
- `src/config/production-config.ts` — H2 erweitert um windowSize/windowAgeMs/minSamples/probeMaxLatencyMs für ACTIVE; OFF byte-kompatibel; Bounds ohne Cross-Field-Regel
- `src/engine/production-runtime.ts` — `resolveCbByAlias` gibt 7 Felder zurück
- `src/config/production-config.ts` (bzw. wo `configHash` gebaut wird) — 7 Felder gehen in Hash ein
- `src/engine/llm-client.ts` — Signaturen umgestellt auf `admit`+`recordOutcome`; Events werden verworfen (Client-Sink kommt in C-Commit); K4-Routing-Matrix explizit implementiert; K5 `try/finally`-Wrapper; Preconditions vor Admission
- `src/engine/llm-client.test.ts` — Signaturen, Routing-Matrix (Tests 18), K5-Defensive-Failure (Test 19)

**Grün-Kriterium E-core**: alle 205 bestehenden Tests + neue CB-/Client-Tests grün. Client verwirft `events`. `requireDiagnostics`-Check darf noch OFF sein, weil kein Collector-Konsument existiert.

### Commit C+integration

Files:
- `src/engine/diagnostics.ts` (neu) — Collector mit requestId, separate Caps
- `src/engine/attempt-alias.ts` (neu) — flach, `now`/`random` injizierbar
- `src/engine/call-context.ts` — `diagnostics?` erweitert
- `src/types/engine.ts` — `EngineInput.diagnostics?`
- `src/engine/llm-client.ts` — Events → Collector; Symmetrie via `attemptAlias`; `requireDiagnostics` in Safety-Merge
- `api/dql/verify.ts` — Collector-Konstruktion, Flush in `finally`, injizierbarer Emitter
- `src/engine/diagnostics.test.ts`, `src/engine/attempt-alias.test.ts` (neu) — Tests 5, 7–12, 20, 21

**Grün-Kriterium C+integration**: alle 21 Tests grün.

### Deploy-Regel (verpflichtend)

- **Beide Commits lokal erstellen, gemeinsam pushen** (oder E-core nicht deployen/preflighten).
- **E-core-SHA darf nicht `alias_gate_ready=true` claimen**, weil ACTIVE + diagnostics_on-Events dort verworfen werden. Der `alias_gate_ready`-Vertrag ist erst mit C+integration-HEAD erfüllt.
- Zwischen den beiden Commits kein Canary-Run, kein Preflight-Green.

---

## 6. Was NICHT in §E+§C ist

- Kein OpenAPI-Delta.
- Kein `/dql/health`-Aggregat-Feld-Change.
- Kein `probeLeaseMs`.
- Kein öffentliches `reset()`.
- Keine willkürliche `probeMaxLatencyMs`-Cross-Field-Regel.
- Kein Kalibrierungs-Run.

---

## 7. Freigabestatus

v3 ist der bindende Implementierungsvertrag. Ich starte **E-core** auf `77c3345` sofort nach Bestätigung, dass v3 nichts aus dem Review verletzt. Falls Hermes noch Δ auf v3 findet, halte ich vor Push.
