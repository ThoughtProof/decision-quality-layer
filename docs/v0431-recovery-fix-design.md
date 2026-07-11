# v0.4.3.1 CB Recovery Fix — Design Draft v3

**Status**: BLOCKING v0.4.3 Recert
**Priority**: v0.4.3.1 blocking (was formerly v0.4.4 roadmap)
**Author**: Perplexity (implementing Hermes' architectural decisions)
**Date**: 2026-07-11
**Iteration**: v3 (v2 SUPERSEDED — see Hermes-Review 2026-07-11)
**Supersedes**: `docs/v0431-recovery-fix-design-v2-SUPERSEDED.md`

---

## Vorwort — was in v2 falsch war

v2 hatte sechs strukturelle Fehler, die Hermes im Review benannt hat:

1. Verkopplung von `capitalPathMode=false` mit "Benchmark-Modus" — nach der Recert soll `capitalPathMode=false` auf Prod gehen, dort wäre soft-OPEN dann versehentlich mit-aktiviert
2. Kein Konzept für **wiederholte Recovery-Epochen** — ein einziger schlechter Sample hätte den Circuit dauerhaft kaputt gemacht
3. `forceClose(reason)` als Public-API — zu mächtig, umgeht CB-Invarianten
4. Keine Semantik für **parallele Axes** (Engine ruft `Promise.all(axes.map(...))`)
5. Test 5 forderte Runtime-Mutation von `capitalPathMode` — mit dem echten Code unmöglich
6. Acceptance ">80% primary" ist **grün-aber-wirkungslos-Test** — würde auch bei einem No-op-Fix passieren

v3 adressiert alle sechs Punkte explizit.

---

## 1. Config-Trennung: capitalPathMode und recoveryMode sind orthogonal

Zwei separate Achsen, nicht gekoppelt:

```typescript
interface HttpLlmClientConfig {
  // ... bestehende Felder
  capitalPathMode?: boolean;        // default false (bleibt wie heute)
  recoveryMode?: 'disabled' | 'soft-open';  // default 'disabled'
}
```

**Verhaltensmatrix**:

| `capitalPathMode` | `recoveryMode` | Verhalten bei state=OPEN |
|---|---|---|
| `true` | (irrelevant) | Fail-closed. Kein Fallback, kein soft-Recovery. Wie heute. |
| `false` | `'disabled'` | Validierter Fallback aktiv, aber **kein automatisches Recovery**. Nach Trip: CB bleibt OPEN bis Prozess-Restart. Wie heute im v0.4.2/v0.4.3-latency-fix-Zustand. |
| `false` | `'soft-open'` | Fallback aktiv **und** soft-Recovery via Router-Sampling. Nur für Benchmark-/Eval-Runs explizit freizuschalten. |

**Default `recoveryMode='disabled'`** — auch wenn `capitalPathMode=false`. Grund (Hermes' Argument): Nach v0.4.3-Recert-Erfolg wird `capitalPathMode=false` auf Prod-Kapital-Pfaden aktiviert, damit der validierte SERV-Fallback greift. In dem Moment darf **nicht** automatisch auch soft-OPEN scharf werden — das ist eine separate Verfügbarkeits-Automatik, die einen eigenen Zertifizierungs-Prozess braucht.

**Was das für die Session heute bedeutet**: Für den v0.4.3.1-Vollrun setzen wir explizit `recoveryMode='soft-open'` im Benchmark-Runner. Auf Prod bleibt Default (`recoveryMode='disabled'`). Der Recert-Vollrun beweist Recovery unter Sampling-Regime; die Prod-Freigabe des Fallbacks aktiviert diese Sampling nicht mit.

---

## 2. Wiederholte Recovery-Epochen — kein "hard-OPEN ohne Rückweg"

Nach einem schlechten Recovery-Sample darf die soft-Recovery **nicht** dauerhaft deaktiviert werden. Stattdessen:

```
CLOSED
  ↓ (trip via p90 oder failure_rate)
OPEN
  ↓ (nur wenn capitalPathMode=false AND recoveryMode='soft-open')
soft-recovery epoch #1
  ├─ Router: 1 von N=5 Calls durchgelassen als Probe
  ├─ K=5 aufeinanderfolgende gute Samples → CB.recoverFromOpen() → CLOSED
  └─ irgendein schlechter Sample (Fail ODER Latenz > softOpenLatencyBound)
     ↓
     Streak reset, nextProbeEligibleAt = now + epochCooldown
     ↓ (nach epochCooldown)
soft-recovery epoch #2
  ├─ K=5 aufeinanderfolgende gute Samples → CLOSED
  └─ schlechter Sample → epoch #3 nach 2× epochCooldown
     ...
soft-recovery epoch #M (exponential backoff)
  ├─ epochCooldown[m] = min(baseEpochCooldownMs × 2^(m-1), maxEpochCooldownMs)
  ├─ Beispiel: 30s → 60s → 120s → 240s → 300s (cap)
  └─ Kein Ende — Recovery bleibt möglich beliebig lange nach dem Trip
```

**Zeit steuert nur wann wieder gemessen wird, echter Traffic bestimmt ob Provider gesund ist.**

**Config**:

```typescript
interface SoftOpenConfig {
  sampleRate: number;              // default 5 (1 von N=5 Calls)
  requiredConsecutiveSuccesses: number;  // default K=5
  softOpenLatencyBound: number;    // default inherit tripP90LatencyMs (15_000)
  baseEpochCooldownMs: number;     // default 30_000
  maxEpochCooldownMs: number;      // default 300_000
}
```

**Wichtig**: Es gibt **keinen** "hard-OPEN"-Zustand mehr in der Router-Interpretation. Bei `recoveryMode='soft-open'`, `state=OPEN` heißt immer: "Router führt Recovery-Epoch-Loop". Der einzige Weg raus ist Recovery-Erfolg (via `CB.recoverFromOpen()`).

Ausnahme: Wenn zwischen Trip und Recovery ein anderer Signal-Weg den CB trippt (Failure-Rate steigt weiter durch neue Failures), wird das im normalen `recordFailure`-Pfad gehandelt. Der Router-Epoch-Loop trackt seine eigenen Samples separat und muss veraltete Sample-Ergebnisse aus früheren Epochen ignorieren (siehe §4).

---

## 3. Invariantengeprüfte CB-Recovery-API statt `forceClose()`

`forceClose(reason)` verworfen — zu mächtig, jeder Caller könnte Circuit ohne Recovery-Nachweis schließen.

**Neue CB-API**:

```typescript
// In src/engine/circuit-breaker.ts

interface RecoveryEvidence {
  latenciesMs: number[];
  requiredConsecutiveSuccesses: number;
  maxLatencyMs: number;
  reason: string;
  epoch: number;  // Router-Epoch zur Traceability
}

class CircuitBreaker {
  // ... bestehende Methoden

  /**
   * Attempts to transition OPEN → CLOSED based on Router-collected recovery
   * evidence. Validates invariants; only closes if all checks pass.
   *
   * Returns: { closed: boolean, reason?: string }
   * If closed=false, reason explains rejection (state≠OPEN, insufficient samples,
   * sample over bound, etc). Router MUST NOT retry immediately — this is a hard
   * rejection, not a race condition.
   */
  recoverFromOpen(evidence: RecoveryEvidence): { closed: boolean; reason?: string } {
    if (this.state !== 'OPEN') {
      return { closed: false, reason: `state is ${this.state}, not OPEN` };
    }
    if (evidence.latenciesMs.length < evidence.requiredConsecutiveSuccesses) {
      return { closed: false, reason: `insufficient samples: got ${evidence.latenciesMs.length}, need ${evidence.requiredConsecutiveSuccesses}` };
    }
    const lastK = evidence.latenciesMs.slice(-evidence.requiredConsecutiveSuccesses);
    const overBound = lastK.find(l => l > evidence.maxLatencyMs);
    if (overBound !== undefined) {
      return { closed: false, reason: `sample ${overBound}ms exceeds bound ${evidence.maxLatencyMs}ms` };
    }
    // All invariants passed → transition
    this.samples.length = 0;  // window reset
    this.openedAt = null;
    this.state = 'CLOSED';
    // Preserve lastTripReason for post-mortem, add recovery event
    this.lastRecoveryEvent = { reason: evidence.reason, epoch: evidence.epoch, at: this.now() };
    return { closed: true };
  }
}
```

**Warum das sauber ist**:

- CB validiert die Evidenz selbst (State, K-Zahl, Latenz-Bounds)
- Router liefert Samples + Metadaten, CB entscheidet Transition
- Kein magischer Escape-Hatch — bei fehlender Evidenz gibt CB explizit `closed=false` zurück
- Alias-Zuordnung ist implizit korrekt (CB gehört zu einem Alias, jede CB-Instanz kennt nur eigene Samples)
- Sequence-Ordering wird vom Router garantiert (siehe §4), CB verifiziert nur die Werte

**Der v2-Satz "kein Change in circuit-breaker.ts" ist damit hinfällig.** `recoverFromOpen()` ist eine bounded Erweiterung mit klaren Invarianten.

---

## 4. Parallelitäts-Semantik — Single-flight und Epoch-Schutz

Die Engine ruft Axes parallel via `Promise.all(axes.map(...))`. Bei state=OPEN treffen potenziell 5 Achsen-Calls gleichzeitig auf den Router.

**Pro-Alias-State im Router**:

```typescript
interface AliasSoftOpenState {
  epoch: number;                    // aktuelle Recovery-Epoch-Nr
  sequence: number;                 // strictly increasing, jeder Router-Call bekommt eine
  probeInFlight: boolean;           // exactly-one probe pro Alias
  probeSequence: number | null;     // sequence-Nr des laufenden Probes
  probeEpoch: number | null;        // epoch des laufenden Probes
  consecutiveSuccesses: number;     // Streak-Zähler in aktueller Epoch
  latencyBuffer: number[];          // Samples der aktuellen Epoch (bis K erreicht)
  nextProbeEligibleAt: number;      // wall-clock, ab wann nächster Probe erlaubt
}
```

**Router-Logic bei state=OPEN, capitalPathMode=false, recoveryMode='soft-open'**:

```typescript
// Pseudocode
async function routeCall(alias, ...) {
  const state = this.softOpenStates.get(alias);
  const cbState = this.getBreaker(alias).snapshot().state;
  
  if (cbState !== 'OPEN') {
    // Normal path — CB CLOSED or HALF_OPEN handled by CB itself
    return this.normalCall(alias, ...);
  }
  
  // state === 'OPEN', we're in soft-open regime
  const now = Date.now();
  const mySequence = state.sequence++;
  
  // Eligibility: not in cooldown AND no probe in flight AND sample-rate hit
  const eligible = (
    now >= state.nextProbeEligibleAt
    && !state.probeInFlight
    && (mySequence % this.config.softOpen.sampleRate === 0)
  );
  
  if (!eligible) {
    // Fallback path, no probe accounting
    return this.callFallback(alias, ...);
  }
  
  // This call becomes a probe
  state.probeInFlight = true;
  state.probeSequence = mySequence;
  state.probeEpoch = state.epoch;
  
  const startedAt = Date.now();
  try {
    const result = await this.callPrimary(alias, ...);  // real DQL axis call
    const latencyMs = Date.now() - startedAt;
    
    // Post-call: check if we're still in the same epoch
    if (state.probeEpoch !== state.epoch) {
      // Stale result from a previous epoch — discard, do not update streak
      this.telemetry.emit('recovery_probe_stale', { alias, probeEpoch: state.probeEpoch, currentEpoch: state.epoch });
      state.probeInFlight = false;
      return result;  // caller still gets the answer, but no state change
    }
    
    if (latencyMs > this.config.softOpen.softOpenLatencyBound) {
      // Probe technically succeeded but too slow → treat as bad sample
      this.handleBadSample(alias, state, latencyMs, 'latency-over-bound');
    } else {
      // Good sample
      state.latencyBuffer.push(latencyMs);
      state.consecutiveSuccesses++;
      this.telemetry.emit('recovery_probe_succeeded', {
        alias, epoch: state.epoch, sequence: mySequence, latencyMs, streak: state.consecutiveSuccesses
      });
      
      if (state.consecutiveSuccesses >= this.config.softOpen.requiredConsecutiveSuccesses) {
        // Attempt CB transition
        const result = this.getBreaker(alias).recoverFromOpen({
          latenciesMs: state.latencyBuffer.slice(-this.config.softOpen.requiredConsecutiveSuccesses),
          requiredConsecutiveSuccesses: this.config.softOpen.requiredConsecutiveSuccesses,
          maxLatencyMs: this.config.softOpen.softOpenLatencyBound,
          reason: 'soft-open recovery',
          epoch: state.epoch,
        });
        if (result.closed) {
          this.telemetry.emit('circuit_recovered', { alias, epoch: state.epoch, samplesUsed: this.config.softOpen.requiredConsecutiveSuccesses });
          this.resetSoftOpenState(alias);  // clean slate for next potential trip
        } else {
          // CB rejected — should be rare, log and continue
          this.telemetry.emit('recovery_probe_rejected', { alias, epoch: state.epoch, reason: result.reason });
        }
      }
    }
    
    state.probeInFlight = false;
    return result;
  } catch (err) {
    // Probe failed
    if (state.probeEpoch === state.epoch) {
      this.handleBadSample(alias, state, null, `failed: ${err.message}`);
    }
    state.probeInFlight = false;
    // Fall through to fallback so caller still gets a result
    return this.callFallback(alias, ...);
  }
}

function handleBadSample(alias, state, latencyMs, cause) {
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
    alias, oldEpoch, newEpoch: state.epoch, cause, latencyMs, cooldownMs
  });
}
```

**Invarianten die diese Struktur garantiert**:

- **Max 1 Probe pro Alias in-flight**: `probeInFlight`-Flag, gesetzt vor Call, gecleared nach.
- **Sample-Rate gilt pro Alias-Sequenz**: `mySequence % sampleRate === 0` mit strikt monotoner `sequence`.
- **Epoch-Isolation**: Ein Sample aus Epoch N wird verworfen wenn state bereits in Epoch N+1 ist (Race durch parallele Calls).
- **Ordering per Alias**: Für einen Alias kann max 1 Probe gleichzeitig laufen, alle anderen parallelen Calls gehen fallback. Es gibt keine "Sample 5 kommt vor Sample 4"-Situation, weil Sample 5 nie gestartet wird bevor Sample 4 completed hat.
- **Counter sind pro Alias, nicht global**: `AliasSoftOpenState` pro Alias, `this.softOpenStates: Map<Alias, AliasSoftOpenState>`.

---

## 5. Test 5 korrigiert — kein mutable capitalPathMode

`capitalPathMode` bleibt `private readonly`. Kein Runtime-Switch.

**Neue Test-5-Formulierung**:

```typescript
// Zwei separate Clients, gleiche Umgebung
const clientA = new HttpLlmClient({ capitalPathMode: false, recoveryMode: 'soft-open' });
const clientB = new HttpLlmClient({ capitalPathMode: true, recoveryMode: 'soft-open' });  // recoveryMode wird ignoriert

// Force both breakers to OPEN via identical trip conditions
tripBreakerOn(clientA, alias);
tripBreakerOn(clientB, alias);

// Send 50 traffic calls to each
const routesA = await sendCalls(clientA, alias, 50);
const routesB = await sendCalls(clientB, alias, 50);

// Assertions:
expect(routesA.some(r => r === 'primary-probe')).toBe(true);  // Client A macht Probes
expect(routesB.every(r => r === 'fail-closed')).toBe(true);   // Client B fail-closed
expect(clientA.telemetry).toContain('recovery_probe_started');
expect(clientB.telemetry).not.toContain('recovery_probe_started');
```

Auch für Test "`recoveryMode='disabled'` bei `capitalPathMode=false`": separater Client mit dieser Config, Beweis dass keine Probes stattfinden trotz `capitalPathMode=false`.

---

## 6. Diskriminierende Acceptance-Tests

Der Unit-Test-Kanon muss den Gegenfall erzwingen — nicht nur zufällig-grün-wenn-nicht-getrippt sein.

**Pflicht-Assertions (Unit-Level, mit Time-Injection und Client-Instrumentation)**:

| # | Test | Was er beweist |
|---|---|---|
| 1 | Circuit deterministisch getrippt (via `recordFailure` × failure_rate-Threshold) → state==='OPEN' | Setup funktioniert |
| 2 | Bei 25 sequenziellen Calls (state=OPEN, cpm=false, rm='soft-open'): genau 5 gehen primary-probe, 20 gehen fallback | Sample-Rate N=5 wirkt |
| 3 | 4 gute Probes (Latenz < bound) → CB bleibt OPEN | K=5, nicht K=4 |
| 4 | 5-tes gutes Probe → `recoverFromOpen` returns closed=true, CB.state===CLOSED | Recovery-Bedingung erfüllt |
| 5 | Nach Recovery: 10 Traffic-Calls → alle primary, kein fallback | Rückkehr in Normal-Betrieb |
| 6 | Nach 4 guten Probes: 5. Probe schlecht (Latenz > bound) → streak reset, CB bleibt OPEN, `recovery_streak_reset` telemetry emitted, `epoch` incremented | Ein schlechter Sample zerstört Recovery-Chance nicht |
| 7 | Nach schlechtem Probe (Epoch 2): 5 gute Probes in Folge → CB CLOSED, `epoch=2` in `circuit_recovered` event | Repeated epochs funktionieren |
| 8 | `nextProbeEligibleAt`-Enforcement: Calls vor Cooldown-Ende gehen alle fallback, keine Probe | Cooldown wirkt |
| 9 | `recoveryMode='disabled'` + gleicher Trip-Input → 25 Traffic-Calls, 0 Probes, 0 recovery events | recoveryMode gate |
| 10 | Zwei parallele Clients (`cpm=true` vs `cpm=false`) → cpm=true macht 0 Probes, cpm=false macht Probes | capitalPathMode gate |
| 11 | Parallele Achsen (Promise.all mit 5 gleichzeitigen calls für denselben Alias bei state=OPEN): max 1 wird als Probe klassifiziert, andere 4 fallback | Single-flight |
| 12 | Stale-Epoch-Test: Probe-Call gestartet in Epoch N, Failure-Rate-Trip triggert Epoch-Increment N+1, Probe-Call kehrt erfolgreich zurück → sample wird ignoriert (stale), Streak wird nicht inkrementiert | Epoch-Isolation |

**Live-Vollrun als sekundäres Kriterium (nicht primär)**:

- Trip beobachtet (im Log: `soft_open_entered` event für mindestens einen Alias)
- OPEN→CLOSED-Transition beobachtet (im Log: `circuit_recovered` event für denselben Alias)
- Primary-Route-Anteil > 80% über alle 100 Cases
- Route-Attribution pro Case bis adv_100
- Safety-Regression-Check: Für Draws die Verdict-Verschiebung (BLOCK→ALLOW / BLOCK→REVIEW) zwischen v0.4.1d und v0.4.3.1 zeigen — 0 erlaubt

**Der wesentliche Unterschied zu v2**: Die Unit-Tests beweisen die Recovery-Mechanik unter deterministischen Bedingungen. Der Vollrun beweist zusätzlich, dass die Mechanik in realer swift-Latenz-Umgebung greift. Beides nötig, keins allein reicht.

---

## 7. Parameter — final

Für v0.4.3.1 Implementation:

| Parameter | Wert | Begründung |
|---|---|---|
| `sampleRate` (N) | 5 | 1 von 5 Calls als Probe. 80% Fallback-Anteil während Recovery — genug Signal, niedrigstes Traffic-Risiko. |
| `requiredConsecutiveSuccesses` (K) | 5 | Defensiv. Ein Lucky-Call schließt nicht voreilig. Empirische Kosten im Vollrun: ~5% Extra-Fallback vs K=3. |
| `softOpenLatencyBound` | 15_000ms (inherit `tripP90LatencyMs`) | Konsistenz zum Trip-Threshold. **Offene Kalibrierungs-Frage**: Vollrun-Segment-A zeigte swift-p90=24s auf gesunden Calls. Report muss explizit dokumentieren ob dieser Bound für swift zu niedrig ist. Wenn ja, separater v0.4.3.2-Track oder Threshold-Neu-Kalibrierung. |
| `baseEpochCooldownMs` | 30_000 (30s) | Kurz genug für Recovery innerhalb einer Vollrun-Session, lang genug gegen Probe-Spam. |
| `maxEpochCooldownMs` | 300_000 (5 Min) | Cap gegen exponential blow-up. Bei epoch=5 erreicht (30 × 2^4 = 480s → capped auf 300s). |

**Kalibrierungs-Notiz zum Bound**: Vollrun v043_w1 zeigte in Segment A swift-Draw-Latenzen p50=8s, p90=24s, p95=35s. Bei bound=15s würden potenzielle Recovery-Probes systematisch als "over-bound" klassifiziert werden. Zwei mögliche Fixes: (a) Bound auf p90-Level anheben (z.B. 30s) für swift-Alias, (b) Bound pro Alias konfigurierbar machen. Diese Entscheidung ist **separat** von diesem Design und wird nach dem v0.4.3.1-Vollrun getroffen — wenn Segment-B-Recovery nicht greift wegen Bound-Problem, ist das die Diagnose. Der v0.4.3.1-Fix ist Recovery-**Mechanik**, nicht Recovery-**Kalibrierung**.

---

## 8. Branch, Telemetrie, PR-Struktur

**Branch**: `v043-cb-recovery-fix` von `v043-cb-latency-fix` abgezweigt.

Warum eigener Branch:

- PR #11 (latency-fix) und v0.4.3.1 (recovery-fix) sind zwei getrennte Bugs, sollen als zwei separate PRs reviewbar sein
- Recovery-Fix kann sich verzögern oder anders gebaut werden, ohne PR #11 zu blockieren
- Bounded Review-Fläche pro PR

**Telemetrie-Events** (Pflicht, alle strukturiert JSON):

| Event | Payload | Wann |
|---|---|---|
| `soft_open_entered` | `{alias, tripReason, cbState}` | Erster Router-Call auf state=OPEN in soft-open Regime |
| `recovery_probe_started` | `{alias, epoch, sequence}` | Probe-Call wird gestartet |
| `recovery_probe_succeeded` | `{alias, epoch, sequence, latencyMs, streak}` | Probe unter bound zurückgekehrt |
| `recovery_probe_failed` | `{alias, epoch, sequence, cause, latencyMs?}` | Probe schlecht (fail oder over-bound) |
| `recovery_probe_stale` | `{alias, probeEpoch, currentEpoch}` | Probe-Result kommt zurück aus veralteter Epoch |
| `recovery_probe_rejected` | `{alias, epoch, reason}` | CB.recoverFromOpen returned closed=false |
| `recovery_streak_reset` | `{alias, oldEpoch, newEpoch, cause, latencyMs?, cooldownMs}` | Streak zurückgesetzt, neue Epoch startet |
| `circuit_recovered` | `{alias, epoch, samplesUsed}` | OPEN → CLOSED transition erfolgreich |

Alle Events schreiben in denselben strukturierten Log-Sink wie bestehende CB-Events (state transitions). Der Vollrun-Report kann dann direkt aus Log-Traces die Recovery-Historie rekonstruieren — nicht mehr rückwärts aus Routen-Mustern.

**PR-Struktur**:

1. PR #11 auf `v043-cb-latency-fix` — bleibt wie ist, wartet auf Vollrun-Zwischenschritt-Merge
2. PR #12 auf `v043-cb-recovery-fix` — v0.4.3.1 Recovery-Fix, Base ist `v043-cb-latency-fix`. Merged **nach** PR #11.
3. Recert-Vollrun auf `v043-cb-recovery-fix` mit `recoveryMode='soft-open'` — als Voraussetzung für PR #12 Merge.
4. Rohdaten + Report + Manifest auf `dql-benchmark/main` als ein Commit **vor** PR #12 Merge.

---

## 9. Was NICHT Teil von v0.4.3.1 ist

Explizit ausgeschlossen (separate Tracks):

- **capitalPathMode-Auto-Recovery**: Keine Version. Wenn irgendwann Verfügbarkeits-Automatik auf Prod-Kapital-Pfaden gewünscht ist, ist das ein eigener Ticket mit anderen Anforderungen (Kanari, tiered rollout, manuelle Freigabe).
- **Threshold-Neu-Kalibrierung für swift**: Wenn Vollrun zeigt dass `softOpenLatencyBound=15s` für swift zu niedrig ist (Recovery-Probes systematisch als over-bound rejected), separater v0.4.3.2-Track.
- **Retry-Bug adv_084/adv_098**: v0.4.4 separate Track.
- **Suite v1.2**: v0.4.4 separate Track.

---

## 10. Acceptance-Kriterien für v0.4.3.1-Close

Alle drei müssen erfüllt sein:

1. **Unit-Test-Kanon**: 12 diskriminierende Assertions oben grün (nicht via Mocking der State-Machine, sondern via echtem Router + injizierte Zeit + instrumentierter CB)
2. **Vollrun-Live-Nachweis**: `soft_open_entered` + `circuit_recovered` events beobachtet, Primary-Route > 80% über 100 Cases, 0 Safety-Regressions vs v0.4.1d
3. **Prozess**: Code + Rohdaten + Report + Manifest gepusht auf origin, PR eröffnet mit Nachweis in PR-Body

---

## 11. Offene Fragen an Hermes (vor Implementation-Start)

1. **`softOpenLatencyBound`-Kalibrierung**: v0.4.3.1 startet mit 15s (inherit tripP90LatencyMs). Wenn Vollrun zeigt dass swift-gesunde Latenzen strukturell darüber liegen (p95=35s in Segment A des ersten Vollruns), soll dann:
   - (a) v0.4.3.1 mit 15s bleiben und Vollrun-Fail als "Kalibrierungs-Problem, siehe v0.4.3.2" dokumentieren?
   - (b) Bound bereits in v0.4.3.1 pro-Alias konfigurierbar machen mit Default aus tripP90LatencyMs?
   
   Meine Empfehlung: **(a)**. Das v0.4.3.1-Ticket ist "Recovery-Mechanik reparieren", nicht "Recovery-Kalibrierung". Zwei separate Bugs klar trennen.

2. **Ordering-Garantie im JavaScript-Runtime**: Node.js single-threaded, aber Promises können auf verschiedene Micro-Tasks scheduled sein. Ist `state.sequence++` und `state.probeInFlight=true` als atomare Sequenz sicher? Ich denke ja (synchroner Code zwischen `await`), aber will das explizit bestätigt haben bevor ich baue.

3. **PR #11 Merge-Strategie**: Muss PR #11 gemerged sein **bevor** ich `v043-cb-recovery-fix` von `v043-cb-latency-fix` abzweige, oder soll ich den Recovery-Branch parallel starten und rebasen wenn PR #11 mergt? Meine Präferenz: PR #11 zuerst mergen, damit `main` den latency-fix hat, dann Recovery von main abzweigen.

4. **Vollrun-Rerun Cost**: ~$25, ~1-3h wall. OK für die Session, oder wollen wir vorher noch einen kleineren Pre-Flight (30 Cases N=3) auf dem gefixten Code?

---

## 12. Was ich nach Freigabe von v3 tue

Streng in dieser Reihenfolge, keine Abkürzungen:

1. PR #11 committen und mergen (falls noch nicht) — Voraussetzung für `main` als Base von Recovery
2. Branch `v043-cb-recovery-fix` von aktuellem `main` erstellen
3. `CircuitBreaker.recoverFromOpen()` implementieren + Unit-Tests dafür
4. `HttpLlmClient` Router-Logic für soft-OPEN implementieren + `AliasSoftOpenState` Struktur
5. `recoveryMode`-Config-Feld erweitern, Default `'disabled'`
6. Telemetrie-Events emittieren
7. 12 Unit-Tests aus §6 schreiben, alle grün
8. Wenn du zusätzliches Pre-Flight willst (Frage 4): Mini-Run 30 Cases N=3 mit `recoveryMode='soft-open'` — Ergebnis + Report + Manifest auf `dql-benchmark/main` **vor** Vollrun
9. Vollrun 100 Cases × N=5 mit `recoveryMode='soft-open'`, workers=1
10. Rohdaten + Report + Manifest auf `dql-benchmark/main` (ein Commit)
11. PR #12 auf `v043-cb-recovery-fix` eröffnen — kein Merge ohne dein Vier-Augen-OK
12. Nach Merge: Recert-Entscheidung für `capitalPathMode=false` auf Prod-Kapital-Pfaden (separate Diskussion, `recoveryMode` bleibt `'disabled'` auf Prod)
