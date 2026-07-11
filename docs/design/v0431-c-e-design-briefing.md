# Design-Skizze §C + §E — Diagnostics + HALF_OPEN Single-flight

**Ziel-Commit:** `77c3345` + §C + §E (kombiniert oder als zwei aufeinander folgende Commits — Frage siehe Ende)
**Basis:** Hermes-Review `v0431-pr12-h1h2-77c3345-review.md` (H1+H2 geschlossen, Collector freigegeben)
**Adressiert:** Die sechs Stateful-Gate-Invarianten aus dem Freigabetext.

Diese Skizze ist **noch kein Code**. Sie friert die Semantik ein, damit Hermes vor der Implementierung Semantik-Bugs kippen kann (spart eine Review-Runde).

## 0. Ist-Zustand (nur Fakten aus dem Repo)

- `src/engine/circuit-breaker.ts`
  - `canProceed()` transitioniert OPEN→HALF_OPEN **synchron beim ersten Aufruf nach Cooldown**. Der zweite gleichzeitig eintreffende `canProceed()` sieht `state==='HALF_OPEN'` und wirft `probe request already in flight`.
  - Keine Generation / Epoch. `recordSuccess` / `recordFailure` haben keine Möglichkeit zu prüfen, ob das Result noch zur aktuellen HALF_OPEN-Runde gehört.
  - Kein Event-Sink, nur `snapshot()`.
- `src/engine/llm-client.ts`
  - `call()` ruft `canProceed()` synchron **vor** `await callWithRetry(...)`.
  - `recordSuccess` bekommt `netLatency = wallClock − backoffWaitedMs` (PR #11), `recordFailure` bekommt `wallClock`.
  - `callViaFallback` verwendet dieselbe `callWithRetry`; die Attempt-Grenze `maxAttempts` gilt **pro Binding**.
  - Es gibt keinen Diagnostics-Transport zwischen Client und Handler.

## 1. Semantische Invarianten (Hermes-Freigabepunkte)

Die sechs Invarianten aus dem Freigabetext werden hier nummeriert. Jede spätere Test- und Codestelle referenziert diese Nummern.

- **I1 — Request-scoped Eventtransport.** Diagnostics-Events werden auf ein pro Request-Instanz erzeugtes Objekt geschrieben. Kein Module-scope-Sink, kein singleton. Zwei parallele Requests im selben Warm-Container teilen **keinen** Sink.
- **I2 — Exactly-once Transition-Capture.** Jede CB-State-Transition (CLOSED→OPEN, OPEN→HALF_OPEN, HALF_OPEN→CLOSED, HALF_OPEN→OPEN) erzeugt **genau ein** Event, unabhängig davon, ob während des Requests retried, gefallbackt oder rekursiv gerufen wurde.
- **I3 — Sync Single-flight-Claim vor erstem `await`.** Der OPEN→HALF_OPEN-Wechsel + Beanspruchung der Probe-Slot muss **im gleichen synchronen Frame** stattfinden wie die Prüfung. Zwischen Prüfung und Beanspruchung darf **kein `await`** liegen. Ein zweiter, im selben Tick eintreffender Request muss die Beanspruchung als bereits vergeben sehen.
- **I4 — Generation/Epoch-Stale-Result-Abwehr.** Jede Probe (HALF_OPEN-Runde) trägt eine monoton wachsende Generation-Id. Kommt ein `recordSuccess` / `recordFailure` mit einer Generation zurück, die nicht mehr die aktive ist (weil die Probe längst als Failure gezählt, Cooldown neu gestartet und die nächste Probe schon läuft), wird das Ergebnis **verworfen** und diagnostisch als `stale_probe_result` protokolliert.
- **I5 — Non-rekursive Attempt-Grenze.** Der komplette Aufruf `LlmClient.call()` verbraucht **höchstens `maxAttempts × 2`** SERV-fetches über beide Bindings (primary + fallback) zusammen. Es gibt **keinen** re-entranten `call()`-Aufruf, weder aus `callViaFallback` noch aus einer künftigen tertiären Route. `callViaFallback` bleibt ein flacher Zweig.
- **I6 — Identische Net-Latency-Semantik Normal ↔ Recovery.** `netLatency` wird auf beiden Pfaden (primary + fallback) identisch berechnet: `wallClock − backoffWaitedMs`, minimum 0. Für die HALF_OPEN-Probe-Entscheidung (`probeMaxLatencyMs`) wird **derselbe** `netLatency`-Wert verwendet, den auch die Failure-Rate-Window sieht. Kein separater Wall-Clock-Vergleich, keine versteckten Backoff-Waits im Probe-Signal.

## 2. §C — RuntimeDiagnosticsCollector

### 2.1 Zweck
Ein Objekt, das pro Verify-Request erzeugt wird und CB-Transitionen, Attempt-Statistiken und Route-Provenienz sammelt — für spätere Aufnahme in `/dql/verify`-Response, Manifest und `/dql/health`-Aggregat. In dieser Skizze **nur Sammlung**, kein API-Delta (das kommt separat in §OpenAPI).

### 2.2 API-Umriss

```ts
// src/engine/diagnostics.ts (neu)
export type CbTransition =
  | 'closed_to_open'
  | 'open_to_half_open'
  | 'half_open_to_closed'
  | 'half_open_to_open';

export interface CbTransitionEvent {
  alias: string;
  from: CircuitState;
  to: CircuitState;
  transition: CbTransition;
  at: number;               // ms since epoch
  generation: number;       // I4
  reason: string;
  sampleCount: number;
  failureRate: number;
  p90LatencyMs: number;
}

export interface StaleProbeEvent {
  alias: string;
  generation: number;       // the stale one
  currentGeneration: number;
  outcome: 'success' | 'failure';
  observedLatencyMs: number;
  at: number;
}

export interface AttemptEvent {
  alias: string;
  attempt: number;
  outcome: 'success' | 'failure';
  netLatencyMs: number;
  backoffWaitedMs: number;
}

export interface RuntimeDiagnosticsCollector {
  readonly requestId: string;
  onTransition(event: CbTransitionEvent): void;
  onStaleProbe(event: StaleProbeEvent): void;
  onAttempt(event: AttemptEvent): void;
  snapshot(): DiagnosticsSnapshot;
}

export interface DiagnosticsSnapshot {
  requestId: string;
  transitions: readonly CbTransitionEvent[];
  staleProbes: readonly StaleProbeEvent[];
  attempts: readonly AttemptEvent[];
  // aggregate (derived, not stored):
  aliasAttemptCount: Record<string, number>;
  aliasFailureCount: Record<string, number>;
}
```

### 2.3 Erzeugung + Injection

- Erzeugt in `api/dql/verify.ts` (Handler-Cold-Start-Bundle **nicht** — das ist Module-scope).
- Pro Request neue Instanz: `const diag = createRuntimeDiagnosticsCollector(reqId)`.
- Übergeben an `runtime.cascade.classify(input, { diagnostics: diag })` (neuer optionaler Feldname im `CascadeContext`).
- Cascade reicht sie an `client.call(alias, input, { diagnostics: diag })` durch (existiert `CallContext` bereits, wird ergänzt).
- **I1** wird durch die per-Request-Erzeugung erzwungen. `client` speichert die Referenz **nicht**; er ruft `diag.onXxx(...)` durch, wenn im aktuellen `call()`-Frame vorhanden.

### 2.4 Wie die Events in den Client kommen

Der Client selbst hat den CB. Der CB kennt aber den Diagnostics-Sink **nicht** — der Sink wird pro-Call vom Client durchgereicht. Zwei Optionen:

- **Option A**: Der Client wrappt jeden `canProceed` / `recordSuccess` / `recordFailure` und liest **danach** aus `cb.snapshot()`, ob sich `state` gegenüber vorher geändert hat. Delta → Event.
- **Option B**: Der `CircuitBreaker` akzeptiert im Konstruktor eine `TransitionListener`-Funktion, die pro Instanz gebunden ist. Dann kann der Sink aber nicht pro-Request wechseln.

**Empfehlung: Option A.** Behält die pro-Request-Isolation, ohne den CB an einen langlebigen Sink zu binden.

Skizze (im Client, vereinfacht):

```ts
const before = breaker.snapshot().state;
try { breaker.canProceed(); }
catch (e) { … }
const afterProceed = breaker.snapshot().state;
if (before !== afterProceed) diag?.onTransition({...});
```

Für die HALF_OPEN-Ergebnisse analog nach `recordSuccess` / `recordFailure`.

### 2.5 Exactly-once (I2)

- Der State-Vergleich `before !== after` liefert automatisch max. ein Event pro API-Call.
- `close()` und `trip()` sind synchron im CB; das Delta zeigt sich **immer** genau im nächsten Snapshot-Read.
- Retry-Cluster ohne Trip erzeugen **kein** Transition-Event (state bleibt CLOSED). Sie erzeugen `onAttempt`-Events (n Stück), was gewollt ist.

## 3. §E — HALF_OPEN Single-flight + Generation

### 3.1 Kern-Änderung im CB

`CircuitBreaker` erhält:

```ts
private generation = 0;
private probeInFlight: boolean = false;

canProceed(): { admitted: boolean; generation: number } { … }
recordSuccess(latencyMs: number, generation: number): void { … }
recordFailure(latencyMs: number, generation: number): void { … }
```

**Warum Rückgabewert statt Throw**: Der bisherige Throw-basierte Rückweg (`CircuitOpenError`) bleibt für den Client sichtbar, aber die **Beanspruchung** der Probe-Slot passiert synchron im Return. Diskussion offen — siehe Punkt 6.1.

### 3.2 State-Übergang (Pseudocode)

```
canProceed():
  if state === CLOSED:
    return { admitted: true, generation: generation }

  if state === OPEN:
    if now() - openedAt < cooldownMs:
      throw CircuitOpenError(OPEN, lastTripReason)
    // Cooldown elapsed. ATOMAR im selben Frame:
    state = HALF_OPEN
    probeInFlight = true
    generation += 1
    return { admitted: true, generation: generation }

  // HALF_OPEN
  if probeInFlight:
    throw CircuitOpenError(HALF_OPEN, 'probe request already in flight')
  // Sollte nicht erreicht werden — HALF_OPEN ohne probeInFlight ist ein Bug.
  // Defensive: als OPEN behandeln.
  throw CircuitOpenError(HALF_OPEN, 'unexpected state, no active probe')
```

**Kernpunkt I3**: Der Übergang OPEN→HALF_OPEN + `probeInFlight = true` erfolgt in **einer synchronen Sequenz** ohne `await`. JavaScript ist single-threaded innerhalb eines Ticks; damit ist das per Definition race-frei gegen andere JS-Contexts im selben Prozess.

### 3.3 Probe-Ergebnis mit Generation-Check (I4)

```
recordSuccess(latencyMs, generation):
  if state !== HALF_OPEN or generation !== this.generation:
    diag?.onStaleProbe({ …, outcome: 'success', currentGeneration: this.generation })
    return  // silently drop
  probeInFlight = false
  if latencyMs <= probeMaxLatencyMs:
    close()      // state=CLOSED, samples=[], openedAt=null
  else:
    trip('probe succeeded but latency too high')

recordFailure(latencyMs, generation):
  if state !== HALF_OPEN or generation !== this.generation:
    diag?.onStaleProbe({ …, outcome: 'failure' })
    return
  probeInFlight = false
  trip('probe failed')
```

**Warum das I4 löst**: Wenn Probe A (Generation=1) 60s hängt, die Cooldown zwischenzeitlich als Timeout-Result mit Generation=1 als failure gemeldet wird, `state=OPEN` gesetzt wird, die neue Cooldown abläuft und Probe B (Generation=2) startet — dann kommt Probe A's echtes Netzwerk-Result irgendwann später zurück. Ohne Generation-Check würde es Probe B's noch nicht abgeschlossene HALF_OPEN-Runde stören. Mit Generation-Check wird es verworfen und diagnostisch als `stale_probe_result` verbucht.

### 3.4 Backpressure für parallel eintreffende Requests

- Request B während `probeInFlight=true`: `canProceed()` wirft `CircuitOpenError('HALF_OPEN', 'probe request already in flight')`.
- Der Client fasst das genau wie „primary war schon offen" auf und routet zu Fallback (falls nicht CPM).
- **Wichtig**: Das ist **kein** Bug — es ist das gewünschte Verhalten. Nur EIN Probe pro Runde. Parallele Requests akzeptieren die Fallback-Route.

## 4. Client-Anbindung (`llm-client.ts`)

### 4.1 Neuer `CallContext` (Erweiterung des existierenden)

```ts
export interface CallContext {
  diagnostics?: RuntimeDiagnosticsCollector;
  // (aktuell schon: request-id-tracking-Felder; werden weiter durchgereicht)
}
```

### 4.2 Änderung im primary path

```ts
const primaryBreaker = this.getBreaker(modelAlias);
let claim: { admitted: boolean; generation: number };
try {
  claim = primaryBreaker.canProceed();
} catch (err) {
  // OPEN oder HALF_OPEN-in-flight — fallback route (oder CPM fail-closed).
  emitTransitionIfChanged(before, primaryBreaker, ctx.diagnostics);
  …
}
emitTransitionIfChanged(before, primaryBreaker, ctx.diagnostics);

const started = Date.now();
try {
  const out = await this.callWithRetry(binding, input);
  const netLatency = Math.max(0, (Date.now() - started) - (out.backoffWaitedMs ?? 0));
  const stateBeforeRecord = primaryBreaker.snapshot().state;
  primaryBreaker.recordSuccess(netLatency, claim.generation);
  emitTransitionIfChanged(stateBeforeRecord, primaryBreaker, ctx.diagnostics);
  ctx.diagnostics?.onAttempt({ alias: modelAlias, attempt: out.attemptCount ?? 1,
    outcome: 'success', netLatencyMs: netLatency, backoffWaitedMs: out.backoffWaitedMs ?? 0 });
  return { ...out, providerRoute: 'primary' };
} catch (err) {
  const netLatency = Math.max(0, (Date.now() - started) /* − 0, no backoffWaited exposed here */);
  const stateBeforeRecord = primaryBreaker.snapshot().state;
  primaryBreaker.recordFailure(netLatency, claim.generation);
  emitTransitionIfChanged(stateBeforeRecord, primaryBreaker, ctx.diagnostics);
  ctx.diagnostics?.onAttempt({ alias: modelAlias, attempt: /* n/a */ 0,
    outcome: 'failure', netLatencyMs: netLatency, backoffWaitedMs: 0 });
  // Trip check → Fallback wie bisher (mit CPM-Guard).
  …
}
```

**Offener Punkt (I6)**: Für den **failure**-Pfad wird aktuell `Date.now() - started` (wall-clock) an `recordFailure` gegeben. Für strikte I6-Konsistenz sollten wir hier ebenfalls `backoffWaitedMs` abziehen. Das erfordert eine Anpassung von `callWithRetry`, damit auch der Throw-Pfad `backoffWaitedMs` bis dahin bekannt macht (z.B. via einer speziellen `CallWithRetryFailure`-Fehlerklasse, die `backoffWaitedMs` mitträgt). **Empfehlung:** Diese Symmetrie in §E mit-fixen; sonst bleibt das Failure-Sample „inflatiert um Backoff-Waits" und der CB trippt schneller aus wall-clock-Gründen als aus Netzwerk-Gründen.

### 4.3 `callViaFallback` — analoge Anpassung

Gleiche Änderungen im fallback-Zweig. `probeInFlight` wird auf dem Fallback-Breaker unabhängig gehandhabt.

## 5. Attempt-Grenze (I5)

- `LlmClient.call` konsumiert **maximal** `2 × maxAttempts` SERV-Fetches: `maxAttempts` auf primary (falls Probe passiert und retryt) + `maxAttempts` auf fallback (falls Fallback passiert und retryt).
- **Keine** Rekursion aus `callViaFallback` heraus.
- Falls in Zukunft eine tertiäre Route eingeführt wird: sie darf **nicht** `client.call()` re-entrant aufrufen; sie muss als weiterer flacher Zweig geführt werden. Wird als **Code-Comment im Client verewigt.**
- Statischer Test: `grep -c "callViaFallback\|client.call(" llm-client.ts` sollte für `client.call(` **1** ergeben. Wird in der Test-Suite als Regex-Guard eingebaut.

## 6. Offene Fragen an Hermes (vor Codebeginn)

1. **Rückgabewert von `canProceed`**. Aktuell wirft die Methode. Der Entwurf gibt jetzt zusätzlich `{ admitted, generation }` zurück. **Alternative**: `canProceed` bleibt void/throw, es gibt einen zweiten synchronen Aufruf `claimProbe(): { generation }`, den nur der Client aufruft. Das erlaubt CB-Legacy-Callsites unverändert.  
   **Empfehlung:** Rückgabewert-Erweiterung, weil sonst zwei synchrone Calls ohne `await` dazwischen konzeptionell zwei Frames sind (auch wenn JS-single-threaded).
2. **Sink-Injection**: Option A (Delta aus `snapshot()`) vs. Option B (Konstruktor-Listener). Ich habe Option A gewählt (pro-Request-Isolation), bitte bestätigen.
3. **I6-Failure-Symmetrie**: Sollen wir jetzt (§E) `callWithRetry` so ändern, dass es `backoffWaitedMs` auch im Throw-Pfad zugänglich macht — oder in einem separaten Commit? Ich präferiere **jetzt**, weil sonst I6 nur halb erfüllt ist.
4. **Attempt-Grenze-Sanity-Check**: Regex-Test im Test-Suite akzeptabel, oder soll das als AST-Test / ESLint-Regel eingebaut werden?
5. **OpenAPI-Delta**: In §C/§E noch **keine** neuen Felder in `/dql/verify` oder `/dql/health`. Nur Sammlung. Aufnahme in Response-Schema wird ein separater OpenAPI-Delta-Commit. Bestätigt?
6. **Commit-Struktur**: §C und §E in **einem** Commit oder **zwei** aufeinander folgend? Der Kopplungs-Punkt ist der CB-Generation-Rückgabewert — sobald der da ist, will der Client sofort die neuen Events emittieren, sonst haben wir einen Zwischenzustand ohne Diagnostics. Ich präferiere **einen** Commit „§C+§E: request-scoped diagnostics + HALF_OPEN single-flight with generation".

## 7. Tests, die vor Merge grün sein müssen

Alle mit `vi.useFakeTimers` + injected `now`. Diskriminierend gegenüber der aktuellen 205-Test-Baseline:

- **T-I3-1 (Race-Repro)**: Zwei parallele `call()`-Aufrufe im selben Tick nach Cooldown. Beide sehen den OPEN-Zustand vor der Beanspruchung. Vor §E: beide bekommen HALF_OPEN und dürfen weiter. Nach §E: erster bekommt HALF_OPEN, zweiter wirft `probe request already in flight` und geht auf Fallback.
- **T-I4-1 (Stale-Repro)**: Probe A startet. Test-Uhr zieht 2× cooldown weiter; Probe A's Result kommt zurück. `diag.staleProbes` enthält genau ein Event mit generation=1, currentGeneration=2 (weil zwischenzeitlich Probe B lief).
- **T-I2-1 (Exactly-once)**: 30 aufeinanderfolgende erfolgreiche primary calls → 0 Transitionen. Ein Trip → 1 `closed_to_open`. Cooldown-Ablauf + Probe-Success → `open_to_half_open` + `half_open_to_closed` (**2** Events, nicht 3).
- **T-I5-1 (Attempt-Grenze)**: Instrumentierter `fetchImpl` zählt Aufrufe. Mit `maxAttempts=3` und primary+fallback beide retryen bis exhaust → exakt 6 fetches, nie mehr.
- **T-I6-1 (Latency-Symmetrie)**: Sowohl Success als auch Failure führen zu Samples, die um `backoffWaitedMs` reduziert sind. Zwei fake-timer-gesteuerte Backoff-Cluster (2s + 4s) auf Success vs. Failure → CB sieht auf beiden Seiten dieselbe `netLatencyMs`.
- **T-Diag-1**: `DiagnosticsSnapshot` nach einem Request enthält alle emittierten Events, aggregate correct, Referenz-Isolation: zwei parallele Requests haben je **eigene** Collectors, die sich nicht sehen.

## 8. Was NICHT in diesem Commit ist

- Kein OpenAPI-Delta v0.4.3.1. (Separater Commit.)
- Keine `alias_gate_ready`-Erweiterung. Der HALF_OPEN-Single-flight braucht kein neues Health-Feld — der bestehende Feld-Vertrag genügt.
- Keine Aufnahme von Diagnostics in `/dql/verify`-Response. Aktuell nur intern gesammelt; Aufnahme kommt mit OpenAPI-Delta.
- Kein Kalibrierungs-Run / Live-Drill. (Zwei-Gate-Punkt, letzter Schritt.)

## Antwort-Format

Wenn Hermes diese Skizze auf einen Blick durchgehen und OK / Änderungswunsch pro Frage in Abschnitt 6 zurückgeben kann, starte ich sofort mit Code. Falls Hermes weitere Invarianten sieht, die hier fehlen, bitte als I7, I8, … ergänzen.
