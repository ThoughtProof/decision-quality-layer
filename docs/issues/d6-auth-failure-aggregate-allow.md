# D6: Einzelner Auth-/Provider-Fehler ⇒ Achse `UNCERTAIN`@0, Aggregat kann `ALLOW` sein (Fail-Open)

**Für:** Hermes **Von:** Paul
**Charakter:** Lokaler Issue-Entwurf (NOCH KEIN öffentliches Issue). Read-only-Befund aus dem §C+integration-Audit gegen PR-HEAD `0fab28c5421f42a67bbc12f635eaf2f61700a510`.
**Klassifikation:** **Wahrscheinlicher Bug / Modul-Kompositions-Lücke** (kein etabliertes Verhalten, keine bewusste Aggregationspolitik für den `confidence=0`-Fall).
**Blocker-Status:** **NICHT blockierend** für die Preview-Canary (Schritt 3) — **blockierend VOR** `Draft→Ready` / `Merge` / Production-Alias-Wechsel.

---

## 1. Beobachtetes Verhalten (verifiziert am Code)

Ein **einzelner** Achsen-Fehlschlag durch einen Auth-/Provider-Fehler (D6-Drill: Provider-401) führt zu einem Aggregat-Verdikt **`ALLOW`**, obwohl eine Achse nicht ausgewertet werden konnte.

**Kette (Code als Wahrheit):**

1. `src/engine/index.ts:73-111` — Der Per-Achsen-`catch` mappt **jeden** Achsen-Fehler auf `verdict:'UNCERTAIN', confidence:0`.
   - Nur bei `CircuitAllOpenError` wird zusätzlich `provider_outcome` gesetzt (`attemptedRoutes.length===0 → 'circuit_rejected'`, sonst `'provider_error'`). Ein reiner Auth-/HTTP-Fehler, der **kein** `CircuitAllOpenError` ist, lässt `provider_outcome` **undefiniert**.
2. `src/aggregation.ts:26-89` — Regelkaskade:
   - Regel 2 (`aggregation.ts:58`) verlangt **≥2** UNCERTAIN → REVIEW.
   - Regel 4 (`aggregation.ts:78`) verlangt UNCERTAIN mit **`confidence ≥ 0.7`** (`HIGH_CONF_UNCERTAIN=0.7`, `aggregation.ts:24`) → REVIEW.
   - Eine **einzelne** `UNCERTAIN`@`confidence=0`-Achse trifft **keine** Regel und fällt auf **Regel 5 → `ALLOW`** (`aggregation.ts:88`), Rationale `"All evaluated axes pass."`.
3. D6-Drill nutzt **1 Achse**; Provider-401 ⇒ diese Achse `UNCERTAIN`@0 ⇒ Aggregat `ALLOW`. Die Drill-Doku erklärt den HTTP-Status bewusst zum **Nicht-Kriterium**, daher schlug der Drill hier nicht an.

## 2. Widerspruch zur dokumentierten Absicht

`src/engine/index.ts:54-61` behauptet eine **Fail-Closed-Absicht**:

> „… the aggregator … will emit a **REVIEW or worse — never ALLOW** — because UNCERTAIN cannot upgrade to PASS.“

Das gilt tatsächlich **nur**:
- bei **≥2** UNCERTAIN (Host-Ausfall über mehrere/alle Achsen, Regel 2), **oder**
- bei UNCERTAIN mit **`confidence ≥ 0.7`** (Regel 4).

Für die **Einzel-Achsen-Auth-Fehler-Situation** mit **`confidence=0`** gilt es **nicht**. Zusätzlich ist die Rationale `"All evaluated axes pass."` **sachlich falsch**, wenn eine Achse `UNCERTAIN` ist.

Der Fail-Closed-Pfad setzt gezielt `confidence=0` und unterläuft damit Regel 4, die für **hohe** Unsicherheit entworfen wurde. Das ist die Modul-Kompositions-Lücke: die beiden Module widersprechen sich an genau dieser Schnittstelle.

## 3. Test-Evidenz (Status quo)

- **Nicht gepinnt.** Kein Test schreibt „single low-confidence UNCERTAIN → ALLOW“ als *gewolltes* Verhalten fest.
- `src/aggregation.test.ts:65` prüft „single high-confidence UNCERTAIN“ mit `confidence=0.85` → REVIEW (Regel 4). Der `confidence=0`-Fall bleibt ungetestet.
- `src/aggregation.test.ts:53` prüft ≥2 UNCERTAIN → REVIEW (Regel 2).
- `src/engine/engine-provider-outcome.test.ts` prüft nur den **Achsen-Verdikt** (`UNCERTAIN`@0 ± `provider_outcome`), **nicht** das resultierende Aggregat.

## 4. Warum „wahrscheinlicher Bug“ und nicht „bewusste Politik“

1. Dokumentierte Fail-Closed-Absicht (`index.ts:54-61`) steht im direkten Widerspruch zum tatsächlichen Aggregat.
2. Regel 4 wurde ausweislich Kommentar/Testlage für **hohe** Unsicherheit (`≥0.7`) entworfen; der Fail-Closed-Pfad setzt aber bewusst `confidence=0` und fällt dadurch durch das Raster.
3. Keine Testabsicherung des `ALLOW`-Ausgangs für diesen Fall.
4. Irreführende Rationale („All evaluated axes pass“), obwohl eine Achse nicht auswertbar war.

## 5. Vorgeschlagene Akzeptanzkriterien (für einen späteren Fix — NICHT hier implementiert)

> Der Fix ist **Approval-pflichtig** und gehört **nicht** in die reversible Canary-Vorbereitung. Hier nur die Kriterien, an denen ein späterer Fix zu messen ist. Keine finale Code-Vorschrift ohne begleitende Tests.

Ein akzeptierter Fix MUSS:

1. Sicherstellen, dass eine Achse, die aufgrund eines Auth-/Provider-Fehlers nicht ausgewertet werden konnte, das Aggregat **niemals** auf `ALLOW` fallen lässt — Ergebnis **`REVIEW` oder schlechter**, **unabhängig** von `confidence` (also auch bei `confidence=0`).
2. Eine **wahrheitsgemäße Rationale** liefern (nicht „All evaluated axes pass“, wenn eine Achse `UNCERTAIN` war).
3. Durch mindestens folgende **neue/erweiterte Tests** abgesichert sein:
   - `aggregation`: „single UNCERTAIN mit `confidence=0` und provider-fehler-Provenienz → REVIEW (nicht ALLOW)“.
   - Engine↔Aggregat-Integration: eine einzelne fehlgeschlagene Achse (Auth-401 **und** `CircuitAllOpenError`-Varianten) ⇒ Aggregat `REVIEW`.
   - Regression: die bestehenden Fälle (Regel 2 ≥2 UNCERTAIN; Regel 4 `≥0.7`) bleiben grün.
4. Den Kommentar-Contract in `index.ts:54-61` mit dem Code in Übereinstimmung bringen (oder umgekehrt).

## 6. Fix-Richtungen (Optionen, bewusst NICHT als final vorgeschrieben)

- **A (bevorzugt, sauberste Provenienz):** Aggregationsregel ergänzen — jede Achse mit strukturiertem `provider_outcome ∈ {circuit_rejected, provider_error}` ⇒ **REVIEW oder schlechter**, unabhängig von `confidence`. Nutzt die strukturierte Provenienz aus der §C.3-fix. **Voraussetzung:** Auch reine Auth-/HTTP-Fehler, die heute **kein** `CircuitAllOpenError` sind, müssten eine solche Provenienz tragen — sonst greift die Regel für D6 (401) nicht. Das ist Teil des Fix-Scopes.
- **B:** `index.ts` setzt für Fail-Closed eine **eskalierende `confidence`** (≥0.7), damit Regel 4 greift. Einfacher, aber überlädt `confidence` semantisch (Unsicherheits-Höhe vs. Eskalations-Signal).

Option A ist strukturell sauberer; Option B ist die kleinere Änderung. Entscheidung Paul↔Hermes.

## 7. Betroffene Stellen

- `src/engine/index.ts` (Fail-Closed-`catch`, `provider_outcome`-Herleitung, Kommentar-Contract `:54-61`).
- `src/aggregation.ts` (Regeln 2/4, `HIGH_CONF_UNCERTAIN=0.7`, Regel-5-Fallthrough + Rationale).
- `src/aggregation.test.ts` (neuer `confidence=0`-Fall neben `:53`/`:65`).
- `src/engine/engine-provider-outcome.test.ts` (Aggregat-Assertion ergänzen, nicht nur Achsen-Verdikt).

## 8. Nächste Schritte

- Dieses Dokument ist ein **lokaler Entwurf**. Das **öffentliche** Issue anzulegen ist **Approval-pflichtig** (siehe `docs/drill/canary-calibration-v0431.md` §F).
- **Vor** `Draft→Ready` von PR #12 ist dieser Fail-Open zu adressieren (Fix + Tests) oder als bewusste, dokumentierte Politik zu bestätigen.
- Für die reine **Preview-Canary (Schritt 3)** ist er **nicht** blockierend: die Beobachtung genau solcher Provider-Fehler ist Zweck der Canary, und der Drill hat ihn als Nicht-Blocker eingestuft.
