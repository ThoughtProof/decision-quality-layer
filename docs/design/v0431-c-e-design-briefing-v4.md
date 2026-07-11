# Design-Skizze v4 — v0.4.3.1 §E + §C (Final, D1–D6 als bindender Vertrag)

**Repo-Basis**: `77c3345` auf `v0431-recovery-code`
**Vorgänger**: v3 + Hermes-Review `v0431-c-e-design-v3-review.md`
**Urteil v3**: "Sehr nah an final; HOLD wegen sechs innerer Widersprüche. Mit D1–D6 ist der Implementierungsvertrag vollständig freigegeben."
**Status v4**: alle Widersprüche aufgelöst; kein Restbestand offen.

---

## 0. Δ zu v3

| Δ | v3 | v4 (bindender Vertrag) |
|---|---|---|
| **D1** — K5-Control-Flow | `outcome` im `try`, `recordOutcome` im `finally`; Routing im `try` prüft nicht existierende `mutation` | `mutation` entsteht **im `try`** direkt nach `attemptAlias`; `completed`-Flag; `catch` liefert defensiv `recordOutcome(_, failure)`; Routing **nach** Mutation |
| **D2** — T2-Reason | erwartet `wrong_generation` | erwartet `already_consumed`; `wrong_generation`/`wrong_epoch` bleiben defensive Guards im Typ, sind ergebnisbasiert nicht natürlich erreichbar; keine Test-Hintertür |
| **D3** — CB-Konstruktor | `constructor(config, opts?)` verliert `name` | `constructor(name: string, config: CircuitBreakerConfig = {})` bleibt bestehen; `now` bleibt test-only Feld in `CircuitBreakerConfig` |
| **D4** — attemptAlias-Throw | fängt Provider-Fehler, wirft bei `TypeError` u. ä. | fängt **alle** Fehler aus `singleCall`/Fetch/Response-Parsing; `TypeError('fetch failed')` bleibt retrybar (existierendes Regex-Muster in `llm-client.ts:292`); "unexpected throw" = außerhalb Attempt-Boundary oder echter Invariantbruch, nicht JS-Klasse |
| **D5** — attemptedRoutes | „Primary immer eingetragen" | Route eingetragen **nur wenn Fetch tatsächlich gestartet** wurde; 6-Zeilen-Provenienzmatrix |
| **D6a** — Latency-Validation | keine | `Number.isFinite(netLatencyMs) && >= 0`; sonst Failure + internes `invalid_outcome`-Event |
| **D6b** — Epoch-Reset | teilweise | explizit: Init 0/0/0/0; CLOSED→OPEN bumpt tripGeneration, resettet recoveryEpoch=0; HALF_OPEN→OPEN gleiche Trip-Gen, recoveryEpoch++; HALF_OPEN→CLOSED bumpt closedEpoch, resettet recoveryEpoch=0; `probeSequence` global monoton |
| **Repo-Pfade** | `src/config/production-config.ts`, `src/types/engine.ts` | `src/engine/production-config.ts`, `src/engine/index.ts` (verifiziert) |
| **Stale-Success-Served** | implizit | explizit baseline-kompatibel: erfolgreicher Primary mit stale Mutation wird **served**; Response bleibt, State bleibt unverändert |
| **Fallback-Failure-Semantik** | pauschal fail-closed | Fallback-Fehler + Fallback-Breaker bleibt CLOSED → ursprünglicher Fallback-Fehler geworfen; kein tertiärer Hop |
| **`flushEmitted`** | Variable ohne Konsum | entfernt |
| **Emitter-Injection** | offen | reiner `emitDiagnostics(env, emitter = defaultEmitter)`-Helper; kein `currentEmitter`-Module-Scope |

---

## 1. Semantischer Vertrag (Invarianten)

I1–I12 aus v2/v3 unverändert. In v4 präzisiert:

- **I4** — In der ergebnisbasierten Epoch-Semantik sind `wrong_generation`/`wrong_epoch` **defensive Typ-Guards**, nicht natürliche Testfälle. Der eigentliche Beweis von I4 ist Test 15 (`already_consumed`) und Test 2 (dupliziertes Callback wird verworfen).
- **I5** — Attempt-Boundary umfasst alle Fehler aus `singleCall`, Fetch, Response-Parsing; unabhängig von JS-Fehlerklasse.
- **I8** — bleibt State-Machine-owned Attribution.
- **I11** — Bounds (Konservativ, ohne Cross-Field-Regel):
  - `windowSize`: `1..1000`
  - `windowAgeMs`: `> 0`
  - `minSamples`: `1..windowSize`
  - `probeMaxLatencyMs`: `> 0`

---

## 2. §E — CircuitBreaker Token-API (v4)

### 2.1 Event-Unions (K1 aus v3, unverändert)

Zwei disjoint Unions: `CircuitTransitionEvent` (4 kinds: closed_to_open, open_to_half_open, half_open_to_open, half_open_to_closed) und `CircuitStaleResultEvent` (kind: `stale_result`).

Zusätzlich neu in v4 wegen D6a: **`CircuitInvalidOutcomeEvent`**:

```ts
export type CircuitInvalidOutcomeEvent = {
  kind: 'invalid_outcome';
  reason: 'nan_latency' | 'infinite_latency' | 'negative_latency';
  alias: string;
  at: number;
  stateRevision: number;
};

export type CircuitDomainEvent =
  | CircuitTransitionEvent
  | CircuitStaleResultEvent
  | CircuitInvalidOutcomeEvent;
```

Verhalten: Bei ungültiger `netLatencyMs` in `recordOutcome`:

1. Token wird **konsumiert** (verhindert Stranden bei retry).
2. Behandlung als Failure (`ok=false`, `netLatencyMs=0`).
3. `invalid_outcome`-Event zusätzlich zu regulärem Transition-Event emittiert.
4. Kein Sample mit NaN/Infinity/negativer Zahl im Fenster.

### 2.2 Token-Identität (K2 aus v3)

Unverändert. `Object.freeze()` + private `WeakSet` issued/consumed. Reason-Priorität: `invalid_token > already_consumed > wrong_state > wrong_epoch|wrong_generation`.

**D2**: `wrong_generation`/`wrong_epoch` bleiben im Typ als defensive Guards, sind ergebnisbasiert **nicht natürlich erreichbar** (Probe-Token wird bei HALF_OPEN→OPEN bereits konsumiert; ein zweites `recordOutcome(same_token, …)` fällt in `already_consumed`). Keine Test-Hintertür.

### 2.3 Öffentliche API — Konstruktor bleibt (D3)

```ts
class CircuitBreaker {
  constructor(
    public readonly name: string,
    config: CircuitBreakerConfig = {},   // 'now' bleibt test-only Feld im Config-Interface
  );

  admit(): CircuitAdmission;                              // throws CircuitOpenError
  recordOutcome(
    token: CircuitAdmissionToken,
    outcome: { ok: boolean; netLatencyMs: number },
  ): CircuitMutationResult;
  snapshot(): CircuitSnapshot;
}

interface CircuitBreakerConfig {
  windowSize?: number;
  windowAgeMs?: number;
  tripFailureRate?: number;
  tripP90LatencyMs?: number;
  minSamples?: number;
  cooldownMs?: number;
  probeMaxLatencyMs?: number;
  now?: () => number;   // test-only, constructor-injected
}
```

Callsites in `HttpLlmClient.getBreaker()` (line 345) und Tests (`new CircuitBreaker('serv-nano', config)`) bleiben unverändert.

### 2.4 Interner Zustand — Epoch-Reset explizit (D6b)

```ts
private state: CircuitState = 'CLOSED';
private closedEpoch = 0;
private tripGeneration = 0;
private recoveryEpoch = 0;
private probeSequence = 0;   // global monoton, wird niemals wiederverwendet
private admissionSequence = 0;
private stateRevision = 0;
private openedAt: number | null = null;
private lastTripReason: string = '';
```

**Übergangsregeln**:

| Übergang | Änderungen |
|---|---|
| CLOSED → OPEN | `tripGeneration++`, `recoveryEpoch = 0`, `openedAt = now()`, `stateRevision++` |
| OPEN → HALF_OPEN | `probeSequence++`, `stateRevision++` (tripGeneration/recoveryEpoch unverändert) |
| HALF_OPEN → OPEN | `recoveryEpoch++`, `openedAt = now()`, `stateRevision++` (tripGeneration unverändert) |
| HALF_OPEN → CLOSED | `closedEpoch++`, `recoveryEpoch = 0`, `openedAt = null`, `stateRevision++` |

`probeSequence` inkrementiert **nur** bei `open_to_half_open`. Global monoton, niemals reset. Keine Wiederverwendung von Sequenzwerten.

### 2.5 `recordOutcome` — Prüfungsreihenfolge (D2 + D6a)

```
1. Identitätsprüfung (K2):
   - !issued.has(token)  → stale_result{invalid_token}, keine Mutation
   - consumed.has(token) → stale_result{already_consumed}, keine Mutation
   → sonst: consumed.add(token) (Token gilt jetzt als verbraucht)

2. Latency-Validierung (D6a):
   - !Number.isFinite(outcome.netLatencyMs) → invalid_outcome{nan_latency|infinite_latency}
     → outcome = { ok: false, netLatencyMs: 0 }; weitermachen mit State-Update
   - outcome.netLatencyMs < 0 → invalid_outcome{negative_latency}
     → outcome = { ok: false, netLatencyMs: 0 }; weitermachen

3. State-Prüfung (K2 Priorität):
   token.kind === 'normal':
     state !== CLOSED             → stale_result{wrong_state} (defensiv: closedEpoch mismatch → wrong_epoch)
     Sonst: Sample ins Fenster; tripCheck() → evtl. closed_to_open + tripGeneration++/recoveryEpoch=0

   token.kind === 'probe':
     state !== HALF_OPEN           → stale_result{wrong_state}
     Sonst (state === HALF_OPEN):
       Wenn ok && netLatencyMs <= probeMaxLatencyMs:
         HALF_OPEN → CLOSED; closedEpoch++; recoveryEpoch=0; event=half_open_to_closed
       Sonst:
         HALF_OPEN → OPEN; recoveryEpoch++; openedAt=now; event=half_open_to_open
```

**Wichtig**: Bei `stale_result{invalid_token|already_consumed}` wird das Token **nicht** in `consumed` aufgenommen (weil es entweder fremd ist oder schon konsumiert wurde). Das verhindert, dass ein wiederholt eingesetzter Fremdtoken die Registry vergiftet.

### 2.6 Config-Erweiterung (I11, unverändert aus v3)

Sieben Felder pro Alias in `ProductionConfig.circuit_breaker_config_by_alias[alias]`. Für ACTIVE required. OFF byte-kompatibel. Alle sieben in `configHash`.

**Repo-Pfad**: `src/engine/production-config.ts` (nicht `src/config/…`).

### 2.7 K5-Control-Flow (D1, KORRIGIERT)

`LlmClient.call()` primary-Zweig:

```ts
// PHASE A — Preconditions vor Admission (K5)
verifyAliasKnown(alias);
verifyApiKeyPresent(alias);
verifyRequireDiagnostics(ctx);           // I10
verifyInputShape(input);

// PHASE B — Admission
let primaryAdmission: CircuitAdmission;
try {
  primaryAdmission = primaryBreaker.admit();
} catch (e) {
  if (e instanceof CircuitOpenError) {
    // K4 Routing-Matrix: Admission abgewiesen
    return routeOnAdmissionReject(e, ctx, cpm);   // CPM → fail-closed, sonst → fallback ohne primary-in-attemptedRoutes
  }
  throw e;
}
emit(primaryAdmission.events, ctx?.diagnostics);

// PHASE C — Attempt mit garantiertem Abschluss (D1)
let primaryResult: AttemptResult;
let primaryMutation: CircuitMutationResult;
let completed = false;

try {
  primaryResult = await attemptAlias(primaryBinding, input, ctx, 'primary');
  // recordOutcome IM try, nicht im finally, damit routing es lesen kann
  primaryMutation = primaryBreaker.recordOutcome(primaryAdmission.token, {
    ok: primaryResult.ok,
    netLatencyMs: primaryResult.telemetry.netLatencyMs,
  });
  completed = true;
  emit(primaryMutation.events, ctx?.diagnostics);
} catch (unexpected) {
  // Nur pathologischer Throw außerhalb attemptAlias-Boundary
  if (!completed) {
    const defensive = primaryBreaker.recordOutcome(primaryAdmission.token, {
      ok: false,
      netLatencyMs: 0,
    });
    emit(defensive.events, ctx?.diagnostics);
  }
  throw unexpected;
}

// PHASE D — Routing (K4), erst nach Mutation
return routeFrom(primaryResult, primaryMutation, ctx, cpm, primaryBinding, fallbackBinding);
```

**`routeFrom`** implementiert D5-Provenienzmatrix:

```
primaryResult.ok:
  → return primaryResult.output  (attemptedRoutes: ['primary'])

!primaryResult.ok && primaryMutation.accepted && breakerStateAfter === CLOSED:
  // Ordinary failure, Breaker bleibt CLOSED → kein Fallback, ursprünglicher Fehler
  → throw primaryResult.error  (attemptedRoutes: ['primary'])

!primaryResult.ok && (breakerStateAfter === OPEN || HALF_OPEN):
  // Trip/reopen
  if (cpm) → fail-closed  (attemptedRoutes: ['primary'])
  else     → attemptFallback(primaryError, ctx, fallbackBinding, ['primary'])

Sonderfall stale-success:
  primaryResult.ok && !primaryMutation.accepted (wrong_state):
  → primaryResult.output wird served (baseline-kompatibel: alter Success bleibt Response;
     State bleibt unverändert)  (attemptedRoutes: ['primary'])
```

**Fallback-Zweig** (D5):

```ts
// Admission
try {
  fbAdmission = fallbackBreaker.admit();
} catch (CircuitOpenError) {
  // Admission abgewiesen → Fallback NICHT in attemptedRoutes; werfe primaryError oder fail-closed
  throw wrapAllOpen(primaryError, fallbackAdmissionError);
}
emit(fbAdmission.events);

// Attempt
try {
  fbResult = await attemptAlias(fallbackBinding, input, ctx, 'fallback');
  fbMutation = fallbackBreaker.recordOutcome(fbAdmission.token, { ok: fbResult.ok, netLatencyMs: fbResult.telemetry.netLatencyMs });
  completed = true;
  emit(fbMutation.events);
} catch (unexpected) {
  if (!completed) { defensive recordOutcome + emit }
  throw unexpected;
}

// attemptedRoutes ergänzen (D5): Fallback wird eingetragen NUR wenn Fetch gestartet wurde
attemptedRoutes.push('fallback');

if (fbResult.ok) return fbResult.output;
throw fbResult.error;   // baseline: kein tertiärer Hop, kein CircuitAllOpenError bei ordinary failure
```

### 2.8 K4-Routing-Matrix (Baseline-kompatibel)

| Primary-Situation | CPM=false | CPM=true |
|---|---|---|
| `admit()` wirft `CircuitOpenError` | Fallback versuchen; `attemptedRoutes` startet leer (Primary nicht gefetcht) | fail-closed, kein Fetch, `attemptedRoutes=[]` |
| Primary-Fetch `ok=false`, Breaker bleibt CLOSED | ursprünglicher Fehler; kein Fallback; `attemptedRoutes=['primary']` | ursprünglicher Fehler; `attemptedRoutes=['primary']` |
| Primary-Fetch `ok=false`, Breaker trippt/reopent (OPEN/HALF_OPEN nach Mutation) | Fallback; `attemptedRoutes` beginnt mit `['primary']` | fail-closed; `attemptedRoutes=['primary']` |
| Primary-Fetch `ok=true` | Erfolg; `attemptedRoutes=['primary']` | Erfolg; `attemptedRoutes=['primary']` |
| Stale-success (primary.ok + wrong_state) | Erfolg served; State unverändert; `attemptedRoutes=['primary']` | dito |

**Fallback-Provenienz**:

| Ablauf | `attemptedRoutes` bei terminalem Fehler |
|---|---|
| Primary-Admission abgewiesen; Fallback-Admission ebenfalls abgewiesen | `[]` |
| Primary-Admission abgewiesen; Fallback-Fetch versucht und scheitert | `['fallback']` |
| Primary-Fetch scheitert/trippt; Fallback-Admission abgewiesen | `['primary']` |
| Primary-Fetch scheitert/trippt; Fallback-Fetch scheitert | `['primary','fallback']` |
| CPM + Primary-Admission abgewiesen | `[]` |
| CPM + Primary-Fetch scheitert und öffnet/reöffnet | `['primary']` |

---

## 3. §C — RuntimeDiagnosticsCollector (v4)

### 3.1 Types (D6a-Erweiterung)

```ts
export interface RuntimeDiagnosticsSnapshot {
  readonly requestId: string;
  readonly transitions: readonly CircuitTransitionEvent[];
  readonly staleResults: readonly CircuitStaleResultEvent[];
  readonly invalidOutcomes: readonly CircuitInvalidOutcomeEvent[];   // NEU (D6a)
  readonly attempts: readonly AttemptEvent[];
  readonly summaries: readonly BindingAttemptSummary[];
  readonly droppedCounts: {
    readonly transitions: number;
    readonly staleResults: number;
    readonly invalidOutcomes: number;   // NEU
    readonly attempts: number;
    readonly summaries: number;
  };
}
```

Caps (aus v3): getrennte `maxTransitionEvents`, `maxStaleResultEvents`, `maxInvalidOutcomeEvents` (default 32), `maxAttemptEvents`, `maxBindingSummaries`. Kein gemeinsamer Cap.

### 3.2 `AttemptEvent`/`BindingAttemptSummary` (aus v3, D4-präzisiert)

`errorCategory` wird anhand stabiler Fakten klassifiziert (D4):

- **timeout**: eigener Timeout-Marker / AbortController triggered
- **rate_limit**: HTTP 429
- **http_5xx**: HTTP-Status ≥ 500
- **network**: Fetch-Catch (inkl. `TypeError('fetch failed')`, `ECONNRESET`, etc.)
- **other**: alles andere

**Wichtig**: Keine Diagnostics-Klassifikation aus vollständigen Error-Strings nach außen. Nur die Kategorie und ggf. HTTP-Status. Kein `retryReasons`-Leak.

### 3.3 `attemptAlias`-Helper (D4-präzisiert)

```ts
async function attemptAlias(
  binding: BindingConfig,
  input: LlmCallInput,
  ctx: CallContext,
  route: 'primary' | 'fallback',
): Promise<AttemptResult>
```

**Boundary-Regel** (D4):

- **Alle** Fehler aus `singleCall`, Fetch, Response-Parsing werden gefangen und in `AttemptResult{ok:false, error, telemetry}` verpackt.
- Retry-Klassifikation nutzt das **existierende Regex-Muster** (`llm-client.ts:292`, `/429|too many|rate|proxy|fetch failed|ECONN|ETIMEDOUT|EAI_AGAIN|socket hang up|aborted|timeout/i`), damit `TypeError('fetch failed')` retrybar bleibt und keine Regression entsteht.
- `LlmCallOutput.retryReasons` bleibt Baseline-kompatibel.
- "Unexpected throw" = Fehler außerhalb dieser Boundary (z. B. Bug im Helper selbst) — nicht JS-Klasse.

### 3.4 `EngineInput`-Erweiterung (D3-Pfadkorrektur)

`src/engine/index.ts` (nicht `src/types/engine.ts`):

```ts
interface EngineInput {
  // bestehend
  requestId: string;
  // NEU
  diagnostics?: RuntimeDiagnosticsCollector;
}
```

Engine-Axis-Fork:
```ts
const ctx: CallContext = {
  requestId: input.requestId,
  axis,
  callId: generateCallId(),
  diagnostics: input.diagnostics,
};

if (ctx.diagnostics && ctx.diagnostics.requestId !== ctx.requestId) {
  throw new Error('DQL invariant: diagnostics.requestId mismatch');
}
```

### 3.5 Handler-Verdrahtung (`api/dql/verify.ts`)

```ts
const productionConfig = /* ... */;
const requireDiagnostics = productionConfig.diagnostics_on === true;
const requestId = extractRequestId(req);

const collector = requireDiagnostics
  ? new RuntimeDiagnosticsCollector(requestId, { /* caps */ })
  : undefined;

try {
  const engineInput: EngineInput = {
    requestId,
    // ...
    diagnostics: collector,
  };
  const result = await runVerify(engineInput);
  return jsonResponse(result);
} catch (err) {
  return handleError(err);
} finally {
  if (collector) {
    try {
      const snap = collector.snapshot();
      emitDiagnostics({
        schemaVersion: 'dql.runtime_diagnostics.v1',
        kind: 'dql.runtime_diagnostics',
        requestId,
        runtimeIdentity: {
          configHash: productionConfig.__hash,
          v0431Active: productionConfig.v0431_active === true,
        },
        transitions: snap.transitions,
        staleResults: snap.staleResults.slice(0, 64),
        invalidOutcomes: snap.invalidOutcomes,
        attempts: snap.attempts.slice(0, 128),
        summaries: snap.summaries,
        droppedCounts: snap.droppedCounts,
      });
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

Kein `flushEmitted`. Kein modulares `currentEmitter`.

### 3.6 Emitter-Injection (v4-Korrektur)

```ts
type DiagnosticsEmitter = (envelope: DiagnosticsEnvelope) => void;

const defaultEmitter: DiagnosticsEmitter = (env) =>
  console.info(JSON.stringify(env));

export function emitDiagnostics(
  envelope: DiagnosticsEnvelope,
  emitter: DiagnosticsEmitter = defaultEmitter,
): void {
  emitter(envelope);
}
```

Für Tests wird der Emitter über die Handler-Factory oder eine Parameter-Injection gesetzt, nicht über einen `let currentEmitter`-Module-Scope.

---

## 4. Test-Plan v4 (22 Tests)

Aus v3 unverändert übernommen: 1, 3–21. **Ergänzungen und Änderungen**:

| # | Test |
|---|---|
| 1 | Existing single-flight regression |
| **2** | **Duplicate probe callback → `already_consumed`** (nicht `wrong_generation`); nur neues Token schließt |
| 3 | Late normal result → `wrong_state` |
| 4 | Exactly-once transitions |
| 5 | Attribution race |
| 6 | Fetch-Budget: `maxAttempts=3`, exhaust → 6 Fetches |
| 7 | Cyclic fallback map |
| 8 | Latency symmetry |
| 9 | Attempt telemetry: N Fetches → N events, 1 summary, 1 recordOutcome |
| 10 | Collector isolation |
| 11 | Bounded/no-throw |
| 12 | Diagnostics completeness |
| 13 | Policy fingerprint: 7 Felder, Hash-Flip **und** behavioral counter-proof |
| 14 | HALF_OPEN failure → `half_open_to_open`, niemals `closed_to_open` |
| 15 | Duplicate consume → `already_consumed`, 1 Sample, 1 Event |
| 16 | Cross-Breaker-Token → `invalid_token` |
| 17 | Plain-Object-Forge → `invalid_token` |
| 18 | Routing-Matrix 4×2 |
| 19 | Unexpected throw defensive path |
| 20 | Stale-Storm verdrängt keine Transitionen |
| 21 | `requireDiagnostics` test-override-fest |
| **22** | **`TypeError('fetch failed')` bleibt retrybar** (D4 anti-regression) |
| **23** | **`attemptedRoutes` provenance matrix** (D5, 6 Zeilen) |
| **24** | **Invalid latency (NaN/Infinity/negative)** → `invalid_outcome`-Event, Probe konsumiert, kein NaN im Fenster |
| **25** | **Epoch reset** — CLOSED→OPEN→HALF_OPEN→CLOSED: `recoveryEpoch` resettet, `closedEpoch++`, `tripGeneration` unverändert nach Reopen im selben Zyklus, `probeSequence` monoton |
| **26** | **Stale-success served**: primary.ok + wrong_state → response served, State unverändert |

Test 22 als anti-regression gegen D4 ist zwingend. Tests 23–26 sind D5/D6-neu.

---

## 5. Commit-Aufteilung + Deploy-Regel (aus v3 unverändert)

### E-core (Repo-Pfade v4)

Files:
- `src/engine/circuit-breaker.ts` — Event-Unions, Tokens, `admit`/`recordOutcome`, D6b-Epochs, D6a-Latency-Validation; Konstruktor-Signatur `(name, config)` unverändert
- `src/engine/circuit-breaker.test.ts` — Tests 1–4, 6, 13–17, 24, 25
- `src/engine/production-config.ts` — H2-Erweiterung um 4 Felder für ACTIVE; OFF byte-kompatibel; Bounds; `configHash` erweitert
- `src/engine/production-runtime.ts` — `resolveCbByAlias` 7 Felder
- `src/engine/llm-client.ts` — D1-Control-Flow (`try` enthält recordOutcome), D5-Provenienz, K4-Routing, `admit`/`recordOutcome` (Events verworfen bis C-Commit)
- `src/engine/llm-client.test.ts` — Signatur-Update, Tests 18, 19, 22, 23, 26

**Grün-Kriterium E-core**: alle bestehenden 205 Tests + neue E-core-Tests grün.

### C+integration

Files:
- `src/engine/diagnostics.ts` (neu)
- `src/engine/attempt-alias.ts` (neu)
- `src/engine/index.ts` — `EngineInput.diagnostics?`
- `src/engine/llm-client.ts` — Events → Collector; `attemptAlias` eingezogen; `requireDiagnostics` in Safety-Merge
- `api/dql/verify.ts` — Collector, Flush in `finally`, `emitDiagnostics`-Helper
- `src/engine/diagnostics.test.ts`, `src/engine/attempt-alias.test.ts` — Tests 5, 7–12, 20, 21

**Grün-Kriterium C+integration**: alle 26 Tests grün.

### Deploy-Regel

Beide Commits lokal + gemeinsam pushen. E-core-SHA claimt **kein** `alias_gate_ready=true`. Nur C+integration-HEAD erfüllt den vollen Vertrag.

---

## 6. Freigabestatus

v4 ist der finale bindende Implementierungsvertrag. Ich starte **E-core** auf `77c3345` unmittelbar nach Sanity-ACK von Hermes auf v4.
