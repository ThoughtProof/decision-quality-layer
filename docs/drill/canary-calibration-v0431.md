# Canary-Kalibrierung v0.4.3.1 — §C+integration Schritt 3

**Für:** Hermes **Von:** Paul
**Charakter:** Nicht-Produkt-Ops/Doku. **Keine** Contract-/OpenAPI-Änderung, kein Deploy, keine Prod-/Shared-Env-Änderung. Reversible Vorbereitung.
**Code-Basis (Audit-HEAD):** `0fab28c5421f42a67bbc12f635eaf2f61700a510` (PR #12, Draft, base `main`).

Dieses Dokument trennt strikt zwischen **(A) explizitem, heute im Code wirksamem Contract**, **(B) empfohlenen Startwerten** (das JSON-Artefakt — *keine* echt „kalibrierten“ Schwellen) und **(C) derzeit inerten Knöpfen**. Es korrigiert die veraltete M10-Sequenz und definiert eine konservative Beobachtungs-Rubrik samt Stop-/Rollback-Kriterien.

---

## A. Expliziter Contract — was der Code HEUTE live konsumiert

Quelle: `src/engine/production-config.ts`, verdrahtet in `src/engine/production-runtime.ts`, gespiegelt in `api/dql/health.ts`.

- **`DQL_CB_CONFIG_BY_ALIAS`** (JSON) — **live-konsumiert**. Pro Alias `serv-nano` **und** `serv-swift` je 7 Pflichtfelder:
  `tripP90LatencyMs` (>0), `tripFailureRate` ([0,1]), `cooldownMs` (≥0), `windowSize` (int 1..1000), `windowAgeMs` (>0), `minSamples` (int ≥1, ≤ windowSize), `probeMaxLatencyMs` (>0).
  - Bei `DQL_V0431_ACTIVE=1` + `pot-cli` sind **alle 7 Felder für beide Aliases verpflichtend** und explizit; leere/partielle Objekte → `CONFIG_INVALID` (Hermes H2: „Canary AN, aber Default-Werte“ ist verboten).
  - Nur bei `v0431_active=true` fließen die Werte in die echten Circuit-Breaker (`resolveCbByAlias` → `HttpLlmClient`). OFF ⇒ PR#10-Baseline (15000/0.5/30000/20/60000/5/15000) byte-identisch (Shadow-Mode).
- **Canary-Regel:** `v0431_active && pot-cli ⇒ DQL_RUNTIME_DIAGNOSTICS=1` (sonst `CONFIG_INVALID`).
- **`pot-cli`-Pflicht:** `SERV_API_KEY` gesetzt, `DQL_CAPITAL_PATH_MODE` explizit `1`/`0`, `SERV_BASE_URL` (Default `https://inference-api.openserv.ai/v1`, ohne Userinfo/Query/Fragment).
- **`config_hash`:** deterministischer SHA-256 über alle verhaltensrelevanten Felder (ohne Secrets/Build-Identität). Zum Pinnen eines Canary-Deploys geeignet.
- **`alias_gate_ready`** (nur in `api/dql/health.ts` berechnet, nicht im Resolver): Konjunktion aus
  `runtime_mode==='pot-cli' && v0431_active && capital_path_mode && !disable_circuit_breaker && diagnostics_on && commit_sha≠'' && serv_api_key_bound`.
  Kalibrierungs-/Dogfooding-Modi, die den CB bewusst abschalten, **dürfen dieses Signal nicht** verwenden (Hermes H1).

---

## B. Empfohlene Start-Canary-Werte (Artefakt) — *Empfehlung, nicht „kalibriert“*

Repo-Artefakt: **`config/canary/v0431-cb-config.json`** — direkt verbatim als `DQL_CB_CONFIG_BY_ALIAS` nutzbar.

| Feld | serv-nano | serv-swift |
|---|---|---|
| `tripP90LatencyMs` | 10000 | 15000 |
| `tripFailureRate` | 0.5 | 0.5 |
| `cooldownMs` | 30000 | 30000 |
| `windowSize` | 20 | 20 |
| `windowAgeMs` | 60000 | 60000 |
| `minSamples` | 5 | 5 |
| `probeMaxLatencyMs` | 15000 | 15000 |

> **Ehrliche Kennzeichnung:** Dies sind **konservative Startwerte** aus dem abgeschlossenen §7-Drill („full“-Profil), **keine** aus Produktionslast statistisch kalibrierten Schwellen. Sie halten das Verhalten nahe an der PR#10-Baseline (`tripFailureRate` und Fensterparameter identisch), verschärfen lediglich `tripP90LatencyMs` für `serv-nano` konservativ von 15000 auf 10000. Erst nach Auswertung der Canary-Beobachtung (Abschnitt E) dürfen sie als „kalibriert“ bezeichnet werden.

Lokale Vorab-Validierung ohne Deploy:
- Test: `src/engine/canary-config-dryrun.test.ts` (Teil der Suite).
- Skript: `npm run build && node scripts/canary-config-dryrun.mjs`.
Beide beweisen: 2 Aliases × 7 Felder, Resolver-Akzeptanz, deterministischer `config_hash`, Pflicht-Gate bei fehlender CB-Config, `alias_gate_ready`-Konjunktion.

---

## C. Derzeit INERTE Knöpfe — NICHT als Akzeptanz-Gate verwenden

Beide werden validiert, in `config_hash` aufgenommen und in `/dql/health` gespiegelt, haben aber **keinen Runtime-Konsumenten** (verifiziert: kein Ref in `runtime-diagnostics`/`cascade`/`llm-client`/`circuit-breaker`):

- **`DQL_LATENCY_CEILING_BY_ALIAS`** (`p90CeilingMs`; Defaults nano 6000 / swift 12000). Kommentar behauptet „used by RuntimeDiagnosticsCollector“ — **ist nicht verdrahtet**.
- **`DQL_REQUIRED_HEALTHY_ALIAS_FRACTION`** (Default 0.5; Legacy `DQL_REQUIRED_HEALTHY_HEADROOM`, Konflikt→Fehler). Beschreibt „Gate-2-Admission“ — **kein Konsument existiert**.

**Konsequenz:** Diese Werte zu ändern verschiebt nur den `config_hash`, nicht das Verhalten. Sie **dürfen nicht** als Canary-Akzeptanzkriterium herangezogen werden, solange sie inert sind. Entscheidung Paul↔Hermes nötig: entweder vor Produktivnutzung verdrahten (separater Schritt, Approval) oder explizit als „bewusst inert“ dokumentieren.

---

## D. Korrigierte M10-Sequenz (Code als Wahrheit)

Der PR-Body enthält eine ältere M10-Sequenz mit stale Erwartungen. Verbindlich ist:

1. **Nicht-geheimes Config-Artefakt** = `config/canary/v0431-cb-config.json` (dieses Paket). Reviewer-Signoff Hermes.
2. **Pre-Activation-Posture:** nur `CPM=true` vs. `CPM=false` sinnvoll. *„Gate-2-only“ existiert im Code nicht* (Abschnitt C) — nicht anbieten, solange inert.
3. **Env — NUR Preview, immutable, pro Szenario** (keine Prod-, keine Shared-Env):
   - `DQL_CASCADE=pot-cli`
   - `SERV_API_KEY` (Secret; niemals im Repo/Doku)
   - `DQL_CAPITAL_PATH_MODE=1`
   - `DQL_V0431_ACTIVE=1` **⇒ dann VERPFLICHTEND** `DQL_CB_CONFIG_BY_ALIAS` = Inhalt des Artefakts **und** `DQL_RUNTIME_DIAGNOSTICS=1`
   - `DQL_COMMIT_SHA` nur falls `VERCEL_GIT_COMMIT_SHA` leer ist.
4. **Immutable Preview-Deploy** von `v0431-recovery-code` (kein In-flight-Env-Toggle; `RUNTIME` wird beim Cold Start gecacht).
5. **Health-Probe** (KORRIGIERT):
   - Erwartet **`status == "ok"`** (NICHT `healthy`), `active_cascade=="pot-cli"`, `config_schema_version=="0.4.3.1-hardening-1"`, `provider_endpoint_id` gesetzt, `commit_sha` gesetzt, `config_hash` deterministisch.
   - **Zusätzliches Gate:** **`alias_gate_ready == true`** sowie `v0431_active==true`, `diagnostics_on==true`, `disable_circuit_breaker==false`, `serv_api_key_bound==true`.
6. **Sandbox-503-Test** gegen Preview: absichtlich ungültige Env (z. B. `SERV_BASE_URL` mit `?token=x`) ⇒ `/dql/verify` mit `sandbox:true` MUSS **503 CONFIG_INVALID** liefern (durch Code gedeckt: `RUNTIME.kind==='error'`).
7. **Production-Alias-Wechsel** — **nur manuell nach expliziter Freigabe** (siehe F).

---

## E. Beobachtungs-Rubrik & Stop-/Rollback-Kriterien (Empfehlung)

> Alles hier ist **Empfehlung**, keine im Code codierte SLA. Keine harten Zahlen als Contract behaupten.

**Sample-Fenster (empfohlen, konservativ):**
- Mindestens **1 Canary-Preview je Szenario-Profil**, immutable.
- Beobachtungsdauer bis **≥ `minSamples` (=5) erfolgreiche Provider-Attempts je Alias** im CB-Fenster (`windowSize=20`, `windowAgeMs=60000`), damit CB-Schwellen überhaupt greifen können.
- Empfohlene Mindestmenge für eine erste Aussage: **≥ 30–50 reale `/dql/verify`-Calls** über beide Aliases verteilt (Richtwert, nicht Contract).

**Zu beobachtende Evidenz (aus `X-DQL-Diagnostics`-Streams + Health):**
- `attempts` (ok/errorCategory, netLatencyMs, attemptCount), `transitions` (`closed_to_open`/`half_open`/…), `binding_summaries`, `stale_results`, `invalid_outcomes`.
- `config_hash` je Deploy (muss zum Artefakt passen), `alias_gate_ready==true`.

**Empfohlene Stop-/Rollback-Kriterien (Canary NICHT weiterführen / Preview verwerfen):**
- `alias_gate_ready != true` oder Health `status != ok` ⇒ Stop, Fehlkonfiguration.
- Unerwartete `closed_to_open`-Transitions unter normaler Last (nicht durch echten Provider-Ausfall erklärbar) ⇒ Schwellen zu aggressiv ⇒ Werte revidieren, neuen Preview.
- Beobachtete `provider_error`/`circuit_rejected`-Häufung ⇒ Provider-Instabilität; **kein** Prod-Alias-Wechsel.
- Jeglicher Rohfehler-/Key-Leak in Diagnostics-Feldern (G3) ⇒ sofort Stop, eskalieren.
- **Rollback ist trivial:** immutable Previews werden schlicht nicht promotet; es gibt keinen In-flight-Zustand zurückzudrehen. Kein Prod-Alias wird ohne Freigabe berührt.

**Evidenz-Artefakte (pro Szenario, analog Drill §2):** `health.json` + `health_status`, redigiertes `env-manifest.txt` (keine Secrets, nur Presence + nicht-geheime Secret-Version), `manifest.txt` (URL, Deployment-ID, SHA-Paar, `config_hash`, `provider_endpoint_id`, UTC), `request.json`, `headers`, `body.json`, `curl_exit`, `vercel-inspect.json` (4-Key). SHA-256 über den Artefaktsatz.

---

## F. Freigabepflichtige spätere Aktionen (NICHT Teil dieser Vorbereitung)

- **Draft → Ready** von PR #12.
- **Merge** nach `main`.
- **Production-Env-Änderung** (M10 Schritt 3, Prod-Teil).
- **Production-Alias-Wechsel** (M10 Schritt 7).
- **Öffentliches Issue** (z. B. D6, siehe `docs/issues/d6-auth-failure-aggregate-allow.md`).

Bindende Constraints: keine Live-Env-Toggles (nur szenario-spezifische immutable Previews), niemals einen Shared-Preview-Key überschreiben, kein `DQL_TEST_ATTEMPT_INFLATE` im Produkt-/PR-Branch.

---

## G. Status des abgeschlossenen Live-Drills (Kontext)

- Live-Drill-Run `20260713T083849Z` **PASS**, unabhängig reverifiziert gegen HEAD `0fab28c…`. Suite 301/301, `tsc` clean (Angaben aus Übergabe; die hier hinzugefügte Vorbereitung ändert keinen Contract).
- **Bewusste Grenzen des Drills:** `D3` darf `NOT_REACHED` enden (Truncation unter natürlicher Last ist unit-/mutationszertifiziert, nicht live erzwungen). Provider-SLA (P95) und **Canary-Kalibrierung** waren ausdrücklich **außerhalb** des Drill-Scopes — genau das ist dieser Schritt 3.
- **D6-Nebenbefund (Fail-Open):** ein einzelner Auth-/Provider-Fehler ergibt eine `UNCERTAIN`-Achse (confidence 0), aber das Aggregat kann `ALLOW` sein (Aggregations-Regel 4 eskaliert erst ab confidence ≥ 0.7). Details, Klassifikation und Akzeptanzkriterien: `docs/issues/d6-auth-failure-aggregate-allow.md`. **Nicht blockierend** für die Preview-Canary, **blockierend vor Draft→Ready**.
