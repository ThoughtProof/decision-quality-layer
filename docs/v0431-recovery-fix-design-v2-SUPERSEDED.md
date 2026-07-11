# v0.4.3.1 CB Recovery Fix — Design Draft v2 (SUPERSEDED)

> **SUPERSEDED by v3** — Hermes-Review 2026-07-11 identifizierte 6 kritische Lücken:
> capitalPathMode-Verkopplung, kein Recovery-Epoch-Konzept, `forceClose` umgeht Invarianten,
> keine Parallelitäts-Semantik, mutable capitalPathMode-Test, grün-aber-wirkungslos-Acceptance.
> **Nicht zur Implementierung.** Historischer Zwischenstand. Siehe `docs/v0431-recovery-fix-design.md` (v3).

**Status**: SUPERSEDED
**Priority**: v0.4.3.1 blocking (was formerly v0.4.4 roadmap)
**Author**: Perplexity (recording Hermes' architectural decision)
**Date**: 2026-07-11
**Iteration**: v2 (Hermes rejected Sub-Option 2, chose Sub-Option 3 with capital-path safety carve-out)

---

## Was Hermes entschieden hat

**Sub-Option 3 (soft-OPEN)**, mit vier harten Präzisierungen:

1. **capitalPathMode=true → kein soft-Recovery**. Dort bleibt das heutige fail-closed-Verhalten unverändert. Recovery-Automatik ist ein Verfügbarkeits-Feature für Benchmark-Runs, kein Kapital-Pfad-Feature.
2. **Traffic ist die Probe, kein synthetisches Payload**. Reale DQL-Achsen-Calls im soft-OPEN-Regime — 1 von N durchgelassen, Rest fallback. Beobachten statt raten.
3. **Logik gehört in `HttpLlmClient.call()` Routing-Schicht**, nicht in die `CircuitBreaker`-Klasse. Die CB bleibt eine kontext-freie State-Machine ohne Wissen über capitalPathMode.
4. **Prozess-Regel** (retroaktiv seit 2026-07-11): "fertig" = committed + gepusht + Rohdaten/Manifest gepusht.

**Verworfen**:

- Sub-Option 2 (zeit-basierter Cooldown mit Window-Flush) — rät statt zu messen, "3 echte Calls in Folge" nach Cooldown-Ablauf setzt ungetesteten Provider auf realen Traffic scharf, Flapping mit Zeitverzögerung.
- 50-Token-Ping (formerly Option A) — Probe-Latenz spiegelt echte Achsen-Latenz nicht wider, Circuit flappt.

---

## Wo genau der Fix ansetzt (Code-Anker)

Kein Change in `src/engine/circuit-breaker.ts`. Die CB behält ihre 3 States (CLOSED / OPEN / HALF_OPEN) und bleibt kontext-frei.

**Alle Changes in `src/engine/llm-client.ts`**, spezifisch im Routing-Teil von `HttpLlmClient.call()`. Die capitalPathMode-Verzweigung existiert bereits an Z330 (primary trip) und Z364 (fallback trip); die soft-OPEN-Logik läuft parallel dazu.

Konzeptionell:

```
call(alias, prompt) {
  breaker = getBreaker(alias)

  if (breaker.state === 'OPEN' && !capitalPathMode) {
    // soft-OPEN gate: nur benchmark
    if (shouldLetThrough(alias)) {
      // dieser Call wird als Recovery-Sample benutzt
      result = tryPrimary()
      registerRecoverySample(alias, result.latency, result.failed)
      return result  // oder fallback wenn tryPrimary getripped
    } else {
      // Standard fallback path (rest der N-1 Calls)
      return fallback()
    }
  }

  // capitalPathMode=true: klassisches Verhalten, kein soft-OPEN
  // canProceed() throws → fail-closed über CircuitAllOpenError
  ...
}
```

---

## State-Machine (nur soft-OPEN-Erweiterung)

Der CircuitBreaker selbst kennt nur CLOSED / OPEN / HALF_OPEN wie heute. Die soft-OPEN-Semantik ist eine **Router-Interpretation** von "state=OPEN + capitalPathMode=false":

```
CLOSED
  ↓ (trip via p90 oder failure_rate)
OPEN
  ↓ (Router-side, benchmark-only): "soft-OPEN" — 1 von N Calls wird durchgelassen
  ├─ Sample-Sequenz akkumuliert im Router (nicht im CB-Sample-Window)
  ├─ 3 aufeinanderfolgende Samples unter tripP90LatencyMs → recordSuccess()×3 auf den CB → CB von OPEN direkt zurück nach CLOSED
  └─ irgendein Sample über Threshold → Router markiert "hard-OPEN"
     ↓
HARD-OPEN
  ↓ (klassisches HALF_OPEN-mit-cooldown via canProceed(), wie heute)
  Recovery nur durch cooldownMs-Ablauf → HALF_OPEN probe → success → CLOSED
```

**Wichtig**: Der CB weiß nichts von "soft" vs "hard" OPEN. Der Router entscheidet basierend auf `(cb.state, capitalPathMode, softOpenAttempts, softOpenSuccesses)`.

## Sample-Kontabilität

Die 3 Sample-Sequenz-Zählung darf **nicht** in `CircuitBreaker.samples[]` gespeichert werden — das würde die Trip-Logik verändern. Stattdessen:

- **Router-lokale Struktur** pro Alias: `{ softOpenAttempts: 0, softOpenConsecutiveSuccesses: 0, softOpenActive: boolean }`
- Bei Successful Recovery-Sample: `softOpenConsecutiveSuccesses++`; wenn `>= K` (Threshold, siehe unten), rufe `breaker.recordSuccess()` mehrfach mit dem gemessenen latency, um die Trip-Bedingung zurückzusetzen → CB transitioniert transparent zurück auf CLOSED via seine eigene Recovery-Logik
- Bei irgendeinem Sample über Threshold ODER Failed Call: `softOpenActive = false`, `softOpenConsecutiveSuccesses = 0`, Router fällt zurück auf HARD-OPEN-Interpretation → CB.canProceed() throwt weiter

**Alternative**: eigene Router-Methode `breaker.transitionOpenToClosed()` — expliziter, aber verändert die CB-API. Auf 4 Augen zu diskutieren: nutze ich `recordSuccess`×K als natürliche State-Transition, oder eine explizite `reset()`-artige Methode?

Meine Präferenz: `recordSuccess`×K. Grund: kein neuer API-Punkt in der CB, die Success-Latenzen sind echte Samples (nicht synthetische), und die CB-eigene Recovery-Logik (HALF_OPEN → CLOSED bei probeMaxLatencyMs-under-Verhalten) macht die Arbeit ohne dass wir sie extern erzwingen.

**Aber**: das bedeutet der CB muss den ersten Recovery-Sample als HALF_OPEN-Probe akzeptieren. Aktuell erlaubt `canProceed()` HALF_OPEN nur nach cooldownMs-Ablauf. Wir umgehen das:

- Router ruft `breaker.canProceed()` NICHT im soft-OPEN-Regime (er weiß dass es OPEN ist und würde throwen)
- Router ruft direkt `breaker.recordSuccess(latency)` mit dem gemessenen Sample
- Nach K aufeinanderfolgenden Success-Samples unter Threshold: CB-`samples[]` enthält K Werte die alle unter tripP90LatencyMs sind → **aber** die CB ist noch OPEN, weil `state` sich nur in `canProceed()` ändert

**Das ist die Design-Lücke, die ich noch nicht sauber gelöst habe.** Zwei Wege:

**Weg A**: Router ruft nach K erfolgreichen Samples explizit `breaker.forceClose()` (neue CB-API). Klar, aber CB-API-Erweiterung.

**Weg B**: Router setzt `openedAt` zurück auf `now - cooldownMs - 1` bevor er `canProceed()` ruft. Dann läuft der letzte Recovery-Sample durch den normalen HALF_OPEN-Pfad. Hacky, benutzt private State.

**Meine Empfehlung**: Weg A. `forceClose(reason: string)` als expliziter Router-Escape-Hatch, mit Telemetrie-Log. Sauber, testbar, dokumentiert.

---

## Parameter (Draft zur Kalibrierung)

Alle Parameter benchmark-only (`capitalPathMode=false`), im `HttpLlmClientConfig`:

| Parameter | Vorschlag | Begründung |
|---|---|---|
| `softOpenSampleRate` | 1 von N=5 Calls durchgelassen | Balance zwischen Recovery-Speed und Fallback-Anteil. Bei N=5 ist der Router zu 80% im fallback, zu 20% im Recovery-Test — genug Signal, wenig Traffic-Risiko. |
| `softOpenConsecutiveThreshold` | K=3 aufeinanderfolgende Samples unter tripP90LatencyMs | Hoch genug dass ein einzelner Lucky-Call nicht schließt, niedrig genug für sinnvolle Recovery-Zeit. Bei sampleRate=1/5 = 3 Samples ≈ 15 Verifikationen wall. |
| `softOpenLatencyBound` | inherit `tripP90LatencyMs` (aktuell 15_000ms) | Konsistenz mit Trip-Threshold — recovery erfordert dieselbe Latenz-Klasse die Trip auslösen würde. |
| `softOpenHardTripAfter` | 1 (bei erstem Sample über Threshold: sofort hard-OPEN) | Keine zweite Chance im soft-OPEN. Ein einziger schlechter Sample = Provider nicht recovered. |

**Hermes' Hinweis war explizit**: K=3 muss hoch genug sein für Robustheit. Meine Frage zurück: **K=3 oder K=5?** Bei sampleRate=1/5, N=100 Cases × 5 draws × 5 axes = 2500 total axis calls:

- K=3: Recovery frühestens nach ~15 axes (~3 Verifikationen) im soft-OPEN
- K=5: Recovery frühestens nach ~25 axes (~5 Verifikationen)

Vollrun-Beispiel: nach Trip bei adv_017 (Case 17), bei K=3 wäre Recovery frühestens bei Case ~20 möglich. Bei K=5 frühestens bei Case ~22. Beide führen zu **~80% primary-Anteil über 100 Cases**, was das Empirisch-Kriterium erfüllt. K=5 defensiver.

Meine Empfehlung: **K=5**, weil das Empirisch-Kriterium (>80% primary) mit beiden erreichbar ist und K=5 mehr Puffer gegen "einmal Glücks-Call in einer instabilen Umgebung" bietet.

---

## Interaktion mit capitalPathMode=true

Klar und einfach: **soft-OPEN wird niemals aktiv wenn `capitalPathMode=true`**.

Konkret im Router:

```typescript
// Pseudocode
if (breaker.state === 'OPEN') {
  if (this.capitalPathMode) {
    // Klassisches Verhalten: kein Fallback, kein soft-OPEN
    breaker.canProceed()  // throwt CircuitOpenError → engine fail-closed
  } else {
    // benchmark-Pfad: soft-OPEN mit sampling
    if (this.shouldSoftOpenSample(alias)) {
      return await this.tryWithRecoveryTracking(alias, ...)
    } else {
      return await this.fallback(alias, ...)  // ohne soft-OPEN-Zählung
    }
  }
}
```

Konsequenz bei Prod-Kapital-Pfaden nach einem Trip: **wie heute** — CircuitAllOpenError → UNCERTAIN@0 → Alarm → Mensch. Die Verfügbarkeits-Debt bleibt bewusst offen; sie wird durch **Betriebsverfahren** (Alerting + manueller Redeploy) gemanaged, nicht durch Auto-Recovery, weil "auto-scharf-schalten" auf einem Kapital-Pfad das falsche Trade-off ist.

Das ist eine **absichtliche Design-Entscheidung**, keine TODO. Wenn wir später Verfügbarkeits-Automatik auf Kapital-Pfaden wollen, ist das ein separater Ticket mit anderen Anforderungen (Kanari, tiered rollout, manuelle Freigabe).

---

## Tests

**Neue Unit tests im Router** (nicht in circuit-breaker.test.ts):

1. `softOpen: capitalPathMode=true → no soft-OPEN attempts, fail-closed on CircuitOpenError` — beweist die Sicherheitsregel
2. `softOpen: capitalPathMode=false, state=OPEN → 1 von 5 Calls geht durch, rest fallback` — Sampling-Rate
3. `softOpen: K=5 consecutive samples under threshold → CB force-closed, subsequent traffic primary` — Recovery-Bedingung
4. `softOpen: sample over threshold → hard-OPEN, kein weiterer soft-OPEN attempt bis cooldown` — Escape-Path
5. `softOpen: capitalPathMode wechselt zwischen calls von false auf true → soft-OPEN-Attempts sofort gestoppt` — Race-Condition

**Empirisches Kriterium (das eigentliche Gate)**:

- Vollrun-Rerun `v043_swift_primary_recert_w1` mit dem Fix MUSS zeigen: **primary-Route-Anteil > 80% über alle 100 Cases**, capitalPathMode=false
- Sekundär: capitalPathMode=true-Vollrun (falls neu gebaut) MUSS gleiches Verhalten wie ohne Fix zeigen (fail-closed, keine soft-Recovery) — beweist die Sicherheitsregel unter echtem Traffic

---

## Was ich als Nächstes NICHT tue

- Kein Code bis wir den Draft durch haben
- Kein Kompilieren, keine Tests, kein Push
- Kein PR-Draft für v0.4.3.1

## Was ich als Nächstes tue, wenn du Draft freigibst

1. Router-Logik in `HttpLlmClient.call()` implementieren, `capitalPathMode`-Verzweigung erweitern
2. `CircuitBreaker.forceClose(reason)` als expliziten Router-Escape-Hatch, mit Test dass er nur aus dem Router aufgerufen wird
3. Config: `softOpenSampleRate` (N=5 default), `softOpenConsecutiveThreshold` (K=5 default), `softOpenLatencyBound` (inherit tripP90LatencyMs), `softOpenHardTripAfter` (1 default)
4. 5 neue Router-Tests wie oben
5. Vollrun-Rerun `v043_swift_primary_recert_w1` mit dem Fix, workers=1, N=5, ~24 Min wall
6. Rohdaten + Report + Manifest auf `dql-benchmark/main` VOR PR-Öffnung
7. PR (v0.4.3.1) auf `decision-quality-layer/v043-cb-latency-fix` (aufbauend auf PR #11) oder neuer Branch — deine Wahl

## Offene Design-Fragen an dich

1. **K=3 oder K=5**? Ich empfehle K=5 (defensiver). Argument dagegen: Recovery langsamer, längere Fallback-Phase im Vollrun.
2. **`CircuitBreaker.forceClose(reason)` als neue Public-API** — ok, oder soll die State-Transition anders erzwungen werden? Ich sehe keinen sauberen Weg ohne API-Erweiterung.
3. **Branch-Strategie**: v0.4.3.1 auf `v043-cb-latency-fix` draufsetzen (dann ein PR mit beiden Fixes), oder eigener Branch `v043-cb-recovery-fix` von `v043-cb-latency-fix` abgezweigt (zwei PRs, klarer trennbar)? Meine Präferenz: eigener Branch, klare Bounded-Reviews.
4. **Telemetrie**: Wollen wir Recovery-Attempts als eigenes Event loggen (für Observability), oder reicht die Standard-CB-State-Transition-Log-Line?
