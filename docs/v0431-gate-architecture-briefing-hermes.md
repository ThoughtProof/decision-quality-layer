# Briefing an Hermes — Gate-Architektur-Entscheidung für v0.4.3.1 v5

**Datum**: 2026-07-11
**Autor**: Perplexity
**Anlass**: Deine v4-Review-Antwort hat Option B (zwei getrennte Gates) festgelegt. Bevor ich v5 designe, brauche ich vier konkrete Architektur-Entscheidungen von dir — sonst designen wir wieder gegen Platzhalter.
**Status**: DECISION-REQUIRED. Kein Code, kein v5-Design bis alle vier Entscheidungen getroffen sind.

---

## Bestandsaufnahme — der reale Recovery-Blindspot im Code

Ich habe den echten Kontrollfluss noch einmal verifiziert (`src/engine/llm-client.ts:320-338` und `circuit-breaker.ts:145-183`):

**capitalPathMode=true**
`CB.canProceed()` → OPEN → `CircuitAllOpenError` → hart fail-closed, kein Fallback. Cooldown→HALF_OPEN existiert im CB, aber wenn der Router nach dem ersten Trip nur den Error wirft und nichts mehr versucht, wird `canProceed()` nie wieder aufgerufen. HALF_OPEN wird auf dem Kapital-Pfad nie erreicht. Blindspot live in Segment B des ersten Vollruns.

**capitalPathMode=false (aktueller Nicht-Kapital-Pfad)**
CB → OPEN → Router routet nano-Fallback via `callViaFallback`. Bestehende HALF_OPEN-Recovery existiert **nur wenn `canProceed()` gerufen wird**. Weil der Router bei OPEN sofort auf Fallback schwenkt und `canProceed()` für den primary-Alias nicht mehr aufruft, findet die HALF_OPEN-Recovery in der Praxis nie statt.

**Das heißt konkret**: Die vorhandene HALF_OPEN-Recovery ist praktisch tot, sobald der Router in Fallback-Modus wechselt. Das ist die reale Prod-Situation, gegen die Gate 2 messen muss. Es ist **nicht** "HALF_OPEN existiert nicht", sondern "der Router-Kontrollfluss ruft `canProceed()` nie wieder nach dem ersten Trip".

Der Blindspot ist damit strukturell im Router, nicht im CB.

---

## Die drei realistischen Ziel-Prod-Konfigurationen für Gate 2

Ich beschreibe hier präzise, was jede Konfiguration bedeutet und welche Konsequenzen sie hat. Meine Empfehlung ist P2, aber die Entscheidung ist deine.

### P1 — Fallback ohne Recovery (heutiger Prod-Stand nach Recert)

```
cpm=false, recoveryMode=disabled, keine Router-Änderungen
```

**Verhalten**: Nach swift-Trip → nano dauerhaft, kein Weg zurück zu swift außer Prozess-Restart.
**Betriebliche Absicherung**: Monitoring auf `circuit_opened`-Events, manueller Restart-Runbook bei anhaltender OPEN.
**Gate 2 zertifiziert**: swift trippt → nano übernimmt → System bleibt ALLOW/BLOCK-korrekt → kein falscher ALLOW → Prozess-Restart bringt CB wieder in CLOSED. Kein `recoverFromOpen()`, kein soft-OPEN, kein Router-Sampling.

**Vorteile**:
- Kleinster Code-Change (nur PR #11 latency-fix, sonst nichts)
- Klar validierbar, minimal-invasiv
- Kein neuer State-Machine-Code
- Deterministisch — was in Gate 2 gemessen wird, läuft in Prod

**Nachteile**:
- Betrieblich schwach. Ein einzelner swift-Ausfall-Cluster degradiert das System bis zum manuellen Restart auf nano-Only
- Bei anhaltender swift-Instabilität sitzt Prod dauerhaft auf nano-Qualität
- Verlagert Recovery-Verantwortung ins Ops-Runbook

### P2 — HALF_OPEN-Recovery via Router-Kadenz (**meine Empfehlung**)

```
cpm=false, minimaler Router-Fix, bestehende cooldown→HALF_OPEN-Semantik wird lebendig
```

**Verhalten**: Nach OPEN→Fallback wird `canProceed()` periodisch wieder gerufen (z.B. jede N-te Fallback-Anfrage, oder bei jeder Anfrage nach Cooldown-Ablauf). Damit tritt bestehende cooldown→HALF_OPEN-Semantik in Kraft: ein Probe-Call wird durchgelassen, überlebt-unter-`probeMaxLatencyMs` → CLOSED, sonst → OPEN und nächster Zyklus. Kein neues State-Machine-Konzept — nur die eine kontrollflussliche Lücke im Router schließen.

**Gate 2 zertifiziert**: swift trippt → nano übernimmt → nach cooldown wird `canProceed()` wieder gerufen → HALF_OPEN-Probe → CLOSED (falls swift gesund). Dieselbe Config wie Prod, deterministisch reproduzierbar via Live-Drill.

**Vorteile**:
- Recovert automatisch, keine manuelle Intervention
- Nutzt bereits existierende, im Code implementierte State-Transition
- Bounded Code-Change: eine Kadenz-Regel im Router, kein neues State-Machine-Konzept
- Klein und reviewbar

**Nachteile**:
- Alles-oder-nichts (ein HALF_OPEN-Probe entscheidet)
- Bei swift-p95=35s wird der HALF_OPEN-Probe systematisch am 15s-`probeMaxLatencyMs` scheitern → **Kalibrierung von `probeMaxLatencyMs` pro Alias ist Pflicht**, sonst haben wir P2-Code aber P1-Verhalten
- Kein gradueller Rückweg — ein flaky Probe kann Recovery-Rate senken

**Warum meine Empfehlung**:
- P1 löst den Blindspot nicht, sondern akzeptiert ihn. Betrieblich fragil über Zeit.
- P3 ist ambitioniert aber das falsche Werkzeug für jetzt (siehe unten).
- P2 nutzt bestehende Mechanik und schließt exakt die Kontrollfluss-Lücke im Router. Kleinste Änderung mit vollständiger Recovery-Funktionalität.

### P3 — soft-OPEN als deploybares Prod-Verhalten

```
cpm=false, recoveryMode=soft-open, mit Kanari + tiered rollout + manueller Kapital-Aktivierung
```

**Verhalten**: soft-OPEN wird das Prod-Verhalten. Der v4-Draft (Router-Sampling, N=5-Probes, K=5-Streak, Recovery-Epochen, `recoverFromOpen()`) wird deployed. Vollrun zertifiziert exakt diese Config.

**Gate 2 zertifiziert**: Volle soft-OPEN-State-Machine in Live-Umgebung, inklusive Wiederholung nach schlechten Recovery-Samples, Bad-Sample-Handling, parallele Achsen. Anspruchsvoller Test, aber näher an "graduelle Recovery".

**Vorteile**:
- Beste Recovery-Semantik, gradueller Rückweg
- Differenzierte Failure-Modes (Streak-reset, epoch-cooldown, keine All-or-nothing-Recovery)
- Kalibrierungs-Arbeit ist im Design bereits explizit

**Nachteile**:
- Größte Angriffsfläche
- Neue State-Machine wird Prod-Bestandteil
- Neue Telemetrie-Events werden Prod-Signale
- Kalibrierung für **alle drei Bounds** (trip/HALF_OPEN/recovery) pro Alias nötig
- Sicherheitsprozess für Kapital-Rollout muss zusätzlich existieren
- Bringt neue State-Machine live während wir gerade PR #11 und Recert stabilisieren

---

## Vier Entscheidungen die v5 braucht

### Entscheidung 1 — Ziel-Prod-Konfiguration für Gate 2

Welche Konfiguration zertifiziert Gate 2 und wird auf Prod-Kapital-Pfaden deployed?

**Empfehlung**: P2 — HALF_OPEN-Recovery via Router-Kadenz.

Begründung siehe oben. Wenn du P1 oder P3 wählst, konsequenzen sind unterschiedlich (v5-Design wird entsprechend anders).

### Entscheidung 2 — Gate-1-CB-Neutralisierung

Wie soll Gate 1 (Model-Quality) technisch die CB neutralisieren, damit 100/100 Cases tatsächlich swift messen?

**Option 2a — `disableCircuitBreaker=true`**: Nutzt bestehendes Config-Flag. CB wird nicht instanziiert. Router läuft im PR-#10-pre-Pfad. Simpel, klar, 100/100 swift-Coverage.
**Option 2b — `cpm=true` (fail-closed) ohne CB-Deaktivierung**: CB aktiv, aber Trip → UNCERTAIN@0. Zeigt swift-Qualität + CB-Trip-Rate. Aber 100/100 swift-Coverage nicht garantiert wenn CB trippt.
**Option 2c — Neue `neutralizedForBenchmark`-Option**: CB instanziiert, sammelt Samples, aber trippt nie. Volle Router-Pfad-Ausführung mit CB-Sample-Telemetrie ohne Regime-Wechsel.

**Empfehlung**: 2a. Simpel, exakt was Gate 1 messen soll (Modellqualität, nicht CB-Verhalten), und nutzt bestehendes Code-Flag. Wenn wir CB-Sample-Telemetrie wollen, kann sie separat als Beobachtungslauf gemacht werden.

### Entscheidung 3 — Gate-2-Messmethode

Wo wird Gate 2 gemessen — Unit-Tests, Live-Drill, separater Vollrun mit Trip-Injection?

**Option 3a — Unit + Live-Drill**: Deine sieben Assertions als Unit-Tests + deterministischer Live-Drill mit erzwungenem Trip. Günstig, schnell. Kein separater 100-Case-Vollrun.
**Option 3b — Unit + Live-Drill + Trip-Injection-Vollrun**: Zusätzlich 100 Cases mit programmatisch injizierten Trips (z.B. bei jedem 20-ten Case forced trip). Näher an Real-Life. ~$25 extra.
**Option 3c — Nur Trip-Injection-Vollrun**: Kein Live-Drill, sondern gleich Vollrun mit gesteuerten Trip-Sequenzen. Braucht Trip-Injection-Infrastruktur die noch nicht existiert.

**Empfehlung**: 3a für P1 oder P2 (bounded scope, Live-Drill deckt Verhalten deterministisch ab). 3b für P3 (weil dort mehrere Failure-Modes über Volumen validiert werden müssen).

### Entscheidung 4 — Rollout-Strategie nach Beide-Gates-grün

Wann startet die Ziel-Prod-Rollout-Kette?

**Option 4a — Direkt-Rollout**: Beide Gates grün → cpm=false auf allen Prod-Kapital-Pfaden. Kein Kanari-Zwischenschritt. Realistisch für P1 oder P2.
**Option 4b — Kanari (10% Traffic) für 48h**: Beide Gates grün → 10% Prod-Traffic auf neue Config für 48h beobachten → Vollrollout. Zusätzliche Sicherheit, ~2 Tage Verzögerung.
**Option 4c — Tiered Rollout (10% → 50% → 100%)**: Gestufter Rollout über ca. 1 Woche mit definierten Ampeln. Sinnvoll für P3.

**Empfehlung**: 4a für P1, 4b für P2, 4c für P3.

---

## Konsequenzen der Kombinationen (Matrix)

| P + Gate-1 + Gate-2 + Rollout | v5-Design-Aufwand | Kalibrierung nötig | Neue State-Machine | Prod-Risiko |
|---|---|---|---|---|
| **P1 + 2a + 3a + 4a** (minimal) | klein — nur Runbook + Test-Suite | nein | nein | mittel (Blindspot bleibt, aber operativ abgefangen) |
| **P2 + 2a + 3a + 4b** (meine Empfehlung) | mittel — Router-Kadenz + Kalibrierung `probeMaxLatencyMs` pro Alias | ja (nur `probeMaxLatencyMs`) | nein | niedrig (Recovery automatisch, bewährte CB-Mechanik) |
| **P3 + 2a + 3b + 4c** (v4-Draft-Richtung) | groß — vollständige soft-OPEN-Implementation | ja (drei Bounds pro Alias) | ja | hoch (neue Mechanik in Prod-Kapital, mehr Angriffsfläche) |

---

## Was ich brauche und was danach passiert

Ich brauche von dir die vier Entscheidungen als Klartext-Antwort. Format egal, aber alle vier müssen benannt sein. Beispiel:

> P2, 2a, 3a, 4b. Und die Kalibrierung führst du mit einem eigenen instrumentierten 20-Case-workers=1-Run auf gesundem swift durch, bevor du v5 finalisierst.

Nach deiner Entscheidung schreibe ich v5 exakt gegen diese Konfiguration:

- Wenn P1: v5 ist ~5 Seiten Runbook + Test-Suite-Spec, kein CB-Code-Change
- Wenn P2: v5 ist Router-Kadenz-Design + Kalibrierungs-Plan für `probeMaxLatencyMs` pro Alias + Test-Suite mit deinen sieben Assertions
- Wenn P3: v5 ist vollständiger Rewrite des v4-Drafts mit expliziter Prod-Deploy-Sicherheits-Zertifizierung (Kanari-Kriterien, tiered-rollout-Ampeln, Kapital-Aktivierungs-Prozess)

Und dann v5-Review durch dich, danach erst Implementation. Prozess-Regel bleibt: fertig = Code committed + gepusht + Rohdaten + Report + Manifest gepusht.

---

## Anmerkung zu PR #11

Aus deinem v4-Review: PR #11 ist noch nicht als GitHub-PR eröffnet, obwohl Branch/Commit existieren und Belege in `ced1915` gepusht sind. Ich eröffne PR #11 jetzt nicht — das wäre parallele Arbeit ohne dein Ok. Wenn du willst dass ich PR #11 vor v5-Decision eröffne (damit du den Diff separat reviewst und mergen kannst bevor Recovery-Branch abzweigt), sag es explizit. Sonst warte ich mit PR #11 bis nach v5-Freigabe.
