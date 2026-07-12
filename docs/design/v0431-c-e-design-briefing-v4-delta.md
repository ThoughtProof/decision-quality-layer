# Design v4 — Vertragsanhang S1/S2/S3

**Basis:** `docs/design/v0431-c-e-design-briefing-v4.md`
**Grundlage:** Hermes' Sanity-Review v4 (`v0431-c-e-design-v4-review.md`)
**Status:** verbindliches Delta zu v4; kein neues Vollzeit-Design. GO für E-core-Implementierung nach diesen drei Klarstellungen.

Dieser Anhang ändert **nur** die drei Punkte S1/S2/S3 aus dem v4-Review. Alles andere aus v4 bleibt wortgleich in Kraft.

---

## S1 — Epoch-Prüfung ist natürlich erreichbar

v4-Abschnitt 2.5 wird durch die folgende **exakte** Prüfungsreihenfolge in `recordOutcome` ersetzt:

```ts
// Nach K2 Identitäts-Prüfungen (invalid_token / already_consumed)
// und D6a Latency-Validation:

if (token.kind === 'normal') {
  if (this.state !== 'CLOSED') {
    return staleResult('wrong_state');
  }
  if (token.closedEpoch !== this.closedEpoch) {
    return staleResult('wrong_epoch');
  }
  return acceptNormalSample(outcome);
}

if (token.kind === 'probe') {
  if (this.state !== 'HALF_OPEN') {
    return staleResult('wrong_state');
  }
  if (token.tripGeneration !== this.tripGeneration) {
    return staleResult('wrong_generation');
  }
  if (
    token.recoveryEpoch !== this.recoveryEpoch ||
    token.probeSequence  !== this.probeSequence
  ) {
    return staleResult('wrong_epoch');
  }
  return acceptProbeOutcome(outcome);
}
```

`wrong_epoch` ist damit im Normal-Zweig ein natürlich erreichbarer Concurrency-Fall (parallel admittierter Call kehrt zurück, nachdem der Breaker eine volle Trip-Recovery durchlaufen hat). Im Probe-Zweig bleiben `wrong_generation`/`wrong_epoch` defensive Guards, werden aber vollständig geprüft.

### Neuer Pflicht-Test (T27)

```text
Setup: Two normal admissions A, B in CLOSED (closedEpoch=0).
Step 1: A trips (many failures) → recordOutcome(A) leads to closed_to_open.
Step 2: Probe P admitted; probe succeeds → half_open_to_closed → closedEpoch=1.
Step 3: recordOutcome(B, success)
Expected: accepted=false, event=stale_result{wrong_epoch}.
Sample window count in current CLOSED cycle: still 0.
```

Dies ersetzt die Aussage in v4 T3, die nur den OPEN/HALF_OPEN-Fall abdeckt. T3 bleibt bestehen; T27 kommt zusätzlich.

---

## S2 — `attemptedRoutes` bleibt strukturiertes Feld ausschließlich von `CircuitAllOpenError`

Die Provenienz-Matrix (v4 §2.8, Test 23) wird auf **zwei disjoint verifizierbare Kanäle** aufgeteilt:

**Kanal 1 — `CircuitAllOpenError.attemptedRoutes`** (bestehendes Repo-Verhalten aus `77c3345`, unverändert):

| Terminaler `CircuitAllOpenError` | `attemptedRoutes` |
|---|---|
| Primary-Admission reject + Fallback-Admission reject | `[]` |
| Primary-Fetch trippt + Fallback-Admission reject | `['primary']` |
| CPM + Primary-Admission reject | `[]` |
| CPM + Primary-Fetch trippt/reöffnet | `['primary']` |

**Kanal 2 — interne Diagnostics** (`RuntimeDiagnosticsSnapshot`):

Terminale Provider-Fehler ohne `CircuitAllOpenError` werfen den **ursprünglichen** Fehler:

- `Primary admission reject → Fallback-Fetch failed`: geworfen wird der ursprüngliche Fallback-Provider-Error. Die tatsächlich versuchte Route ist über `AttemptEvent`/`BindingAttemptSummary` mit `route='fallback'` belegt. `attemptedRoutes` wird **nicht** auf den Raw-Error gesetzt.
- `Primary fetch trips → Fallback-Fetch failed`: geworfen wird der ursprüngliche Fallback-Provider-Error. `AttemptEvent`/`BindingAttemptSummary` enthalten je einen `primary`- und einen `fallback`-Eintrag.

**Test 23 wird ersetzt** durch:

```text
T23a (CircuitAllOpenError.attemptedRoutes): 4 Zeilen aus Tabelle oben.
T23b (Diagnostics-Kanal, non-CircuitAllOpenError):
  - Primary admission reject + fallback fetch fails
    → thrown = original fallback error
    → diagnostics: 1 fallback AttemptEvent, 1 fallback BindingAttemptSummary,
                   0 primary AttemptEvents
  - Primary fetch trips + fallback fetch fails
    → thrown = original fallback error
    → diagnostics: >=1 primary AttemptEvent, 1 primary BindingAttemptSummary,
                   >=1 fallback AttemptEvent, 1 fallback BindingAttemptSummary
```

Damit bleibt der Baseline-Fehler-Vertrag aus `77c3345` unverändert; keine `attemptedRoutes`-Property auf Raw-Errors erfunden; die Provenienz ist beweisbar über die getrennten Diagnostics-Puffer.

### `CircuitAllOpenError`-Verwendungsbereich

`CircuitAllOpenError` wird geworfen genau dann, wenn:

- Primary-Admission abgelehnt **und** Fallback-Admission abgelehnt, **oder**
- Primary-Fetch trippt/reöffnet den Primary-Breaker **und** Fallback-Admission abgelehnt, **oder**
- CPM=true und Primary-Admission abgelehnt (kein Fallback-Versuch), **oder**
- CPM=true und Primary-Fetch trippt/reöffnet (kein Fallback-Versuch).

In allen anderen Fehlerpfaden (Fallback tatsächlich versucht und mit Provider-Fehler beendet) wird der ursprüngliche Provider-Error geworfen — kein synthetisches `CircuitAllOpenError`.

---

## S3 — Diskriminierender Token-Typ

v4 §2.2 wird durch die folgende Typdeklaration ersetzt:

```ts
export type NormalAdmissionToken = Readonly<{
  kind: 'normal';
  admissionSequence: number;
  closedEpoch: number;
  stateRevision: number;
}>;

export type ProbeAdmissionToken = Readonly<{
  kind: 'probe';
  admissionSequence: number;
  tripGeneration: number;
  recoveryEpoch: number;
  probeSequence: number;
  stateRevision: number;
}>;

export type CircuitAdmissionToken = NormalAdmissionToken | ProbeAdmissionToken;

export type CircuitAdmission =
  | {
      kind: 'normal';
      token: NormalAdmissionToken;
      events: readonly CircuitTransitionEvent[];
    }
  | {
      kind: 'probe';
      token: ProbeAdmissionToken;
      events: readonly CircuitTransitionEvent[];
    };
```

`recordOutcome` diskriminiert dann typseitig sauber via `token.kind`. Keine Laufzeitsemantik-Änderung.

---

## Zwei kleine Klarstellungen

- **Testanzahl**: v4 §4-Überschrift „22 Tests" ist Tippfehler; korrekt sind 26 Tests + neu T27 aus S1 → **27 Tests total** im E-core-Diff. Der Testplan selbst listet die richtige Anzahl.
- **`CircuitAllOpenError`**: bleibt genau für die vier oben genannten Situationen zulässig.

---

## Freigabegrenze

S1, S2, S3 werden im **selben E-core-Diff** implementiert. Kein v5-Dokument. GO für E-core auf `77c3345` direkt nach Commit dieses Δ-Docs.
