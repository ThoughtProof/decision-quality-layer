# v0.4.3.1 CB Recovery Fix — Design Draft v4

**Status**: BLOCKING v0.4.3 Recert
**Priority**: v0.4.3.1 blocking (was formerly v0.4.4 roadmap)
**Author**: Perplexity (implementing Hermes' architectural decisions)
**Date**: 2026-07-11
**Iteration**: v4 (v3 SUPERSEDED — Hermes-Review 2026-07-11)
**Supersedes**: `docs/v0431-recovery-fix-design-v3-SUPERSEDED.md`, `docs/v0431-recovery-fix-design-v2-SUPERSEDED.md`

---

## Vorwort — was in v3 falsch war

Hermes hat im v3-Review zwei harte Blocker und drei weitere Semantik-Lücken benannt:

1. **Blocker `recoverFromOpen()` caller-kontrolliert**: Der Router lieferte `requiredConsecutiveSuccesses` und `maxLatencyMs` pro Aufruf. Damit konnte ein Caller effektiv K=1 + Bound=∞ übergeben. Der CB besitzt die Sicherheitsregeln, nicht der Router.
2. **Blocker rohe Wall-Clock im Recovery-Probe**: `Date.now() - startedAt` inklusive Backoff-Waits — genau die Fehlklassifikation, die PR #11 gerade beseitigt.
3. HALF_OPEN-Semantik falsch beschrieben: v3 behauptete "OPEN bleibt bis Prozess-Restart" — tatsächlich gibt es bereits cooldown → HALF_OPEN → Probe (siehe `circuit-breaker.ts:145-183`). Der Bug ist nicht "keine Recovery", sondern "HALF_OPEN-Probe scheitert am 15s-`probeMaxLatencyMs` bei swift".
4. Bound-Kalibrierung wissentlich auf v0.4.3.2 verschoben — mit vorhandener Datenlage (swift p90 ≈ 24s, p95 ≈ 35s vs Bound 15s) ist Flapping vorhersehbar. Trip-/HALF_OPEN-/Recovery-Bound müssen konsistent sein.
5. Weitere Punkte: `provider_route`-Enum-Erweiterung war API-Bruch; Sampling-Test und Recovery-Test vermischt; nur `probeEpoch !== state.epoch` reicht nicht — Trip-Generation muss dazu; `try/finally` für `probeInFlight` fehlte.

v4 adressiert alle zehn v4-Anforderungen aus dem Review explizit.

---

## 1. Config-Trennung + korrekte Ist-Semantik von HALF_OPEN

Zwei orthogonale Config-Achsen, präziser als v3:

```typescript
interface HttpLlmClientConfig {
  // ... bestehende Felder
  capitalPathMode?: boolean;                    // default false
  recoveryMode?: 'disabled' | 'soft-open';      // default 'disabled'
  circuitBreakerConfigByAlias?: Record<string, PerAliasBreakerConfig>;
}

interface PerAliasBreakerConfig {
  tripP90LatencyMs?: number;
  probeMaxLatencyMs?: number;      // HALF_OPEN probe bound (bestehend)
  recoveryMaxLatencyMs?: number;   // soft-OPEN Recovery bound (neu, v0.4.3.1)
  recoveryRequiredSuccesses?: number;  // K, neu, CB-owned
}
```

**Verhaltensmatrix (echtes Ist-Modell)**:

| `capitalPathMode` | `recoveryMode` | Verhalten |
|---|---|---|
| `true` | (irrelevant) | Kein Fallback, kein soft-OPEN. **Bestehende cooldown→HALF_OPEN-Recovery bleibt** (via `canProceed()` bei abgelaufenem Cooldown). Ein HALF_OPEN-Probe der überlebt → CLOSED. |
| `false` | `'disabled'` | Validierter Fallback aktiv. **Bestehende cooldown→HALF_OPEN-Recovery bleibt.** Kein zusätzlicher soft-OPEN-Router-Sampling. **Zukünftiger Prod-Default nach v0.4.3-Recert.** |
| `false` | `'soft-open'` | Validierter Fallback aktiv **plus** zusätzliche graduelle soft-OPEN Router-Sampling-Recovery. Nur für Benchmark-/Eval-Runs explizit freizuschalten. |

**Wichtige Präzisierung zur Prod-Freigabe**: Nach v0.4.3-Recert-Erfolg kriegen Prod-Kapital-Pfade `cpm=false + recoveryMode='disabled'`. HALF_OPEN-Recovery bleibt aktiv wie heute — nur das zusätzliche soft-OPEN-Sampling ist aus. Diese Trennung ist bewusst konservativ.

**Warum das v3-Missverständnis auftrat**: In der ersten Vollrun-Session sahen wir persistent-OPEN von adv_018–adv_100. Das war **nicht** weil HALF_OPEN inexistent ist, sondern weil (a) der Router bei `CircuitAllOpenError` katcht und `canProceed()` erst gar nicht ruft (Engine-Bypass, siehe `engine/index.ts:58-79`), und (b) selbst wenn `canProceed()` gerufen würde, der HALF_OPEN-Probe bei swift-p90=24s systematisch am 15s-Bound scheitern und sofort re-trippen würde. Punkt 4 (Kalibrierung) adressiert das strukturell.

---

## 2. Wiederholte Recovery-Epochen mit Trip-Generation

Nach schlechtem Recovery-Sample → streak reset + neue Epoch nach exponential-Cooldown. Wichtig: Zusätzlich zur `epoch` gibt es eine `tripGeneration`, die bei **jedem** OPEN-Zyklus inkrementiert wird — nicht nur beim Epoch-Wechsel innerhalb einer soft-OPEN-Session:

```
CLOSED (tripGeneration=N)
  ↓ trip
OPEN (tripGeneration=N+1, epoch=1)
  ↓ (falls cpm=false AND recoveryMode='soft-open')
soft-recovery epoch #1
  ├─ K aufeinanderfolgende gute Samples → CB.recoverFromOpen() → CLOSED
  │  (Router konsumiert tripGeneration=N+1 Samples)
  └─ schlechter Sample → epoch #2 (tripGeneration=N+1 bleibt)
     ...
  → CLOSED bei erfolgreicher Recovery
  → falls neuer Trip → tripGeneration=N+2 (nicht N+1+irgendwas)
```

**Trip-Generation-Zweck**: Nach erfolgreicher Recovery (CLOSED) und erneutem Trip müssen veraltete in-flight Probe-Ergebnisse aus tripGeneration=N+1 verworfen werden, weil wir jetzt in tripGeneration=N+2 sind. Nur `epoch` reicht nicht, weil `epoch` beim Reset (via `resetSoftOpenState`) auf 1 zurückspringen könnte.

**Config**:

```typescript
interface SoftOpenConfig {
  sampleRate: number;              // default N=5
  baseEpochCooldownMs: number;     // default 30_000
  maxEpochCooldownMs: number;      // default 300_000
  // K und Recovery-Bound sind in CircuitBreakerConfig, nicht hier — siehe §3
}
```

Cooldown-Schedule: `epochCooldownMs[m] = min(baseEpochCooldownMs × 2^(m-1), maxEpochCooldownMs)` → 30s, 60s, 120s, 240s, 300s (cap).

---

## 3. CB-owned Recovery-Policy — kein Escape-Hatch

**Kritische Änderung gegenüber v3**: K und `recoveryMaxLatencyMs` gehören in die CB-Konfiguration, nicht in den Method-Call. Der Router liefert Evidenz, der CB entscheidet.

### CircuitBreaker-Erweiterung

```typescript
// src/engine/circuit-breaker.ts

interface CircuitBreakerConfig {
  // ... bestehende Felder
  recoveryRequiredSuccesses?: number;   // K, default 5
  recoveryMaxLatencyMs?: number;        // default: falls unset, inherit tripP90LatencyMs
}

interface RecoverySample {
  epoch: number;          // Router-Epoch innerhalb aktueller tripGeneration
  sequence: number;       // strictly monotonic pro Alias
  success: boolean;       // war Call erfolgreich (kein Throw)
  latencyMs: number;      // MUSS PR-#11-Netto-Latenz sein (netLatency, nicht wallClock)
  tripGeneration: number; // welche OPEN-Zyklus-Generation
}

interface RecoveryResult {
  closed: boolean;
  reason?: string;        // wenn closed=false: warum
}

class CircuitBreaker {
  // ... bestehende Methoden

  /**
   * Attempts OPEN → CLOSED transition based on Router-collected recovery evidence.
   * CB owns the acceptance rules (K, bound); router cannot weaken them.
   *
   * Validation is strict — any single failure means closed=false:
   *   1. Current state MUST be OPEN
   *   2. samples.length MUST be >= this.config.recoveryRequiredSuccesses (K)
   *   3. Last K samples: MUST all have success=true
   *   4. Last K samples: MUST all have latencyMs <= this.config.recoveryMaxLatencyMs
   *   5. Last K samples: MUST all share the same tripGeneration as metadata.tripGeneration
   *   6. Last K samples: MUST have strictly monotonic sequences (no gaps in caller-sent order,
   *      no duplicate sequences)
   *   7. Last K samples: MUST share the same epoch as metadata.epoch
   */
  recoverFromOpen(
    samples: RecoverySample[],
    metadata: { epoch: number; tripGeneration: number; reason: string }
  ): RecoveryResult {
    const K = this.config.recoveryRequiredSuccesses ?? 5;
    const bound = this.config.recoveryMaxLatencyMs ?? this.config.tripP90LatencyMs;

    if (this.state !== 'OPEN') {
      return { closed: false, reason: `state is ${this.state}, not OPEN` };
    }
    if (samples.length < K) {
      return { closed: false, reason: `insufficient samples: got ${samples.length}, need ${K}` };
    }
    if (metadata.tripGeneration !== this.currentTripGeneration) {
      return { closed: false, reason: `stale tripGeneration ${metadata.tripGeneration} vs current ${this.currentTripGeneration}` };
    }

    const lastK = samples.slice(-K);
    for (let i = 0; i < lastK.length; i++) {
      const s = lastK[i];
      if (!s.success) return { closed: false, reason: `sample #${i} success=false` };
      if (s.latencyMs > bound) return { closed: false, reason: `sample #${i} latency ${s.latencyMs}ms > ${bound}ms` };
      if (s.tripGeneration !== metadata.tripGeneration) return { closed: false, reason: `sample #${i} tripGeneration mismatch` };
      if (s.epoch !== metadata.epoch) return { closed: false, reason: `sample #${i} epoch mismatch` };
      if (i > 0 && s.sequence <= lastK[i-1].sequence) {
        return { closed: false, reason: `sample #${i} sequence not strictly monotonic` };
      }
    }

    // All invariants passed
    this.samples.length = 0;
    this.openedAt = null;
    this.state = 'CLOSED';
    this.lastRecoveryEvent = {
      reason: metadata.reason,
      epoch: metadata.epoch,
      tripGeneration: metadata.tripGeneration,
      samplesUsed: K,
      at: this.now(),
    };
    return { closed: true };
  }

  /**
   * Called internally by trip() to increment generation.
   */
  private incrementTripGeneration(): void {
    this.currentTripGeneration++;
  }
}
```

**Der Router kann K und Bound NICHT abschwächen** — sie liegen in `CircuitBreakerConfig`, nicht in `recoverFromOpen`-Parametern. Der Router liefert nur die Samples und die Meta-Kennung (welche Epoch, welche tripGeneration er glaubt zu bedienen), damit der CB Stale-Detection und Epoch-Konsistenz prüfen kann.

**`currentTripGeneration`** ist CB-internal, wird bei jedem `trip()` inkrementiert. Der Router liest sie via `snapshot()` (bestehende Methode, erweitert um `tripGeneration`).

---

## 4. Netto-Latenz im Recovery-Probe (PR #11-konsistent)

Der Recovery-Probe im Router MUSS exakt dieselbe Latenz-Definition verwenden wie PR #11 in `HttpLlmClient.callWithBreaker` (Zeilen 352 und 424):

```typescript
// PSEUDO-CODE FÜR ROUTER-PROBE-BLOCK
const startedAt = Date.now();
let result: LlmCallOutput;
try {
  result = await this.callPrimary(alias, ...);  // enthält bereits internen Retry-Loop
} catch (err) {
  // Ausgeschöpfter Retry-Loop → success=false. In diesem Zweig ist LlmCallOutput
  // nicht verfügbar (Exception-Pfad), also nehmen wir wallClock für die Telemetrie
  // und markieren success=false.
  const wallClockMs = Date.now() - startedAt;
  this.recordBadSample(alias, {
    success: false,
    latencyMs: wallClockMs,   // reine Telemetrie, wird als bad sample verworfen
    cause: `probe threw: ${err.message}`,
  });
  // Fallback für den User
  return this.callFallback(alias, ...);
}

// Erfolgreicher Probe → PR-#11-Netto-Latenz
const wallClockMs = Date.now() - startedAt;
const netLatencyMs = Math.max(0, wallClockMs - (result.backoffWaitedMs ?? 0));

this.recordGoodOrBadSample(alias, {
  success: true,
  latencyMs: netLatencyMs,        // Netto — 429-Retries subtrahiert
  wallClockMs,                    // zusätzlich für Telemetrie/Report
  backoffWaitedMs: result.backoffWaitedMs ?? 0,
});
```

**Regeln**:

- Erfolgreicher Probe: `latencyMs = netLatencyMs`. Wird gegen `recoveryMaxLatencyMs` verglichen.
- Fehlgeschlagener Probe (Exception, ausgeschöpfter Retry-Loop): `success=false`, `latencyMs=wallClockMs` als Telemetrie, aber als "bad sample" gewertet — Streak-Reset unabhängig von der Latenz.
- Probe technisch erfolgreich, aber `netLatencyMs > recoveryMaxLatencyMs` → bad sample mit cause=`latency-over-bound`.

**Es gibt keine zweite Latenz-Definition.** Der Router konsumiert `LlmCallOutput.backoffWaitedMs` (Feld existiert bereits post-PR-#11) und wendet dieselbe Netto-Formel an wie `callWithBreaker`.

---

## 5. Router-Logic mit try/finally, Generation-Token und Single-flight

Vollständige Router-Semantik unter state=OPEN, cpm=false, recoveryMode='soft-open':

### Pro-Alias-State

```typescript
interface AliasSoftOpenState {
  epoch: number;                   // aktuelle Recovery-Epoch, resettet bei erfolgreicher Recovery oder neuem Trip
  sequence: number;                // strikt monoton pro Alias über alle Calls
  probeInFlight: boolean;          // single-flight: max 1 Probe pro Alias in-flight
  latencyBuffer: RecoverySample[]; // Samples der aktuellen Epoch (Sliding-Window bis K)
  consecutiveSuccesses: number;    // Streak in aktueller Epoch
  nextProbeEligibleAt: number;     // wall-clock, ab wann nächster Probe erlaubt
  currentTripGeneration: number;   // welche OPEN-Zyklus-Generation aktiv ist
}
```

### Routing-Pseudocode

```typescript
async function routeCall(alias: string, ...): Promise<LlmCallOutput> {
  const state = this.getSoftOpenState(alias);
  const cbSnapshot = this.getBreaker(alias).snapshot();

  // Wenn CB nicht OPEN, geht der bestehende Pfad — CLOSED/HALF_OPEN werden vom
  // CB selbst behandelt. Recovery-Router mischt sich nicht ein.
  if (cbSnapshot.state !== 'OPEN') {
    return this.normalCall(alias, ...);
  }

  // CB ist OPEN — soft-OPEN-Regime aktiv (wenn Config zulässt)
  if (this.config.capitalPathMode || this.config.recoveryMode !== 'soft-open') {
    // Fail-closed (capital) oder disabled → sofort Fallback (bestehendes Verhalten)
    return this.callFallback(alias, ...);
  }

  // Snapshot der CB-Generation ins Router-State übernehmen falls neu
  if (state.currentTripGeneration !== cbSnapshot.tripGeneration) {
    this.resetSoftOpenStateForNewGeneration(alias, cbSnapshot.tripGeneration);
  }

  const mySequence = ++state.sequence;
  const myTripGeneration = state.currentTripGeneration;
  const myEpoch = state.epoch;
  const now = Date.now();

  // Sampling-Entscheidung: eligible if (a) nicht in Cooldown, (b) kein Probe in-flight,
  // (c) Sample-Rate-Slot getroffen
  const eligible = (
    now >= state.nextProbeEligibleAt
    && !state.probeInFlight
    && (mySequence % this.config.softOpen.sampleRate === 0)
  );

  if (!eligible) {
    this.telemetry.emit('recovery_probe_skipped', {
      alias, epoch: myEpoch, tripGeneration: myTripGeneration, sequence: mySequence,
      cause: !eligible.timeGate ? 'cooldown' : (state.probeInFlight ? 'probe-in-flight' : 'sample-rate'),
    });
    return this.callFallback(alias, ...);
  }

  // Diese Call wird Probe
  state.probeInFlight = true;
  this.telemetry.emit('recovery_probe_started', {
    alias, epoch: myEpoch, tripGeneration: myTripGeneration, sequence: mySequence,
  });

  const startedAt = Date.now();
  try {
    let result: LlmCallOutput;
    try {
      result = await this.callPrimary(alias, ...);
    } catch (err) {
      const wallClockMs = Date.now() - startedAt;
      this.handleBadSample(alias, {
        epoch: myEpoch, sequence: mySequence, tripGeneration: myTripGeneration,
        latencyMs: wallClockMs, cause: `probe-threw: ${err.message}`,
      });
      // Fallback for user
      return this.callFallback(alias, ...);
    }

    const wallClockMs = Date.now() - startedAt;
    const netLatencyMs = Math.max(0, wallClockMs - (result.backoffWaitedMs ?? 0));

    // Stale-Check: hat sich Trip-Generation während des Awaits geändert?
    if (state.currentTripGeneration !== myTripGeneration) {
      this.telemetry.emit('recovery_probe_stale', {
        alias, probeTripGeneration: myTripGeneration, currentTripGeneration: state.currentTripGeneration,
      });
      return result;  // Ergebnis dem Caller geben, State nicht ändern
    }
    if (state.epoch !== myEpoch) {
      this.telemetry.emit('recovery_probe_stale', {
        alias, probeEpoch: myEpoch, currentEpoch: state.epoch,
      });
      return result;
    }

    // Netto-Latenz gegen CB-Config-Bound prüfen (nicht Router-supplied Bound!)
    const cbConfig = this.getBreaker(alias).getConfig();
    const recoveryBound = cbConfig.recoveryMaxLatencyMs ?? cbConfig.tripP90LatencyMs;

    if (netLatencyMs > recoveryBound) {
      this.handleBadSample(alias, {
        epoch: myEpoch, sequence: mySequence, tripGeneration: myTripGeneration,
        latencyMs: netLatencyMs, cause: 'latency-over-bound',
      });
    } else {
      // Guter Sample
      const sample: RecoverySample = {
        epoch: myEpoch, sequence: mySequence, success: true,
        latencyMs: netLatencyMs, tripGeneration: myTripGeneration,
      };
      state.latencyBuffer.push(sample);
      state.consecutiveSuccesses++;
      this.telemetry.emit('recovery_probe_succeeded', {
        alias, epoch: myEpoch, tripGeneration: myTripGeneration, sequence: mySequence,
        netLatencyMs, wallClockMs, backoffWaitedMs: result.backoffWaitedMs ?? 0,
        streak: state.consecutiveSuccesses,
      });

      if (state.consecutiveSuccesses >= (cbConfig.recoveryRequiredSuccesses ?? 5)) {
        // K erreicht → CB fragen ob Transition zulässig
        const recoveryResult = this.getBreaker(alias).recoverFromOpen(
          state.latencyBuffer,
          { epoch: myEpoch, tripGeneration: myTripGeneration, reason: 'soft-open recovery' }
        );
        if (recoveryResult.closed) {
          this.telemetry.emit('circuit_recovered', {
            alias, epoch: myEpoch, tripGeneration: myTripGeneration,
            samplesUsed: cbConfig.recoveryRequiredSuccesses ?? 5,
          });
          this.resetSoftOpenStateAfterRecovery(alias);
        } else {
          this.telemetry.emit('recovery_probe_rejected', {
            alias, epoch: myEpoch, tripGeneration: myTripGeneration, reason: recoveryResult.reason,
          });
          // CB hat abgelehnt (sollte selten sein wenn wir alle Invarianten erfüllen)
          // Streak zurücksetzen, damit wir nicht endlos denselben Buffer probieren
          this.handleBadSample(alias, {
            epoch: myEpoch, sequence: mySequence, tripGeneration: myTripGeneration,
            latencyMs: netLatencyMs, cause: `cb-rejected: ${recoveryResult.reason}`,
          });
        }
      }
    }

    return result;
  } finally {
    state.probeInFlight = false;
  }
}

function handleBadSample(alias, info) {
  const state = this.getSoftOpenState(alias);
  if (state.currentTripGeneration !== info.tripGeneration || state.epoch !== info.epoch) {
    // Stale — sollte oben schon abgefangen sein, defensiv
    return;
  }
  const oldEpoch = state.epoch;
  state.consecutiveSuccesses = 0;
  state.latencyBuffer = [];
  state.epoch++;
  const cooldownMs = Math.min(
    this.config.softOpen.baseEpochCooldownMs * Math.pow(2, oldEpoch - 1),
    this.config.softOpen.maxEpochCooldownMs
  );
  state.nextProbeEligibleAt = Date.now() + cooldownMs;
  this.telemetry.emit('recovery_streak_reset', {
    alias, oldEpoch, newEpoch: state.epoch, tripGeneration: info.tripGeneration,
    cause: info.cause, latencyMs: info.latencyMs, cooldownMs,
  });
}
```

**Kritische Sicherheits-Punkte**:

- **`try/finally`** garantiert `probeInFlight = false` auch bei Exceptions
- **Trip-Generation-Check nach dem `await`** fängt Race-Fälle: CB wurde während des Awaits geschlossen und erneut getrippt, unser Sample gehört zur alten Generation
- **Epoch-Check nach dem `await`** fängt Race-Fälle innerhalb derselben Trip-Generation: ein anderer Bad-Sample-Handler hat Epoch inkrementiert
- **CB-Config wird zur Runtime gelesen** (`cbConfig.recoveryMaxLatencyMs`) — nicht in Router-Config gecacht
- **`recoverFromOpen` ohne Router-supplied K/Bound** — nur Samples + Metadata

---

## 6. Kein neues öffentliches Route-Enum

**API-Bruch vermeiden.** Der bestehende Type `providerRoute: 'primary' | 'fallback'` bleibt. Probe-Kennzeichnung als separate optionale Felder:

```typescript
// LlmCallOutput
interface LlmCallOutput {
  // ... bestehende Felder
  providerRoute?: 'primary' | 'fallback';   // unverändert
  recoveryProbe?: boolean;                  // NEU: intern/telemetrie-only, optional
  recoveryEpoch?: number;                   // NEU: nur gesetzt wenn recoveryProbe=true
  recoveryTripGeneration?: number;          // NEU: nur gesetzt wenn recoveryProbe=true
}
```

Falls `recoveryProbe=true`, ist `providerRoute='primary'` (der Probe geht ja zum echten Primary). Downstream-Consumers, die nur `providerRoute` lesen, sehen 'primary' — kein API-Bruch. Wer Route-Details braucht, liest zusätzlich `recoveryProbe`.

Alternative die wir nicht wählen: `providerRoute='primary-probe'` als drittes Enum-Element. **Verworfen wegen API-Kompatibilität.**

---

## 7. Per-Alias-Kalibrierung — vor dem Live-Run finalisieren

Bound-Kalibrierung ist **Teil von v0.4.3.1**, nicht v0.4.3.2. Trip-/HALF_OPEN-/Recovery-Bounds pro Alias konsistent:

```typescript
// Beispiel-Config, zu finalisieren aus verifizierten retry-bereinigten Daten
circuitBreakerConfigByAlias: {
  'serv-nano': {
    tripP90LatencyMs: 15_000,       // TBD aus nano-p90 im letzten sauberen Run
    probeMaxLatencyMs: 15_000,      // konsistent zu tripP90
    recoveryMaxLatencyMs: 15_000,   // konsistent zu tripP90
    recoveryRequiredSuccesses: 5,
  },
  'serv-swift': {
    tripP90LatencyMs: 30_000,       // TBD aus swift Segment-A netto-Latenzen
    probeMaxLatencyMs: 30_000,      // konsistent
    recoveryMaxLatencyMs: 30_000,   // konsistent
    recoveryRequiredSuccesses: 5,
  },
}
```

**Warum konsistent kritisch ist**: Wenn Recovery bei 30s schließt, aber `tripP90LatencyMs=15s` beim CLOSED-Traffic gilt, kommt es sofort wieder zum Trip. Flapping-Zyklus:

```
OPEN → recovery bei 28s → CLOSED → nächste Draws bei 25-30s → tripP90 reisst → OPEN
```

Alle drei Bounds pro Alias auf denselben Wert.

### Kalibrierungs-Regel (bindend, muss vor Live-Run finalisiert werden)

**Quelle**: Der letzte saubere Vollrun mit netto-Latenz-Instrumentierung. Aktuell verfügbar: `runs/results_v043_swift_primary_recert_w1.jsonl` (adv_001–adv_017 als swift Segment-A, ~85 primary-Draws bei 5 Draws/Case × 17 Cases).

**Regel**: Pro Alias, aus allen primary-Draws mit `providerRoute='primary'` und `success=true` in diesem Datensatz:

```
netLatency = wallClock - backoffWaitedMs
tripP90LatencyMs = probeMaxLatencyMs = recoveryMaxLatencyMs = ceil(p95(netLatency) / 5000) * 5000
```

Runden auf 5s-Vielfaches wegen Config-Lesbarkeit.

**Was ich VOR v4-Freigabe liefere**: Explizite Berechnung aus Segment-A-Daten, Report-Excerpt mit p50/p90/p95/max, vorgeschlagene Werte. Wenn Segment A zu klein ist (n<50 Samples pro Alias), führen wir vor dem Live-Run einen 20-Case-Kalibrierungs-Run auf gesundem swift (ohne CB-Trip-Provokation).

**Kein "wir setzen 30s weil es plausibel klingt".** Zahl mit Quelle und Regel.

---

## 8. Test-Trennung: Sampling und Recovery separat

### 8a. Sampling-Test (ohne Recovery)

Unit-Test hält K unerreichbar (z.B. injizierte Latenz > `recoveryMaxLatencyMs` bei jedem 5-ten Call → alle Probes werden bad samples). Beweist:

- Von 25 sequenziellen Calls: genau 5 werden als Probes klassifiziert (via `recovery_probe_started`-Events)
- 20 gehen fallback
- Verhältnis 1/N=1/5 exakt

Kein Fokus auf Recovery-Ausgang — Fokus auf Sampling-Distribution.

### 8b. Recovery-Test (deterministischer OPEN→CLOSED-Drill)

Unit-Test bringt CB deterministisch in OPEN (via injizierte Test-Factory bzw. `recordFailure`-Sequenz), führt K−1 gute Samples (Latenz unter Bound) → Assert: state=OPEN. Führt K-ten guten Sample → Assert: state=CLOSED, `circuit_recovered`-Event, subsequenter Traffic geht `providerRoute='primary'` (kein Probe mehr, weil CB CLOSED).

**Kein `forceOpen()`-Public-API** — Test-Injection via Factory oder direkter State-Manipulation im Test-only-Konstruktor.

### 8c. Vollständige Unit-Acceptance (11 Assertions)

| # | Test | Was er beweist |
|---|---|---|
| 1 | CB deterministisch nach failure_rate → state='OPEN' | Setup |
| 2 | 25 seq. Calls, N=5, K unerreichbar → 5 Probes gestartet, 20 Fallbacks | 8a Sampling |
| 3 | K−1 gute Probes → weiterhin state='OPEN' | K-Grenze |
| 4 | K-ter guter Probe → state='CLOSED', `circuit_recovered` event | Recovery-Bedingung |
| 5 | Nach Recovery: 10 Traffic-Calls → alle `providerRoute='primary'`, keine als `recoveryProbe=true` markiert | Zurück in Normal-Betrieb, keine unnötige Probes |
| 6 | 4 gute Probes, dann Probe mit `netLatencyMs > recoveryMaxLatencyMs` → streak reset, epoch++, `recovery_streak_reset` event | Bad-Sample-Handling |
| 7 | Nach Epoch 2 Cooldown: 5 gute Probes → CLOSED, `circuit_recovered` mit `epoch=2` | Repeated epochs |
| 8 | Innerhalb Cooldown: alle Calls fallback, 0 `recovery_probe_started` events | Cooldown-Enforcement |
| 9 | `recoveryMode='disabled'` + Trip: 25 Traffic-Calls → 0 `recovery_probe_started`, aber bestehende HALF_OPEN-Recovery (nach cooldownMs) funktioniert weiterhin | recoveryMode-Gate |
| 10 | Zwei Clients (`cpm=true` vs `cpm=false`), gleiche Umgebung, gleicher Trip → cpm=true macht 0 soft-Probes und fail-closed, cpm=false macht Probes | capitalPathMode-Gate |
| 11 | 5 parallele Achsen für denselben Alias bei state=OPEN → genau 1 Probe klassifiziert (single-flight), 4 fallback | Parallel-Semantik |
| 12 | Stale-Probe-Test: Probe gestartet in tripGeneration=N, während des Awaits CB→CLOSED→re-Trip (tripGeneration=N+1), Probe kehrt zurück → Sample verworfen (`recovery_probe_stale` event), Streak in tripGeneration=N+1 unverändert | Generation-Schutz |

### 8d. `recoverFromOpen()` Escape-Hatch-Regression-Test

**Neu, kritisch**: Explizit testen dass caller-supplied K und Bound nicht wirken:

```typescript
// Test: Router versucht CB mit ungültiger Config zu schließen
const cb = new CircuitBreaker({ recoveryRequiredSuccesses: 5, recoveryMaxLatencyMs: 15_000 });
tripBreakerDeterministic(cb);

// Nur 1 Sample bereitstellen — CB muss ablehnen, egal was Router "will"
const result = cb.recoverFromOpen(
  [{ epoch: 1, sequence: 1, success: true, latencyMs: 100, tripGeneration: cb.snapshot().tripGeneration }],
  { epoch: 1, tripGeneration: cb.snapshot().tripGeneration, reason: 'attempted-bypass' }
);
expect(result.closed).toBe(false);
expect(result.reason).toContain('insufficient samples');

// 5 Samples aber alle über Bound — CB muss ablehnen
const badSamples = Array.from({length: 5}, (_, i) => ({
  epoch: 1, sequence: i+1, success: true, latencyMs: 20_000, tripGeneration: cb.snapshot().tripGeneration
}));
const result2 = cb.recoverFromOpen(badSamples, { epoch: 1, tripGeneration: cb.snapshot().tripGeneration, reason: 'attempted-bypass' });
expect(result2.closed).toBe(false);
expect(result2.reason).toContain('20000ms > 15000ms');
```

Dieser Test verhindert Regression: Wenn jemand später `recoverFromOpen(samples, {overrideK: 1})` einführt, bricht dieser Test.

---

## 9. Diskriminierender Live-Recovery-Drill VOR Preflight

Neue Reihenfolge:

1. **Unit-Tests §8** — grün
2. **Kontrollierter Live-Recovery-Drill** (echte SERV-Calls):
   - Test-Factory bringt einen CB (nur der swift-CB) deterministisch in OPEN (via injizierter Trip-Sequenz — keine öffentliche `forceOpen()`-API)
   - `recoveryMode='soft-open'`, `capitalPathMode=false`
   - Skript sendet 30 Test-Achsen-Calls sequenziell mit ~5s Delay
   - Erwartung: `soft_open_entered` → 6 Probes (30/N=5), 5 gute Probes hintereinander (falls swift gesund) → `circuit_recovered` beobachtet
   - **Gegenprobe**: Gleiche Prozedur mit `recoveryMode='disabled'` → keine `recovery_probe_started`-Events, bestehende cooldown→HALF_OPEN-Recovery greift stattdessen
   - Report: `runs/recovery_drill_v0431.jsonl` + `reports/v0431-recovery-drill.md`, gepusht auf `dql-benchmark/main`
3. **Preflight 30×N=3** auf soft-open code, mit finaler Kalibrierung — nur wenn Drill grün
4. **Vollrun 100×N=5** — nur wenn Preflight grün (definiertes Recall-Kriterium + Recovery-Event-Evidenz)

**Gates zwischen Schritten**: Nach jedem Schritt Hermes-Vier-Augen-Review der Reports vor Weiterschalten.

---

## 10. Was NICHT Teil von v0.4.3.1 ist

Explizit ausgeschlossen (separate Tracks):

- **capitalPathMode-Auto-Recovery**: Kein automatischer soft-OPEN auf Prod-Kapital-Pfaden. Wenn irgendwann gewünscht: eigener Ticket mit Kanari + tiered rollout + manueller Freigabe.
- **Retry-Bug adv_084/adv_098**: v0.4.4.
- **Suite v1.2**: v0.4.4.
- **AgentDojo Track**: nach v0.4.2 stabil.

---

## 11. Acceptance-Kriterien für v0.4.3.1-Close

Alle vier müssen erfüllt sein:

1. **Unit-Test-Kanon §8** (12 diskriminierende Assertions + `recoverFromOpen`-Escape-Hatch-Regression) grün
2. **Kalibrierungs-Nachweis §7**: p95-Zahlen aus verifizierten netto-Latenz-Daten, per-Alias-Bounds konsistent (trip=probe=recovery)
3. **Live-Recovery-Drill §9**: `soft_open_entered` + `circuit_recovered` events in echtem SERV-Verkehr beobachtet; `recoveryMode='disabled'`-Gegenprobe rekapituliert kein soft-OPEN
4. **Vollrun**: primary-Route-Anteil > 80% über 100 Cases, 0 Safety-Regressions vs v0.4.1d, Rohdaten + Report + Manifest **gepusht** auf `dql-benchmark/main` **vor** PR #12 Merge

---

## 12. Branch, Telemetrie, PR-Struktur

### Branch-Reihenfolge (Hermes-Antwort auf Frage 3)

1. PR #11 (latency-fix) auf `v043-cb-latency-fix` — **separat mergen zu `main` FIRST**, mit Belegen (Rohdaten + Report + Manifest bereits auf `dql-benchmark/main` @ ced1915).
2. Nach PR #11 Merge: `main` hat den latency-fix.
3. Neuer Branch `v043-cb-recovery-fix` **von `main`** abzweigen. Kein stacked PR.
4. v0.4.3.1 Recovery-Fix implementieren → PR #12 auf `v043-cb-recovery-fix`.
5. Kalibrierungs-Nachweis + Live-Drill + Preflight + Vollrun → alle vier zusätzlich gepusht auf `dql-benchmark/main`.
6. PR #12 Merge nur nach Hermes-Freigabe der vier Nachweise.

### Telemetrie-Events (Pflicht, alle strukturiert JSON, mindestens diese Felder)

| Event | Kernfelder |
|---|---|
| `soft_open_entered` | `alias, tripGeneration, tripReason, cbState` |
| `recovery_probe_started` | `alias, tripGeneration, epoch, sequence` |
| `recovery_probe_succeeded` | `alias, tripGeneration, epoch, sequence, netLatencyMs, wallClockMs, backoffWaitedMs, streak, boundMs` |
| `recovery_probe_failed` | `alias, tripGeneration, epoch, sequence, cause, netLatencyMs?, wallClockMs?` |
| `recovery_probe_stale` | `alias, probeTripGeneration, currentTripGeneration, probeEpoch, currentEpoch` |
| `recovery_probe_skipped` | `alias, tripGeneration, epoch, sequence, cause` (cooldown/probe-in-flight/sample-rate) |
| `recovery_probe_rejected` | `alias, tripGeneration, epoch, reason` |
| `recovery_streak_reset` | `alias, tripGeneration, oldEpoch, newEpoch, cause, latencyMs?, cooldownMs` |
| `circuit_recovered` | `alias, tripGeneration, epoch, samplesUsed, boundMs` |

Alle Events schreiben in denselben strukturierten Log-Sink wie bestehende CB-Events. Vollrun-Report rekonstruiert Recovery-Historie direkt aus Log-Traces.

---

## 13. Prozess-Regel (unverändert)

**"Fertig" = Code committed + auf origin gepusht + Rohdaten + Report + Manifest gepusht und verifizierbar.** Kein Status-"grün" ohne alle vier.

---

## 14. Zusammenfassung der zehn v4-Anforderungen aus dem Review

| # | Anforderung | Wo in v4 adressiert |
|---|---|---|
| 1 | CB besitzt K und Recovery-Bound selbst | §3 (CB-Config `recoveryRequiredSuccesses`, `recoveryMaxLatencyMs`; Router liefert nur Samples + Metadata) |
| 2 | Strukturierte Samples mit Epoch, Sequence, Success, tripGeneration | §3 (`RecoverySample`-Interface); §5 (Router baut sie im Erfolgs-/Misserfolgs-Pfad) |
| 3 | Recovery-Probes verwenden PR-#11-Netto-Latenz | §4 (netLatencyMs-Formel, PR-#11-konsistent, kein zweite Definition) |
| 4 | Bestehende HALF_OPEN-Semantik korrekt | §1 (Verhaltensmatrix nennt HALF_OPEN-Pfad explizit für alle drei Config-Kombinationen) |
| 5 | Per-Alias konsistente trip/probe/recovery-Bounds | §7 (`PerAliasBreakerConfig` mit allen drei Feldern, Kalibrierungs-Regel) |
| 6 | Probe-Kennzeichnung als internes Trace-Feld | §6 (`recoveryProbe: boolean` + `recoveryEpoch` + `recoveryTripGeneration`, kein Enum-Bruch) |
| 7 | Getrennte Sampling- und Recovery-Tests | §8a (Sampling), §8b (Recovery), §8c (11 Assertions), §8d (Escape-Hatch-Regression) |
| 8 | Single-flight + Generation-Schutz + finally | §5 (try/finally, tripGeneration im Sample, Stale-Check post-await) |
| 9 | Kontrollierter Live-OPEN→CLOSED-Drill | §9 (Reihenfolge: Unit → Live-Drill → Preflight → Vollrun) |
| 10 | Danach 30×N=3, erst dann 100×N=5 | §9 (Schritt 3+4) |

---

## 15. Zwei kleinere Punkte, die ich noch klären will

1. **`recovery_probe_rejected` bei erfolgreicher-aber-CB-abgelehnter Recovery**: Wenn wir alle Invarianten sauber führen, sollte CB nie ablehnen mit closed=false wenn wir K gute Samples in derselben Epoch/Generation haben. Trotzdem behandle ich es als bad sample (streak reset). Alternative: Als "shouldn't-happen"-Assertion loggen und Prozess-Panic. Deine Präferenz?

2. **Kalibrierungs-Datenquelle**: Ist Segment A vom letzten Vollrun (17 Cases × ~5 primary-Draws = ~85 samples) ausreichend, oder soll ich einen 20-Case-Kalibrierungs-Run gegen gesundes swift (ohne CB-Interference) fahren bevor ich die Bounds finalisiere? Ich tendiere zu Ersterem falls die Streuung eng ist — sage aber lieber "Segment A reicht" mit p95-Zahl in der Hand.

Kein Code bis v4 freigegeben ist. Wenn du beim v4-Review noch v5-Anforderungen findest, wieder Design-First.
