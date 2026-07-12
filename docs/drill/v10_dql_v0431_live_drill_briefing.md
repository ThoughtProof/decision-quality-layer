# v0.4.3.1 §C+integration — Live-Drill-Briefing (v10)

**Für:** Hermes
**Von:** Paul
**Approved code base SHA:** `d7a8ff67ae5b11819ee2c5c8db4223f76f0e7a86` (`v0431-recovery-code`, PR #12) — unverändert. Nach dem Spec-Commit ist `d7a8ff6` nur noch die **Code-Basis**; deployt wird der neue Spec-Commit-HEAD (§2a).
**Ersetzt:** `v9_dql_v0431_live_drill_briefing` (Review `v9-live-drill-script-review`: NO APPROVAL — EXECUTION-HOLD. Positiv verifiziert: Datei-/Block-Identität, K7-BIND-Kern, V9-H/V9-D5/V9-S, CF16–CF20/T1–T8/CF1–CF15. Holds: **1** target-Vertrag der v13-API, **2a** Request-Vergleich offen, **2b** toleranter D5-Env-Parser, **Rest-3** unkorrelierte ok-Koexistenz, **Security** volle Owner-Inspect-Response archiviert, **Ops** `bash-env.txt`-Timing + fehlende Homebrew-Bash — ausschließlich Runner/Verifier/Ops; D1–D6, R1–R6, E1–E5, F1–F4, G1–G4 und K1–K8 bleiben geschlossen).
**Runtime-Code:** `d7a8ff6` bleibt unverändert approved — alle v9-Holds betrafen ausschließlich Runner/Verifier/Ops; **kein Code-HOLD** (Review: „Der Runtime-Code `d7a8ff6` bleibt unberührt approved“).
**OpenAPI Delta:** `v5_dql_v0431_openapi_delta` ist **APPROVED** und bleibt unverändert gültig — kein v10-Delta nötig; Spec-Patch + Tests werden gemäß §7 **nach** dem Script-Review committed und müssen vor dem Drill deployed sein.
**Ziel:** Kontrollierter Live-Drill des §C+integration-Diagnostics-Kontrakts gegen den echten Provider-Stack — nur über **erreichbare Pfade**, orientiert am tatsächlichen Wire-Verhalten von `d7a8ff6`.

---

## 0a. Revisionsprotokoll v9 → v10 (Hermes-Holds 1, 2a, 2b, Rest-3, Security, Ops)

Alle Review-Befunde wurden vor der Korrektur verifiziert — **alle treffen zu**. Hold 1 wurde **live gegen die echte v13-API** geprüft: `GET https://api.vercel.com/v13/deployments/dpl_AW1xhcTd2eqq5akqqkVUQ4Hgv2j1` (das bekannte Preview-Deployment `decision-quality-layer-datsqe0bc-…vercel.app`, Team-Scope) liefert `"target": null` bei `readyState: "READY"` — **nicht** `"preview"`. Der v9-Runner wäre an jedem echten Preview-Deployment mit `K7-BIND FAIL … target=None` abgebrochen; der v9-Vertrag war gegen eine Fantasie-Shape geschrieben. Dieselbe Live-Response bestätigt den Security-Befund: 49 Top-Level-Keys, darunter `env` und `build.env` mit je 107 Einträgen Projekt-Env-**Namen** — das v9-Verhalten (volle Response archivieren + hashen) hätte diese Owner-Sicht dauerhaft ins Beweis-Artefakt kopiert.

**Vertragsänderungen (explizit als solche geflaggt):**
1. **`vercel-inspect.json` ist nicht mehr die volle API-Response**, sondern ein reduziertes, **geschlossenes 4-Key-Artefakt** `{id, url, target, readyState}` (`json.dump` mit `sort_keys`). Die volle Owner-Response wird pro Szenario nur in ein `umask-077`-Tempfile geschrieben, geparst und **in jedem Pfad gelöscht** — auch bei curl-Fehler, Parse-Fehler und K7-BIND-FAIL (CF21b). Artefakt-Anzahl bleibt neun, S3/H1 unverändert.
2. **`request.json` ist jetzt byte-vertraglich:** §4 normiert je Szenario exakt eine Payload (drei Varianten: SMALL, SANDBOX, FIVE_AXES); der Verifier vergleicht byte-identisch gegen diese Konstanten (V10-R). Die alten semantischen Checks (Achsen, `sandbox` — V9-R) bleiben als Zweitlinie bestehen.
3. **`bash-env.txt` wird beim Anlegen des Run-Ordners geschrieben** — vor Preflight, K7 und jedem Netzwerk-Call — und existiert damit auch bei jedem Abbruch (CF26a/b). Es bleibt bewusst Ops-Beleg außerhalb der Hash-Deckung (kein Wire-Artefakt).

| Hold | Befund (verifiziert) | Korrektur in v10 |
|---|---|---|
| 1 (v13-target) | v9 erzwang `target == "preview"`; die echte v13-API repräsentiert Preview als `target: null` (Live-Beleg oben). Jeder echte Preview-Run wäre gefailt; ein Verifier, der auf `"preview"` matcht, hätte zudem nie ein echtes Artefakt akzeptiert | Runner-K7-BIND: `"target" not in ins` → FAIL („Feld 'target' fehlt … Preview-Status nicht beweisbar“); `ins["target"] is not None` → FAIL mit zitiertem Wert und v13-Vertragshinweis. Verifier V10-K7: `target === null` erzwungen, `"preview"` ist jetzt selbst ein FAIL-Wert (CF25b). CF16-Shapes der Suite auf `"target":null` umgestellt; CF16c (`production`) und neu CF21a (Feld fehlt)/CF21b (`staging`) beweisen die Schließung |
| 2a (Request offen) | `checkRequest` prüfte nur `axes` + `sandbox` — `mandate`/`proposed_action`/`reasoning` frei tauschbar bei Exit 0 (Review-Mutation reproduziert) | Geschlossener Vergleich: `request.json` muss **byte-identisch** zur normierten Szenario-Payload sein (`V10-R … — X Bytes, erwartet Y Bytes`). CF22a beweist: getauschter Stimulus mit korrekten `axes`/`sandbox` failt jetzt, und zwar **ohne** dass ein alter V9-R-Check anschlägt (nolog-Gegenprobe) |
| 2b (D5-Parser) | Offline-Parser übersprang malformte Zeilen und ließ Duplicate Keys per last-wins durch; Secret-Suffix-Sperre existierte nur im Runner (SM-R4), nicht offline | `parseEnvStrict` im Verifier spiegelt den Runner-G4-Parser: exakt `KEY=VALUE`, Key-Regex `^[A-Z_][A-Z0-9_]*$`, Duplicate = FAIL, Secret-Suffix (`*_KEY`/`*_SECRET`/`*_TOKEN`/`*_PASSWORD`) = FAIL, `SERV_API_KEY_BOUND=true` Pflicht (V10-D5/G4, V10-D5/E4). CF23a/a2/b/c + Kontrolle CF23d |
| Rest-3 (Koexistenz) | E5/F4 verlangten nur *irgendein* ok-Attempt und *irgendeine* ok-Summary — ein ok-Attempt von Call A plus ok-Summary von Call B passierte | `hasCorrelatedSuccessfulBinding`: ok-Attempt und ok-Summary müssen über **identische** `callId`/`axis`/`requestId`/`requestedAlias`/`route` korreliert sein — in D2, D2b, D5-control **und** D5-disabled („Koexistenz allein ist kein Erfolg“, V10-E5/V10-F4). CF24a/b |
| Security | v9 archivierte + hashte die **volle** Owner-Inspect-Response (49 Keys, 107 Env-Namen) als Beweis-Artefakt | Reduziertes 4-Key-Artefakt (Vertragsänderung 1 oben); Verifier erzwingt das **geschlossene Key-Set** — jeder Zusatz-Key (z. B. `env`) ist FAIL (V10-K7, CF25a); kein Raw-Tempfile überlebt irgendeinen Pfad (CF21r/CF21b) |
| Ops | `bash-env.txt` entstand erst **nach** erfolgreichem Verifier-Lauf — bei jedem Abbruch fehlte genau der Beleg, den der Ops-HOLD fordert; `/opt/homebrew/bin/bash` fehlt weiterhin auf dem Ops-Mac | Schreibzeitpunkt an den Run-Start verlegt (Vertragsänderung 3 oben; CF26a/b). Die Homebrew-Bash-Installation bleibt offener Ops-Schritt (Paul, §7) — der positive Lauf unter Bash ≥ 4 bis hinter das korrigierte K7-BIND steht weiterhin aus und ist Freigabebedingung des Reviews |

**Steelman-Pass (v10, vor Abgabe ausgeführt):** (1) „Was passiert, wenn das eigene Tooling failt?“ — Raw-Inspect-Tempfile wird auch auf curl-Fehler- und Parse-Fehler-Pfaden gelöscht (nicht nur im Erfolgsfall); `bash-env.txt` überlebt jeden Abbruch; Verifier-Verdict-Schreibfehler bleibt selbst FAIL (K1). (2) „Welche Schemata sind offen statt geschlossen?“ — `request.json` jetzt byte-geschlossen, `vercel-inspect.json` key-geschlossen, Env-Manifeste offline strikt geparst; ehrlich offen bleiben: `bash-env.txt` (bewusst außerhalb der Hash-Deckung, Ops-Beleg), der D3-`NOT_REACHED`-Vorbehalt (H3) und die bekannte Offline-Grenze, dass ein komplett konsistent neu erzeugter Run-Ordner nur durch externe Bindung widerlegbar ist (§7, unverändert). (3) „Was ist nur syntaktisch statt operativ bewiesen?“ — der v13-`target:null`-Vertrag ist **operativ** gegen die echte API belegt (Live-Response oben, heutiges Datum im Run-Log); operativ **unbewiesen** bleibt der Positivlauf des Runners auf dem Ops-Mac unter Bash ≥ 4 — er ist explizit als offene Freigabebedingung in §7 geführt, nicht stillschweigend als erledigt markiert.

## 0b. Revisionsprotokoll v8 → v9 (Hermes-HOLD 1–4 + Ops-HOLD + Steelman-Pass)

Alle vier Holds wurden vor der Korrektur gegen die materialisierten v8-Dateien bzw. den `d7a8ff6`-Code verifiziert — **alle vier treffen zu** (Hold 3 inklusive Code-Beleg: `src/engine/index.ts` erzeugt im live erreichbaren Pfad **immer** einen nichtleeren `callId` und reicht denselben Kontext an Attempt und Summary — Absenz ist dort keine zulässige Variante, sondern eine Provenienzverletzung). Alle sechs Freigabebedingungen des Reviews sind ausgeführt; die Codeblöcke in §5 sind erneut byte-identisch aus den Dateien generiert.

**Vertragsänderung (explizit als solche geflaggt):** Der Artefakt-Satz pro Szenario wächst von **acht auf neun** Dateien — neu ist `vercel-inspect.json`, die archivierte Vercel-API-Response der K7-BIND-Prüfung (Hold 1). `sha256.txt` muss exakt diese neun listen (S3 sinngemäß fortgeschrieben; frische Gegenprobe: zehnter Eintrag `extra-notes.txt` → FAIL „Vertrag: exakt die neun Artefakte“). Alle H1-/S3-Formulierungen in §2/§6 sind nachgezogen. Zweite Vertragsänderung: der Offline-Verifier hat einen neuen **Pflicht-Input** `EXPECTED_DEPLOYED_SHA` (Hold 2) — fehlt er, bricht der Verifier mit `FATAL V9-H` ab, statt die SHA-Bindung stillschweigend nicht zu prüfen; der Runner hat die neue Pflicht-Env `VERCEL_TOKEN` (read-only reicht) für die Inspect-Calls.

| Hold | Befund (gegen v8 verifiziert) | Korrektur in v9 |
|---|---|---|
| 1 (K7) | K7 akzeptierte jeden `https://*.vercel.app`-Host ohne `-git-` — auch den **mutablen Projekt-Alias**; die `*_DEPLOY_ID` wurde nur auf non-empty + Eindeutigkeit geprüft, **nie gegen die URL gebunden**; URLs mit Credentials/Pfad/Query/Fragment/Port passierten | **K7-BIND** im Runner, pro Szenario **vor** Health und POST: `GET https://api.vercel.com/v13/deployments/<*_DEPLOY_ID>`, dann erzwungen `inspect.id == *_DEPLOY_ID`, `inspect.url == URL-Host`, `target == preview`, `readyState == READY`; Response archiviert + gehasht als `vercel-inspect.json`. Zusätzlich URL-Schließung im K7-Preflight: keine Credentials, kein Pfad (nur ''/'/'), keine Query, kein Fragment, kein Nichtstandard-Port; Dedup-Key ist der Host. Der Verifier bindet das Artefakt offline erneut gegen `manifest.txt` (V9-K7). CF16a–f/CF20 (§5c) |
| 2 (Verifier) | Der Offline-Verifier prüfte von der Deploy-/Preflight-Beweiskette nur `health_status`: getauschtes `request.json`, `runtime_mode=stub` + falscher SHA in `health.json`, mutierter `manifest.txt` — jeweils **Exit 0**. Die Hashliste beweist nur Selbstkonsistenz der aktuellen Bytes | Der Verifier rechnet die archivierten Eingaben **semantisch nach**: volle §3a-Health-Matrix je Szenario inkl. `health_status` (V9-H); `manifest.txt` mit geschlossenem Key-Set, `deployed_sha`/`commit_sha` gegen den neuen Pflicht-Input `EXPECTED_DEPLOYED_SHA`, Fingerprint-Kreuzcheck Manifest↔Health (V9-H/SM-V2); `request.json` pro Szenario (Payload, Achsen, `sandbox` — V9-R); D5-Paar: `request.json` byte-identisch + Env-Manifeste offline erneut strikt verglichen (V9-D5); `vercel-inspect.json` gegen Manifest (V9-K7). Alle drei Review-Mutationen enden non-zero (CF17a/b/b2, §5c). **Ehrliche Grenze bleibt:** ein Angreifer, der den kompletten Run-Ordner konsistent neu erzeugt, ist offline nicht widerlegbar — die externe Bindung (Signatur/Commitment des Run-Manifests) bleibt als Ops-Option in §7 dokumentiert, der Verifier beweist Konsistenz **gegen die expliziten Inputs** `EXPECTED_DEPLOYED_SHA`/`D6_FORBIDDEN_TOKEN` |
| 3 (K5) | Der D5-Korrelator akzeptierte fehlende `callId` (Absenz-Toleranz: `!('callId' in a)` als Oder-Zweig) — Attempt ohne `callId` bei Summary mit `callId`: **Exit 0** | Auf allen Live-Provider-Pfaden (D2/D2b/D3/D5-Paar/D6) sind `callId` (nichtleerer String) und `axis ∈ request.axes` jetzt **Pflicht** jedes Attempts und jeder Summary (V9-K5). Der D5-Korrelator verlangt den vollen Binding-Kontext ohne Absenz-Toleranz: `b.callId === a.callId && b.axis === a.axis && b.requestId === a.requestId && b.requestedAlias === a.requestedAlias && b.route === a.route`. Gegenprobe „Attempt-`callId` fehlt“ → FAIL (CF18a–c, §5c) |
| 4 (Status) | D6 verlangte keinen **parsebaren** Status: `HTTP/WUT 200` → `status=NaN`, alle `status===`-Checks liefen leer → **Exit 0** | Global nach dem Status-Parse, für jedes Szenario: `Number.isInteger(status) && 100 <= status <= 599`, sonst FAIL `V9-S` (Statuszeile wird zitiert). D6 akzeptiert weiterhin jeden **validen** Status (S4 unverändert). CF19a/b (§5c) |
| Ops | `/bin/bash` = 3.2.57, `/opt/homebrew/bin/bash` = fehlt — der K8-Positivpfad war auf dem Ops-Mac nicht ausführbar | §7 Schritt 7 erweitert: Homebrew-Bash installieren/pinnen, Runner mit exakt diesem Pfad mindestens bis hinter K7 ausführen, **Pfad + `bash --version` als Run-Artefakt sichern** — der Runner schreibt dazu `bash-env.txt` in den Run-Ordner (bewusst außerhalb der Hash-Deckung: entsteht nach dem Verifier-Lauf, Ops-Beleg, kein Wire-Artefakt) |

**Steelman-Pass (v8.1, vor Eingang des v8-Reviews ausgeführt):** Nach dem festgezurrten Workflow („Was passiert, wenn das eigene Tooling failt? Welche Schemata sind offen statt geschlossen? Was ist nur syntaktisch statt operativ bewiesen?“) wurden acht Punkte selbst gefunden und gefixt — **SM-R1** Tool-Preflight (`curl`/`python3`/`node`/`sha256sum` fehlt → `FATAL SM-R1`, Exit 2, vor jedem Netzwerk-Call), **SM-R2** `mkdir` ohne `-p` (Timestamp-Kollision = Abbruch statt stiller Wiederverwendung), **SM-R3** `--max-time` auf jedem `curl` (30 s Health/Inspect, 300 s Verify-POST — hängender Call ist `INFRA_FAIL`, kein ewiger Block), **SM-R4** Secret-Suffix-Sperre im Env-Manifest-Parser (`*_KEY`/`*_SECRET`/`*_TOKEN`/`*_PASSWORD` nur als `*_BOUND`/`*_SECRET_VERSION` — Klartext-Secret im redigierten Manifest ist FAIL), **SM-V1** Verifier-Argument-Guard (`FATAL SM-V1` statt roher Stacktrace), **SM-V2** Manifest-Kreuzcheck (geschlossenes 7-Key-Set, `base_code_sha` gegen die approved Code-Basis, `deployed_sha == health.commit_sha`, Fingerprint-Gleichheit Manifest↔Health, Deployment-ID-Eindeutigkeit offline), **SM-V3** geschlossener 200-Body (`DqlResponse`-Top-Level exakt, `meta.sandbox == request.sandbox`, `meta.axes_evaluated == request.axes`), **SM-V4** D4-503-Body top-level geschlossen (exakt `{error, code, reasons}`). Counter-Fixtures CF11–CF15: 26 Checks grün (§5b). **Überschneidung mit dem Review, ehrlich benannt:** SM-V2/SM-V3 decken die Manifest- und Body-Teilaspekte von HOLD 2 — die Health-Matrix, `request.json`, das D5-Paar offline und der explizite `EXPECTED_DEPLOYED_SHA`-Input kamen erst mit dem Review dazu (V9-*). Die Steelman-Fixes waren notwendig, aber nicht hinreichend.

## 0c. Revisionsprotokoll v7 → v8 (K1–K8 + S1–S4, Re-Review-Paket ausgeführt)

Alle acht K-Punkte wurden vor der Korrektur gegen die materialisierten v7-Dateien bzw. den `d7a8ff6`-Code verifiziert — **alle acht treffen zu**. Das im Review geforderte Re-Review-Paket ist vollständig ausgeführt: Counter-Fixtures CF1–CF10 (31 Checks, jede FAIL-Meldung wörtlich verifiziert) **plus** T1–T8-Regression (16 Checks) — alle grün (§5a). Die Codeblöcke in §5 sind erneut aus den Dateien generiert.

| Punkt | Korrektur in v8 |
|---|---|
| K1 | Verdict-Write **atomar** (tmp + `renameSync`) und ein Schreibfehler ist selbst FAIL: `failures++` + Meldung + non-zero Exit. Vorher schluckte `try/catch` den Fehler — Exit 0 ohne `verifier-verdict.txt` war möglich, obwohl „Exit 0 + Verdict-Datei“ Bestandteil von Drill-PASS ist (§5, CF1) |
| K2 | Snapshot **top-level geschlossen**: exakt `requestId` + die fünf Streams (`flush()`-Vertrag aus `runtime-diagnostics.ts`); jeder Stream-Wrapper exakt `{items, dropped}`. Ein freies Zusatzfeld (z. B. `debugText`) ist FAIL — vorher deckten die geschlossenen Schemata nur die **Items**, nicht Snapshot-Top-Level/Wrapper. Rekursiver Forbidden-Key-/Marker-Scan bleibt als Defense-in-Depth (§5, CF2/CF3) |
| K3 | Header-Präsenz = **Key existiert** (Map-`has()`), nicht Truthiness: ein präsenter, leerer Vertragsheader ist FAIL statt „absent“; Truncated/Counts-Paarung läuft über Präsenz; `noDiag` heißt Abwesenheit aller drei Diagnostics-Header (§5, CF4) |
| K4 | Header-**Multimap** statt `Object.fromEntries` (kollabierte Duplikate stillschweigend aufs letzte Vorkommen): die fünf Singleton-Vertragsheader (`X-Request-Id`, `X-DQL-Version`, drei `X-DQL-Diagnostics*`) mehrfach im Block → FAIL, auch bei identischem Wert (§5, CF5) |
| K5 | Korrelation statt Koexistenz: **jede** `attempts`-/`binding_summaries`-Item-`requestId` muss `snapshot.requestId` gleichen (Provenienz: `llm-client.ts` setzt `requestId` aus `ctx`, `collector.requestId === ctx.requestId` ist Client-Invariante). D5-Latenz-Trip: `closed_to_open.alias` muss `attemptAlias` eines ok-Attempts **und** einer ok-Summary sein; tragen beide `callId`, muss sie übereinstimmen (§4 D5, §5, CF6/CF7) |
| K6 | D4-`reasons` werden **inhaltlich** geprüft — im Runner-Preflight (vor dem POST) und im Verifier (Body): jede Reason muss die engen Tokens `serv-swift` **und** `minSamples` tragen, `reasons` nicht leer. Kein stabiler Per-Reason-Code im Ist-Vertrag → Token- statt Prosa-Vergleich. Ein 503 aus einer **anderen** Config-Ursache oder mit Zusatz-Reasons ist FAIL — der Claim ist „exakt dieser Defekt“ (§4 D4, §5, CF8/CF8b) |
| K7 | **Vor jedem Netzwerk-Call:** alle zehn normalisierten URLs eindeutig (Host+Pfad), `https`, Host endet auf `.vercel.app`, kein mutabler `-git-`-Branch-Alias; neue Pflicht-Envs `*_DEPLOY_ID` (zehn, eindeutig, non-empty) — die Vercel-Deployment-ID wird pro Szenario in `manifest.txt` archiviert (§2/P2). URL-Reuse (z. B. D2=D3, identische Health-Profile) fiel vorher niemandem auf (§5, CF9) |
| K8 | Laufzeit-Guard direkt nach `set -euo pipefail`: `(( BASH_VERSINFO[0] >= 4 ))` sonst `FATAL K8` + Exit 2 — Apple-Bash 3.2.57 scheitert sonst mitten im Script an `declare -A` („D0_stub: unbound variable“); `bash -n` beweist keine Runnability. Kopfkommentar nennt den gepinnten Pfad (`/opt/homebrew/bin/bash`). Negativtest unter Bash 3.2 ist remote nicht beweisbar → operativer Schritt auf dem Ops-Mac (§7, CF10) |
| S1 | `manifest.txt` trägt jetzt `deployment_id`, `config_hash` und `provider_endpoint_id` (aus `health.json`, hash-gedeckt); der Preflight verlangt beide Fingerprint-Felder non-empty für alle non-D4-Szenarien (der D4-503-Body trägt sie nicht). **Ehrlich benannt:** `config_hash` ist lokal nicht nachrechenbar — die Bindung ist deploy-seitig; Env-Manifeste MÜSSEN aus der Deployment-Automation stammen, nicht handgepflegt sein (§2) |
| S2 | Alle Szenario-Health-Erwartungen auf den **vollen deterministischen Feldsatz** erweitert (`service`, `active_cascade`, `capital_path_mode`, `disable_circuit_breaker`, `serv_api_key_bound`, …). Bewusst **nicht** asserted: `version`, `config_schema_version`, `commit_sha` (separat gegen `EXPECTED_DEPLOYED_SHA`), `config_hash`/`provider_endpoint_id` (S1: Präsenz), `required_healthy_alias_fraction`, `timestamp`. D0 pinnt `v0431_active`/`diagnostics_on` **nicht** — Defaults sind nicht Teil des D0-Manifest-Vertrags (§3a, §5) |
| S3 | `sha256.txt` muss **exakt** die acht Artefakte listen: Duplikat-Einträge und Nicht-Artefakt-Einträge → FAIL (vorher nur „alle acht enthalten“) (§5) |
| S4 | D6-HTTP-Status bleibt bewusst **kein** Kriterium (kann 200 mit `UNCERTAIN`-Achsen sein) — vom Review explizit als Nicht-Blocker bestätigt, unverändert (§4 D6) |

## 0d. Revisionsprotokoll v6 → v7 (G1–G4 + Härtung, Execution-HOLD aufgelöst)

Alle vier G-Punkte wurden vor der Korrektur gegen den `d7a8ff6`-Code verifiziert — alle vier treffen zu. G1 war ein eigener Verifier-Fehler: der v6-Verifier prüfte einen **flachen** Counts-Shape (`<stream>_retained`/`<stream>_dropped`), den der Code nie emittiert hat. Runner und Verifier existieren jetzt als **echte, ausgeführte Dateien** (Review-§5.2); die Codeblöcke in §5 sind aus diesen Dateien generiert, nicht abgetippt.

| Punkt | Korrektur in v7 |
|---|---|
| G1 | Counts-Prüfung auf den **echten nested Wire-Shape** aus `verify.ts` umgestellt: Top-Level exakt die fünf Streams + `dropped`; `dropped` exakt dieselben fünf Stream-Keys; jeder Wert `Number.isInteger(x) && x >= 0`; unbekannte/fehlende Keys → FAIL. Zusätzlich: `X-DQL-Diagnostics-Truncated` muss exakt `'1'` sein. Der v6-Verifier hätte jeden echten Truncation-Lauf als FAIL gewertet und einen flachen (nie existierenden) Shape als PASS (§5) |
| G2 | Fehlende Assertions nachgezogen: D2c verlangt `status === 200`; D5-control/-disabled verlangen das volle E5-Bündel (`200` + `models_used >= 1` + ok-Attempt + ok-Summary); D4 prüft `typeof body.error === 'string'`; `body.id === X-Request-Id` gilt jetzt für **alle** 200-Antworten (nicht nur bei vorhandenem Snapshot). Alle Stream-Items laufen durch **geschlossene Schemata**: exakte Key-Mengen, `route ∈ {primary,fallback}`, `iteration >= 1` (Integer), `ok` boolesch, Latenzfelder numerisch, Transition-/Stale-/Invalid-Events mit kind-spezifischen Pflichtfeldern und Enum-`reason`; `ok===true` ⇒ `errorCategory` **absent** (§5) |
| G3 | No-Leak ist jetzt beweisbar statt heuristisch: der D6-Test-Key trägt einen eindeutigen, nicht-produktiven **Marker** (`D6_KEY_MARKER`), der dem Verifier separat als `D6_FORBIDDEN_TOKEN` übergeben wird (nie im redigierten Manifest — der Runner grept das archivierte Manifest dagegen); fehlt der Token, endet der Verifier mit FAIL („No-Leak nicht beweisbar“). Zusätzlich: strukturelle Allowlist-Schemata für alle Streams, rekursiver Scan des gesamten Snapshots auf freie Fehlertext-Keys (`error`, `message`, `details`, `response`, `body`, `stack`) und eine erweiterbare Provider-Marker-Liste (`Unauthorized`, `invalid api`, `invalid_api_key`, …) statt einem einzelnen `/Unauthorized/i` (§4 D6, §5) |
| G4 | `check_env_manifest()` prüft **strukturierte Szenarioprofile** statt Einzelkeys: vollständige Pflicht-Key-Enumeration, `SERV_API_KEY_SECRET_VERSION`-Präsenz, KEY-Format-Regex (`^[A-Z_][A-Z0-9_]*$`), und `DQL_CB_CONFIG_BY_ALIAS` wird **als JSON geparst** — beide Aliases Pflicht, alle 7 CB-Felder numerisch, unbekannte Aliases/Keys FAIL. D5-Profile verlangen `minSamples === 1` und `tripP90LatencyMs === 1` für **beide** Aliases (`cb.mode=aggressive`); das D4-Profil macht den Defekt maschinenprüfbar (`cb.mode=defect`: `minSamples` fehlt exakt in `serv-swift`, ist er gesetzt → FAIL). Ein D5-Deploy mit lascher CB-Config oder ein D4-Deploy ohne den Defekt fällt jetzt vor dem POST auf (§5) |
| H1 (Härtung) | Der Verifier verifiziert `sha256.txt` selbst (Node `crypto`): alle acht Artefakte müssen gelistet sein und hashen — ein nach dem Hashen verändertes Artefakt ist FAIL, nicht nur theoretisch prüfbar (§5) |
| H2 (Härtung) | Genau **ein** HTTP-Headerblock pro `headers`-Datei: Redirect-/100-Continue-Zwischenantworten (mehrere `HTTP/`-Blöcke) → FAIL; der Runner sendet POSTs mit `-H 'Expect:'`, um 100-Continue zu unterdrücken (§5) |
| H3 (Härtung) | D3-`NOT_REACHED` ist maschinenlesbar: der Verifier schreibt `verifier-verdict.txt` in den Run-Root (bewusst **kein** Szenario-Artefakt, kollidiert nicht mit `sha256.txt`) mit per-Szenario-Verdict (`PASS`/`PASS_NOT_REACHED`/`FAIL`) und `NOTE D3_natural_load=NOT_REACHED` (§5) |

## 0e. Revisionsprotokoll v5 → v6 (F1–F4, Runner-HOLD aufgelöst)

| Restpunkt | Korrektur in v6 |
|---|---|
| F1 | Der Health-HTTP-Status wird **atomar mit dem Body** erfasst (`curl -w '%{http_code}'`), als eigene Artefaktdatei `health_status` archiviert, gehasht und im ausführbaren Preflight geprüft: D4 verlangt `503`, alle anderen Szenarien `200`. Vorher prüfte der Preflight nur Body-Felder — ein Proxy/CDN könnte einen JSON-Body mit falschem Status liefern und wäre akzeptiert worden (§3a, §5) |
| F2 | Der D5-Paar-Vergleich beweist jetzt auch die **Schalterwerte selbst**: ein strikter Parser (Duplicate Keys verboten) verlangt genau eine `DQL_DISABLE_CIRCUIT_BREAKER`-Zeile je Manifest mit exakt `0` (control) bzw. `1` (disabled), plus `SERV_API_KEY_BOUND=true` und identische `SERV_API_KEY_SECRET_VERSION` auf beiden. Der alte `grep -v`-Diff entfernte die einzige erlaubte Differenz vor dem Vergleich — zwei Manifeste **ohne** Disable-Key hätten bestanden (§2b, §5) |
| F3 | `do_call()` erhält pro Szenario den Pfad zum **redigierten Env-Manifest**: Parser-Validierung (KEY=VALUE, keine Duplikate, kein Klartext-Secret), Abgleich der DQL-Schalter gegen die Szenarioerwartung, Archivierung als `env-manifest.txt` **im Szenario-Ordner** und Aufnahme in `sha256.txt`. Vorher entstand nur ein Run-Manifest (url/SHA/UTC); die D5-Manifeste lagen als Root-Dateien außerhalb der Szenario-Ordner und ohne Hash (§2, §5) |
| F4 | `verify-drill-headers.mjs` ist jetzt ein **Verifier statt eines Loggers**: alle §4-/§6-Assertions sind ausführbarer Code mit non-zero Exit bei jeder Vertragsabweichung — HTTP-Status Health+Verify, Header-Präsenz/paarweise Exklusivität, JSON-Parsing + 8-KiB-Grenze, Request-ID-Gleichheit, fünf Streams + dropped, echte E5-Success-Kriterien, D2c exakt leer, D4 `reasons[]`, D5-control Latenz-Trip aus erfolgreichem Call, D5-disabled Provider-Erfolg + null Transitions, D6 `client_4xx` + No-Leak, `curl_exit==0`. Nur bekannte Szenario-Verzeichnisse werden akzeptiert (§5) |
| §4 (Review) | Deploy-Modell konsistent gemacht: D2c und D3 laufen **nicht mehr** gegen die D2-URL, sondern bekommen eigene immutable Deploys (`D2C_URL`, `D3_URL`) mit eigenem Env-Manifest — identisches Env-Profil, aber getrennte Deployments. Damit gilt „jedes Szenario ein eigener Deploy“ wieder wörtlich, und D3 startet nicht mit Breaker-/Isolat-Zustand, den D2 hinterlassen hat (§2, §5) |

## 0f. Revisionsprotokoll v4 → v5 (E1–E5, Execution-HOLD aufgelöst)

| Restpunkt | Korrektur in v5 |
|---|---|
| E1 | Der Runner führt den semantischen Health-Preflight jetzt **ausführbar vor jedem POST** aus: `preflight()` prüft die §3a-Felder (`status`, `commit_sha`, `runtime_mode`, `v0431_active`, `diagnostics_on`, `capital_path_mode`, `disable_circuit_breaker`, `serv_api_key_bound`, `alias_gate_ready`) szenariospezifisch und bricht bei Abweichung non-zero ab — ein Kommentar im späteren Offline-Verifier erfüllt das Gate nicht. D4 hat eine eigene 503/`config_invalid`-Regel (§5) |
| E2 | D4 ist **nicht mehr** von der SHA-Prüfung ausgenommen — auch der absichtlich config-invalid Health-503 trägt `commit_sha` im Body (`api/dql/health.ts`); die Ausnahme öffnete eine Attribution-Lücke genau dort, wo der kaputte Env-Zustand die Interpretation ohnehin erschwert (§5) |
| E3 | **Keine Verify-POST-Sonde** vor dem evidentiary Call auf dem D5-Paar: bei `minSamples=1`/`tripP90LatencyMs=1` würde die Sonde den Breaker im warmen Isolat vor dem Drill-Call öffnen (Admission-Reject statt Transition). Config-Gültigkeit läuft ausschließlich über `/dql/health` (separate Function, berührt den Verify-Breaker nicht); der evidentiary D5-POST muss der **erste** absichtliche `/dql/verify`-Call auf dem frischen Deployment sein (P4, §4 D5) |
| E4 | D5-Paar braucht einen **maschinenlesbaren Gleichheitsbeweis**: redigierte Env-Manifeste beider Deploys werden vor dem Call automatisch gedifft — zulässige Differenz ausschließlich `DQL_DISABLE_CIRCUIT_BREAKER`; Payload byte-identisch, Spec-SHA identisch, Key-Präsenz/Secret-Version gleich. `config_hash` differiert erwartungsgemäß und ist **kein** Gleichheitsbeweis (§2b, §5) |
| E5 | Success-Path verlangt **echten Erfolg**: D2/D2b zusätzlich `HTTP 200` + `meta.models_used.length >= 1` + mindestens ein `attempts[i].ok === true` + mindestens eine `binding_summaries[i].ok === true` — `attempts>=1`/`summaries>=1` allein wird auch bei Provider-401/Netz-/Parse-Fehler grün. D5-control zusätzlich `attempt.ok===true` + `summary.ok===true` + `closed_to_open.reason==='latency'` — ein Failure-Rate-Trip gilt nicht als Beleg für den Latenzpfad (§4, §5, §6) |
| §4 (Review) | Runner-Struktur pro Szenario ausführbar erzwungen: Health → SHA (immer) → Health-Assertions → Manifest-Validierung → D5-Paar-Diff → genau ein evidentiary POST → Offline-Verify → Hashes. `curl ... \|\| true` entfällt; Curl-Exitcode wird separat gesichert — Transportfehler ist `INFRA_FAIL`, kein Wire-Ergebnis (§5) |

## 0g. Revisionsprotokoll v3 → v4 (R1, R2, R6 + Preflight/Manifest)

| Restpunkt | Korrektur in v4 |
|---|---|
| R1 | Basis-Env ergänzt um `DQL_CAPITAL_PATH_MODE=1` — jede `pot-cli`-Runtime verlangt den Wert **explizit** (kein Default); ohne ihn antwortet jeder ON-Deploy `503 CONFIG_INVALID`. `DQL_MODEL_MAP` gestrichen: der geprüfte `d7a8ff6`-Runtimepfad liest die Variable nicht (`resolveModelBindings()` baut die Aliases aus der resolved config) — toter Env-Eintrag suggeriert nicht wirksame Konfiguration (§4, P3/P4) |
| R2 | D5 als **gepaarte Gegenprobe**: D5-control (CB aktiv, absichtlich aggressive Config `minSamples=1`, `tripP90LatencyMs=1` → `closed_to_open` wegen Latenz erwartet) vs. D5-disabled (identische Config/Payload + `DQL_DISABLE_CIRCUIT_BREAKER=1` → `transitions===0`). Nur der ON/OFF-Kontrast beweist, dass die Transition wegen des Disable-Schalters verschwindet; beide Health-Antworten werden archiviert (§4 D5) |
| R6 | D3-Payload auf fünf Achsen mit **kurzem realistischem Payload** — 19 000-Zeichen-Felder erhöhen die Snapshot-Größe nicht (Requesttexte stehen nicht im Snapshot), sondern nur Tokenlast/Latenz/Kosten. Einzige organische Overflow-Quelle: Retries/Fallbacks/Events (§4 D3) |
| §3 | Preflight pro Szenario **semantisch**: `/dql/health`-Felder gegen Erwartungswerte prüfen und archivieren statt nur `status:"ok"` (§3a) |
| §4 | Manifest/Runner: kein hardcodiertes `sha=d7a8ff6...` mehr — `base_code_sha` + `deployed_sha` (aus `/dql/health.commit_sha`) getrennt festhalten; P1 auf Spec-Commit-HEAD umformuliert (§2a, §5) |
| R3 (Delta) | D1-Laufzeitassertion erzwingt kein `{1,6}`-Regex mehr — nur `startsWith('dql_')` + Gleichheit mit Body/Snapshot (Generator kann bei `Math.random()===0` leeren Suffix erzeugen) |

## 0h. Revisionsprotokoll v2 → v3 (D1–D6, geschlossen) + festgezurrte Entscheidungen

| Blocker | Korrektur in v3 |
|---|---|
| D1 | Baseline verlangt **beide** Flags explizit OFF (`ACTIVE=0`, `DIAGNOSTICS=0`) + `DQL_CASCADE=pot-cli` explizit gesetzt |
| D2 | Payload auf `sandbox: false` — Sandbox durchläuft den `SandboxCascade`, der `HttpLlmClient` wird nie aufgerufen, Attempts/Summaries wären unerreichbar |
| D3 | Feldlängen ≤ 20 000 (reales Validator-Limit; 40 000er-Payload → `400 INVALID_REQUEST`); kein Attempt-Inflator; `NOT_REACHED` erlaubt und ehrlich dokumentiert |
| D4 | Config-invalid 503 hat **keinen** Diagnostics-Header (kein Collector bei `RUNTIME.kind==='error'`); Erwartung auf `reasons[]`-Wire umgestellt; beweist nicht H4-populated |
| D5 | Schalter ist global `DQL_DISABLE_CIRCUIT_BREAKER=1` (kein alias-lokales `disableCircuitBreaker` — würde als unbekannter Key abgewiesen); Assertions verschärft; beweist nicht H1 |
| D6 | Eigener Preview-Deploy mit absichtlich ungültigem Testkey; niemals Shared-Key-Toggle; HTTP-Status kann 200 mit `UNCERTAIN`-Achsen bleiben |

**Entscheidungen aus dem Review (§D), hiermit festgezurrt:**

1. **Kein `DQL_TEST_ATTEMPT_INFLATE`** im Produkt-/PR-Branch. D3 bleibt Realo-Path; `NOT_REACHED` ist akzeptabel. Der Overflow-Wire-Serializer ist bereits durch den diskriminierenden 261. Test inkl. Löschmutation zertifiziert. Optional: separater, **niemals zu mergender** Test-Harness-Deploy für den Vercel-Headertransport — klar als synthetischer Transporttest gelabelt, nicht als Real-Provider-Beweis.
2. **D4/D6 (und alle Szenarien) laufen als eigene immutable Preview-Deploys**, keine in-flight-Toggles (Begründung §2). *(Seit v6 gilt das wörtlich auch für D2c/D3 — eigene URLs statt Wiederverwendung des D2-Deploys.)*
3. **D5 asserted zwingend `transitions.items.length === 0`** zusätzlich zu `attempts.items.length >= 1` und `binding_summaries.items.length >= 1`. *(Präzisiert in v4 durch R2: diese Kombination allein beweist nur Provider-I/O ohne beobachtete Transition; der Bypass-Nachweis braucht die gepaarte Gegenprobe D5-control/D5-disabled — §4.)*

---

## 1. Was der Drill beweist (und was nicht)

**Beweist:**

1. Die Diagnostics-Header werden auf dem realen Vercel-Preview-Deployment tatsächlich ausgeliefert (nicht nur im Unit-Doubles-Res).
2. Baseline-Absenz: unter `ACTIVE=0` **und** `DIAGNOSTICS=0` fehlen alle drei `X-DQL-Diagnostics*`-Header vollständig (D1); unabhängig davon beweist D0, dass der Stub-Pfad ohne ProductionRuntime nie einen Collector erzeugt.
3. Diagnostics-On: Header-Kontrakt gemäß korrigierter Matrix (v5-Delta §7), inklusive der beiden Ist-Vertrags-Dokumentationsläufe D2b (`ACTIVE=0` + `DIAGNOSTICS=1` → Header trotzdem präsent) und D2c (Sandbox + Diagnostics → leerer Snapshot-Header).
4. Config-invalid-Wire: `503` + `code=CONFIG_INVALID` + `reasons[]` + Version/Request-Id präsent + alle drei Diagnostics-Header absent (D4).
5. CB-Bypass diskriminierend via gepaarter Gegenprobe: identische aggressive CB-Config erzeugt mit aktivem CB eine `closed_to_open`-Transition (D5-control) und mit `DQL_DISABLE_CIRCUIT_BREAKER=1` keine (D5-disabled).
6. Bounded Categorization am echten Provider-Fehler: `errorCategory='client_4xx'`, kein Rohtext in Diagnostics-Feldern (D6).

**Beweist nicht** (bewusst außerhalb Drill-Scope):

- **Truncation unter natürlicher Last** — D3 darf `NOT_REACHED` enden; der Overflow-Pfad ist unit-/mutationszertifiziert (261. Test).
- **H1-Missing-Collector-Rejection** — der HTTP-Handler erzeugt bei Diagnostics-On immer selbst einen Collector; die Precondition ist nur am Factory-/Client-Seam deterministisch testbar und dort bereits mutativ unit-verifiziert. D5 beweist sie **nicht**.
- **H4 mit populated Collector auf dem 500-Pfad** — ohne explizite Fault Injection nicht deterministisch erreichbar (Providerfehler werden in der Axis-Engine zu `UNCERTAIN`); H4 bleibt primär durch den bestehenden Ordering-/Mutationstest belegt.
- Provider-SLA-Konformität (`serv-nano`/`serv-swift`-P95-Latenzen).
- Canary-Kalibrierung (Schritt 3 im §C+integration-Fahrplan).
- OpenAPI-Rendering (separater Schritt im Delta-Freigabepfad).

---

## 2. Deploy-Modell: immutable per-Szenario Preview-Deploys

Jedes Szenario bekommt einen **eigenen, unveränderlichen Preview-Deploy** mit dediziertem Env-Manifest — seit v6 wörtlich, auch für D2c und D3 (eigene `D2C_URL`/`D3_URL`; identisches Env-Profil wie D2, aber getrennte Deployments — Review-§4). Damit startet D3 nicht mit Breaker-/Isolat-Zustand aus dem D2-Lauf. Keine in-flight-Toggles. Gründe:

- `RUNTIME` wird module-scope beim Cold Start gecacht — ein Env-Toggle ohne Redeploy trifft warme Instanzen im alten Zustand;
- Vercel-Env-Änderungen erfordern ohnehin einen Redeploy;
- Isolierung verhindert Mischzustände über warme Instanzen;
- kein temporäres Überschreiben eines funktionierenden Provider-Keys (D6);
- Artefakte bleiben eindeutig einem SHA+Env-Manifest zuordenbar.

**Pro Szenario zu sichern** (alles **im Szenario-Ordner** `drill-runs/<timestamp>/<szenario>/`, F3): redigiertes Env-Manifest als `env-manifest.txt` (maschinenlesbar, parser-validiert, keine Klartext-Secrets — nur Presence + nicht-geheime Secret-Version; **aus der Deployment-Automation erzeugt, nicht handgepflegt** — S1), Run-Manifest `manifest.txt` mit URL, **Vercel-Deployment-ID** (K7/P2), SHA-Paar (§2a), **`config_hash` + `provider_endpoint_id`** aus `health.json` (S1; bei D4 leer — der 503-Body trägt sie nicht; `config_hash` ist lokal nicht nachrechenbar, die Bindung ist deploy-seitig) und UTC-Zeit, Health-Response (`health.json`) **plus separat erfasster Health-HTTP-Status (`health_status`, F1)**, **reduziertes Vercel-Inspect-Artefakt `vercel-inspect.json`** (geschlossenes 4-Key-Set `{id, url, target, readyState}`, `target: null` = Preview nach v13-Vertrag; die volle Owner-Response wird nie persistiert — K7-BIND, Hold 1 v9 + Security-HOLD v10, **Vertragsänderung §0a**), Curl-Exitcode und SHA-256-Hashes über exakt die neun Artefakte: `health.json`, `health_status`, `env-manifest.txt`, `manifest.txt`, `request.json`, `headers`, `body.json`, `curl_exit`, `vercel-inspect.json`. Root-Dateien außerhalb der Szenario-Ordner zählen nicht als Artefakte (`bash-env.txt` ist bewusst Ops-Beleg außerhalb des Artefakt-Vertrags — seit v10 bereits beim Run-Start geschrieben, damit er jeden Abbruch überlebt; §0a/§7).

### 2a. SHA-Attribution im Manifest (Korrektur)

Nach dem OpenAPI-Commit ist `d7a8ff6` nur noch die **Code-Basis**, nicht der deployte HEAD. Runner und Manifest dürfen nicht weiter hardcoded `sha=d7a8ff6...` behaupten. Stattdessen hält jedes Manifest fest:

```text
base_code_sha=d7a8ff67ae5b11819e...   # approved Code-Basis (fix)
deployed_sha=<Spec-Commit-HEAD>       # aus /dql/health.commit_sha des Szenario-Deploys
```

`deployed_sha` wird **aus der Health-Response des Deploys selbst** gezogen (`commit_sha`, von Vercel via `VERCEL_GIT_COMMIT_SHA` gesetzt) — nicht aus lokalem Git-Wissen. Stimmt `commit_sha` nicht mit dem freigegebenen Spec-Commit-HEAD überein: Stopp (P1). Die Prüfung gilt **ausnahmslos für jedes Szenario — auch D4** (E2): der config-invalid Health-503 trägt `commit_sha` im Body und muss denselben SHA-Vergleich bestehen.

### 2b. D5-Paar: maschinenlesbarer Gleichheitsbeweis (E4)

Zwei getrennte Deploys mit ähnlicher Prosabeschreibung beweisen nicht, dass die Configs identisch sind — der ON/OFF-Kontrast ist nur kausal interpretierbar, wenn alle anderen Variablen gleich sind. Deshalb wird pro D5-Paar **vor dem ersten Call** automatisch gedifft:

```text
D5-control vs. D5-disabled:
  zulässige Differenz      = ausschließlich DQL_DISABLE_CIRCUIT_BREAKER
  alle anderen non-secret  = byte-identisch
  SERV_API_KEY             = Präsenz + Secret-Version identisch (nie der Klartext)
  Payload                  = byte-identisch (identische Shell-Variable)
  Spec-SHA                 = identisch (deployed_sha beider Health-Responses)
```

**F2 — die Schalterwerte selbst gehören zum Beweis.** Ein Diff, der die Disable-Zeile vor dem Vergleich entfernt, prüft nur die Gleichheit der übrigen Zeilen — zwei identische Manifeste **ohne** Disable-Key würden ihn bestehen. Deshalb parst der Runner beide Manifeste strikt (Duplicate Keys abgelehnt) und verlangt zusätzlich:

```text
D5-control:   genau eine Zeile DQL_DISABLE_CIRCUIT_BREAKER=0
D5-disabled:  genau eine Zeile DQL_DISABLE_CIRCUIT_BREAKER=1
beide:        SERV_API_KEY_BOUND=true
beide:        SERV_API_KEY_SECRET_VERSION=<gleiche nicht-geheime ID>
```

`config_hash` ist dafür ungeeignet: das Disable-Flag ist Teil des Fingerprints, die Hashes differieren **erwartungsgemäß**. Der Gleichheitsbeweis läuft über den strikten Parser-Vergleich der redigierten Env-Manifeste (§5).

---

## 3. Preflight-Checkliste

| # | Item | Verantwortlich | Freigabe-Bedingung |
|---:|---|---|---|
| P1 | OpenAPI-Delta v5 reviewed; Spec-Patch + Spec-Tests committed + gepusht; **PR-HEAD ist der freigegebene Spec-Commit**, dessen Parent-/Patchbasis `d7a8ff6` ist und dessen einziger Produktdatei-Diff `api/openapi.ts` plus Tests ist; Suite/tsc/Build auf dem neuen HEAD grün | Paul | Diff-Audit gegen `d7a8ff6` bestanden; Suite grün auf Spec-Commit-HEAD |
| P2 | Pro Szenario: dedizierter Preview-Deploy erstellt, URL + Deployment-ID + redigiertes Env-Manifest + SHA-Paar (§2a) notiert — die Deployment-ID ist Pflicht-Env des Runners (`*_DEPLOY_ID`), wird auf Eindeutigkeit geprüft, in `manifest.txt` archiviert **und pro Szenario vor jedem Call per Vercel-Inspect an die URL gebunden** (`inspect.id`/`inspect.url`/`target === null` (v13-Vertrag: `null` = Preview)/`READY` — K7-BIND, Hold 1; Pflicht-Env `VERCEL_TOKEN`, read-only reicht; archiviert wird nur das reduzierte 4-Key-Artefakt, §0a) | Paul | Manifest-Tabelle vollständig (§4) |
| P3 | `SERV_API_KEY` in den Szenario-Envs gesetzt — außer D6 (absichtlich ungültiger, **nichtleerer** Testwert). Kein `DQL_MODEL_MAP` (toter Env-Eintrag, R1). `DQL_CAPITAL_PATH_MODE=1` in jedem pot-cli-Manifest | Paul | **Semantischer Health-Check pro Szenario bestanden und archiviert (§3a)** — nicht nur `status:"ok"` |
| P4 | Vollständige CB-Config in den On-Szenarien: `DQL_CB_CONFIG_BY_ALIAS` mit explizitem Entry für **jeden** bekannten Alias (Resolver-Pflicht bei `ACTIVE=1`) | Paul | Config-Gültigkeit **ausschließlich über `/dql/health`** (§3a) — **keine Verify-POST-Sonde** (E3: auf dem D5-Paar würde sie den aggressiven Breaker vor dem evidentiary Call öffnen; Health ist eine separate Function und berührt den Verify-Breaker nicht). D4: gewollter Health-503 |
| P5 | Env-Schalter dokumentiert: `DQL_CASCADE`, `DQL_V0431_ACTIVE`, `DQL_RUNTIME_DIAGNOSTICS`, `DQL_DISABLE_CIRCUIT_BREAKER` | Hermes | Werte in §4-Manifesten hardcoded, keine Ambiguität |
| P6 | Diagnostics-Caps am Build validiert: `maxAttempts=200`, `maxBindingSummaries=50` | Hermes | grep im HEAD-Tree |
| P7 | Rollback-Plan: Szenario-Deploys sind Wegwerf-Artefakte; das produktiv referenzierte Preview bleibt unberührt | Paul | dokumentiert |

Abweichung von P1 (SHA-Drift): sofortiger Stopp, keine Interpretation von Wire-Snapshots gegen andere Trees.

### 3a. Semantischer Health-Preflight pro Szenario

`GET /dql/health` liefert den redigierten Config-Fingerprint (`runtime_mode`, `v0431_active`, `diagnostics_on`, `capital_path_mode`, `disable_circuit_breaker`, `serv_api_key_bound`, `commit_sha`, `alias_gate_ready`, `config_hash`). Vor jedem Wire-Call wird die Health-Response **geprüft und archiviert** (`health.json` im Szenario-Ordner). `alias_gate_ready` ist die Konjunktion aus pot-cli + `v0431_active` + `capital_path_mode` + CB aktiv + `diagnostics_on` + nichtleerem `commit_sha` + `serv_api_key_bound`.

**D2 / D2c / D3 / D6:**

```text
status == ok
commit_sha == freigegebener Spec-Commit-HEAD
runtime_mode == pot-cli
v0431_active == true
diagnostics_on == true
capital_path_mode == true
disable_circuit_breaker == false
serv_api_key_bound == true
alias_gate_ready == true
```

D6 meldet trotz ungültigem (aber nichtleerem) Key `serv_api_key_bound=true` und `alias_gate_ready=true` — `serv_api_key_bound` ist ein reiner Presence-Flag. Der anschließende 401-Probe-Call ist der diskriminierende Auth-Test.

**D2b** (`ACTIVE=0` + `DIAGNOSTICS=1`):

```text
status == ok
v0431_active == false
diagnostics_on == true
alias_gate_ready == false
```

**D5-control** (CB aktiv, aggressive Config):

```text
status == ok
disable_circuit_breaker == false
alias_gate_ready == true
```

**D5-disabled:**

```text
status == ok
disable_circuit_breaker == true
alias_gate_ready == false
```

**D1** (beide Flags OFF): `status == ok`, `v0431_active == false`, `diagnostics_on == false`, `alias_gate_ready == false`.

**D4:** Health muss absichtlich `503` mit `status == config_invalid`, `code == CONFIG_INVALID` und `reasons[]` liefern — das **ist** der Preflight-Beleg, kein Fehler.

**F1 — HTTP-Status ist Teil der Erwartung, nicht nur der Body:** der Status wird atomar mit dem Body erfasst (`curl -w '%{http_code}'`), als `health_status` archiviert + gehasht und im Preflight geprüft — **D4: `503`, alle anderen Szenarien: `200`**. Ein Proxy/CDN, der einen plausiblen JSON-Body mit falschem Status liefert, fällt damit im Preflight auf statt erst in der Auswertung.

Weicht ein Health-Feld oder der Health-HTTP-Status von der Erwartung ab: Szenario nicht starten, Deploy verwerfen, Manifest korrigieren.

**E1 — ausführbar, nicht dokumentarisch:** Diese Prüfung ist im Runner als `preflight()`-Funktion implementiert und läuft **vor jedem `curl … /dql/verify`**; bei Abweichung bricht sie non-zero ab (§5). Ein Assertion-Kommentar im späteren Offline-Verifier erfüllt das Gate nicht — sonst könnte der Runner Provider-Wire-Calls gegen einen falsch konfigurierten Deploy ausführen.

**Neu v9 (Hold 2) — der Preflight allein ist kein Offline-Beweis:** Der Offline-Verifier rechnet exakt diese Matrix (inkl. `health_status`, D4-Sonderfall, `commit_sha` gegen den Pflicht-Input `EXPECTED_DEPLOYED_SHA`) gegen die **archivierten** `health.json`/`health_status` erneut nach (V9-H) — ein Run, dessen Health-Artefakte der Matrix widersprechen, failt offline, egal was der Runner zur Laufzeit behauptet hat.

---

## 4. Drill-Szenarien (erreichbare Matrix)

Alle Szenarien senden POST auf `<szenario-preview>/dql/verify` mit `application/json`. Response-Header werden mit `curl -sS -D <file>` erfasst. Sofern nicht anders angegeben: `sandbox: false` (Sandbox umgeht den `HttpLlmClient` vollständig — keine Attempts, keine Summaries).

**Gemeinsame Basis-Env für „ON“-Szenarien (D2/D2b/D2c/D3/D5/D6):**

```text
DQL_CASCADE=pot-cli
DQL_RUNTIME_DIAGNOSTICS=1
DQL_CAPITAL_PATH_MODE=1          # R1: in pot-cli PFLICHT, kein Default — fehlt er: 503 CONFIG_INVALID
SERV_API_KEY=<gültig>            # außer D6
DQL_CB_CONFIG_BY_ALIAS=<vollständig, jeder Alias explizit>
```

`DQL_CAPITAL_PATH_MODE` muss in **jedem** pot-cli-Manifest explizit stehen (auch D1: dort `DQL_CAPITAL_PATH_MODE=1` bei `ACTIVE=0`/`DIAGNOSTICS=0`). **Kein `DQL_MODEL_MAP`** — der geprüfte Runtimepfad liest die Variable nicht (R1); sie hat in keinem Manifest etwas zu suchen.

### D0 — Stub-Kontrolle (kein ProductionRuntime)

**Env:** `DQL_CASCADE=stub` (Diagnostics-Flags irrelevant).
**Payload:** minimaler valider Request, 1 Axis.
**Erwartung:** `200`, `X-DQL-Version` + `X-Request-Id` präsent, alle drei Diagnostics-Header **absent**.
**Beweist:** ohne ProductionRuntime entsteht nie ein Collector/Header — unabhängig von den Flags.

### D1 — Baseline OFF: keine Diagnostics-Header

**Env:**

```text
DQL_CASCADE=pot-cli
DQL_V0431_ACTIVE=0
DQL_RUNTIME_DIAGNOSTICS=0
DQL_CAPITAL_PATH_MODE=1
SERV_API_KEY=<gültig>
```

(`DQL_CAPITAL_PATH_MODE` und `SERV_API_KEY` sind in **jeder** pot-cli-Runtime Pflicht — auch in der Baseline; ohne sie wäre D1 ein 503-Deploy statt einer Baseline.) Beide Diagnostics-Flags **explizit** OFF — `ACTIVE=0` allein garantiert keine Header-Absenz (Emission hängt an `DIAGNOSTICS`, nicht an `ACTIVE`). `DQL_CASCADE=pot-cli` explizit, damit der reale Produktionsruntime-Pfad und nicht der Stub getestet wird.

**Payload:** `{"mandate":"m","proposed_action":"a","reasoning":"r","axes":["intent"],"sandbox":false}`
**Erwartung (normativ):**

- `HTTP/2 200`
- `X-DQL-Version` **präsent**, `X-Request-Id` **präsent** — Assertion nur: `startsWith('dql_')` + Gleichheit mit `DqlResponse.id`. **Kein** `{1,6}`-Regex (R3: der Generator kann bei `Math.random()===0` einen leeren Suffix erzeugen; die Spec normiert einen opaken String-Vertrag)
- alle drei `X-DQL-Diagnostics*` **absent**

Fehler-Signal: irgendein Diagnostics-Header taucht auf → FAIL, sofort escalate.

### D2 — Diagnostics ON, Success-Path, Snapshot ≤ 8 KiB

**Env:** Basis-Env + `DQL_V0431_ACTIVE=1`.
**Payload:**

```json
{
  "mandate": "m",
  "proposed_action": "a",
  "reasoning": "r",
  "axes": ["intent"],
  "sandbox": false
}
```

**Erwartung:**

- `HTTP/2 200`
- `X-DQL-Diagnostics` **präsent**, JSON parsebar, `Buffer.byteLength(value,'utf8') <= 8192`
- `X-DQL-Diagnostics-Truncated` + `-Counts` **absent**
- Snapshot:
  - `requestId` (camelCase) `===` `X-Request-Id`-Headerwert
  - `attempts.items.length >= 1`
  - `binding_summaries.items.length >= 1`
  - **E5 — echter Erfolg, nicht nur Aktivität:** `attempts>=1`/`summaries>=1` allein wird auch bei Provider-401, Netzwerk- oder Parse-Fehler grün. Zusätzlich zwingend:
    - `HTTP 200` (bereits oben) **und** `body.meta.models_used.length >= 1`
    - `some(attempts.items, x => x.ok === true)`
    - `some(binding_summaries.items, x => x.ok === true)`
  - jede `attempts[i].route ∈ {"primary","fallback"}`, `iteration >= 1`
  - `errorCategory` nur gesetzt wenn `ok===false`, und ∈ `FailureCategory`-Enum (7 Werte)
  - alle fünf Streams präsent (auch wenn `transitions`/`stale_results`/`invalid_outcomes` leer)

### D2b — Ist-Vertrag: `ACTIVE=0` + `DIAGNOSTICS=1`

**Env:** Basis-Env + `DQL_V0431_ACTIVE=0`.
**Payload:** wie D2.
**Erwartung:** identisch zu D2 **einschließlich der E5-Erfolgskriterien** (200 + `models_used>=1` + ok-Attempt + ok-Summary) — **Diagnostics-Header werden trotzdem gesendet.**
**Zweck:** dokumentiert den tatsächlichen Ist-Vertrag (Emission hängt nicht an `ACTIVE`), solange Code und ggf. gewünschte Zwei-Flag-Semantik auseinanderliegen. Kein FAIL-Kriterium — ein fehlender Header wäre hier umgekehrt eine Abweichung vom Ist-Vertrag.

### D2c — Ist-Vertrag: Sandbox + Diagnostics (leerer Snapshot)

**Env:** wie D2 — **eigener Deploy** (`D2C_URL`, Review-§4), identisches Env-Profil, eigenes Manifest.
**Payload:** wie D2, aber `"sandbox": true`.
**Erwartung:** `200`; `X-DQL-Diagnostics` **präsent** mit fünf leeren Streams (`items:[]`, `dropped:0` überall), `requestId` gesetzt.
**Zweck:** dokumentiert den tatsächlichen Empty-Snapshot-Header (kein `hasRows()`-Check), solange Code und ggf. gewünschte non-empty-Semantik auseinanderliegen.

### D3 — Natürliche Last (Truncation nur falls organisch erreicht)

**Env:** wie D2 — **eigener Deploy** (`D3_URL`, Review-§4): D3 startet damit garantiert ohne Breaker-/Isolat-Zustand aus dem D2-Lauf.
**Payload:** 5 Achsen explizit (`["intent","scope","risk","consistency","reversibility"]`), **kurzer realistischer Text** in allen Feldern (R6). Lange Felder bringen keinen Beweisgewinn: Requesttexte stehen nicht im Snapshot, die Snapshot-Größe hängt allein an Attempts/Summaries/Events — 19 000-Zeichen-Felder erhöhen nur Tokenlast, Latenz und Kosten. (Zur Einordnung: das Validator-Limit liegt bei 20 000 Zeichen; die alten 40 000er-Payloads aus v2 enden in `400 INVALID_REQUEST`.)
**Erwartung:**

- `HTTP/2 200`
- **Entweder** normaler `X-DQL-Diagnostics`-Header (typischer Fünf-Achsen-Lauf: ~5 Attempts + ~5 Summaries, deutlich unter 8 KiB)
- **oder** — nur falls natürliche Retries/Fallbacks den Snapshot über 8 KiB treiben — Truncation-Paar: `X-DQL-Diagnostics-Truncated` exakt `'1'` und `-Counts` im **nested Wire-Shape** (G1): Top-Level exakt `transitions`, `stale_results`, `invalid_outcomes`, `attempts`, `binding_summaries` + `dropped`; `dropped` exakt dieselben fünf Stream-Keys; alle Werte Integer ≥ 0.
- Erreicht der Lauf keine Truncation: als **`NOT_REACHED`** protokollieren — kein Fehler, ehrlich dokumentieren.

Hinweis: Die Attempt-Anzahl hängt an Achsen/Retries/Fallbacks, nicht an der Zeichenmenge. **Kein `DQL_TEST_ATTEMPT_INFLATE`** (Entscheidung §0h.1). Optionaler separater Transport-Harness-Deploy (never-merge) darf den Vercel-Headertransport des Truncation-Pfads prüfen, muss aber als synthetischer Transporttest gelabelt werden.

### D4 — Config-invalid `503` (eigener Deploy)

**Env:** wie D2, aber `DQL_CB_CONFIG_BY_ALIAS` absichtlich unvollständig — der Defekt ist **festgelegt und maschinenprüfbar** (G4): `minSamples` fehlt exakt im `serv-swift`-Entry; `serv-nano` bleibt vollständig. `resolveProductionConfig` wirft beim Cold Start (`RUNTIME.kind==='error'`), Reason-Format: `DQL_V0431_ACTIVE=true requires DQL_CB_CONFIG_BY_ALIAS['serv-swift'] to explicitly set [minSamples]…`. Das G4-Profil des Runners lehnt ein D4-Manifest ab, in dem der Defekt **nicht** vorhanden ist. **Neu (K6):** Preflight **und** Verifier prüfen die 503-`reasons` inhaltlich — jede Reason muss die engen Tokens `serv-swift` **und** `minSamples` tragen, `reasons` nicht leer (kein stabiler Per-Reason-Code im Ist-Vertrag → Token- statt Prosa-Vergleich). Ein Deploy, der aus einer **anderen** Config-Ursache 503 liefert, fällt schon vor dem POST auf; Zusatz-Reasons sind FAIL.
**Payload:** valider Body (wie D2).
**Erwartung:**

- `HTTP/2 503`
- Body: `code === "CONFIG_INVALID"`, `error` string, **`reasons` ist ein Array, nicht leer, und jede Reason benennt den festgelegten Defekt** (`serv-swift` + `minSamples`, K6; kein `details`-Feld)
- `X-DQL-Version` **präsent**, `X-Request-Id` **präsent**
- **alle drei `X-DQL-Diagnostics*` absent** — bei Config-Fehler wird kein Collector konstruiert

**Beweist:** die korrekte Config-Invalid-Wire — **nicht** H4 mit populated Collector (dieser bleibt durch den bestehenden Ordering-/Mutationstest belegt).
Fehler-Signal: irgendein Diagnostics-Header auf diesem 503 → Abweichung vom Ist-Vertrag, escalate.
Kein Rollback nötig: Wegwerf-Deploy.

### D5 — CB-Bypass als gepaarte Gegenprobe (control vs. disabled)

`attempts >= 1` + `summaries >= 1` + `transitions === 0` allein beweist nur echte Provider-I/O **ohne beobachtete Transition** — ein normaler gesunder CB-Lauf produziert dasselbe Bild (R2). Diskriminierend wird D5 erst als **Paar mit identischer, absichtlich aggressiver CB-Config**, bei dem sich control und disabled nur im Disable-Schalter unterscheiden:

**D5-control (eigener Deploy):**

```text
wie D2, aber in DQL_CB_CONFIG_BY_ALIAS für jeden Alias:
  minSamples=1
  tripP90LatencyMs=1
DQL_DISABLE_CIRCUIT_BREAKER=0
```

**Payload:** wie D2 (1 Axis, `sandbox:false`).
**Erwartung:** eine normale reale Providerantwort (Netz-Latenz > 1 ms) trippt das Fenster — `transitions.items` enthält ein `closed_to_open` mit **`reason='latency'`** (E5: ein Failure-Rate-Trip gilt **nicht** als Beleg für den geplanten Latenzpfad); zusätzlich zwingend mindestens ein `attempts[i].ok === true` und eine `binding_summaries[i].ok === true` — die Transition muss aus einem **erfolgreichen** Call entstehen, nicht aus einem Provider-Fehler. **Neu (K5) — Korrelation statt Koexistenz:** der Breaker ist per-Alias, also muss der Latenz-Trip (`closed_to_open.alias`) dem `attemptAlias` eines ok-Attempts **und** einer ok-Summary entsprechen; tragen Attempt und Summary beide eine `callId`, muss sie übereinstimmen. Ein Trip auf `serv-swift` bei Erfolg nur auf `serv-nano` ist FAIL. Health archiviert mit `disable_circuit_breaker=false`.

**E3 — Call-Disziplin für das Paar:** keine Verify-POST-Sonde vor dem evidentiary Call. Bei `minSamples=1`/`tripP90LatencyMs=1` würde bereits die Sonde den Breaker im warmen Isolat öffnen; der eigentliche Drill-Call wäre dann admission-rejected und erzeugte weder Transition noch Attempt-Zeile. Config-Gültigkeit wird ausschließlich über `/dql/health` geprüft (separate Function, berührt den Verify-Breaker nicht). Der evidentiary D5-POST muss der **erste** absichtlich ausgeführte `/dql/verify`-Call auf dem frischen Deployment sein. Liefert D5-control nicht `attempt.ok=true` + `summary.ok=true` + `closed_to_open`/`reason='latency'`: **Paar als nicht diskriminierend verwerfen und nicht wiederverwenden** — für einen neuen Versuch frische Deploys erzeugen.

**D5-disabled (eigener Deploy):**

```text
exakt gleiche CB-Config und Payload, plus global:
DQL_DISABLE_CIRCUIT_BREAKER=1
```

(Nicht als alias-lokales Feld in `DQL_CB_CONFIG_BY_ALIAS` — ein `disableCircuitBreaker`-Key dort wird als unbekannt abgewiesen und erzeugt `CONFIG_INVALID`.)

**Erwartung (alle zwingend):**

```text
attempts.items.length >= 1
binding_summaries.items.length >= 1
transitions.items.length === 0
some(attempts.items,          x => x.ok === true)   # F4
some(binding_summaries.items, x => x.ok === true)   # F4
```

plus normaler `X-DQL-Diagnostics`-Header wie D2; Health archiviert mit `disable_circuit_breaker=true`. Der Provider-Erfolg ist Teil des Beweises (F4): „keine Transition“ wäre sonst auch mit einem fehlgeschlagenen Call trivial erfüllbar — erst ein **erfolgreicher** Call unter identisch aggressiver Latenz-Config ohne Transition kontrastiert sauber gegen D5-control.

**Beweist (nur als Paar):** dieselbe aggressive Config erzeugt mit aktivem CB eine Transition und ohne ihn keine — die Transition verschwindet **wegen des Disable-Schalters**, nicht mangels Last.
**Fallback, falls kein absichtlich aggressiver Live-CB-Deploy gewünscht ist:** D5 läuft nur als D5-disabled, und der Claim wird abgeschwächt auf „bestätigt Provider-I/O + resolved disable flag (Health) + keine beobachtete Transition“; der tatsächliche Bypass bleibt dann unit-/mutationsbelegt. Default dieses Briefings ist die **gepaarte Variante**.
**Beweist nicht:** die H1-Rejection bei fehlendem Collector — der HTTP-Handler erzeugt bei Diagnostics-On immer selbst einen Collector; die Missing-Collector-Precondition ist nur am Factory-/Client-Seam testbar und dort bereits mutativ unit-verifiziert.

### D6 — Provider-Failure, kategorisierte AttemptEvents (eigener Deploy)

**Env:** wie D2, aber `SERV_API_KEY` auf einen **absichtlich ungültigen Testwert** gesetzt — in einem **dedizierten Deploy**. Nie den Key eines gemeinsam genutzten Preview-Deployments überschreiben.

**G3 — beweisbarer No-Leak statt Heuristik:** der Testwert trägt einen eindeutigen, nicht-produktiven Marker (z. B. `sk-test-DQLDRILLMARKER-<random>`), der dem Runner als `D6_KEY_MARKER` übergeben wird. Der Runner grept jedes archivierte Env-Manifest gegen den Marker (Redaktions-Check) und reicht ihn als `D6_FORBIDDEN_TOKEN` an den Offline-Verifier weiter — **niemals** über das redigierte Manifest. Ohne gesetzten Token endet der Verifier mit FAIL: „No-Leak-Invariante nicht beweisbar“ — der Claim wird dann heruntergestuft, nicht stillschweigend bestanden.

**Payload:** wie D2.
**Erwartung:**

- HTTP-Status: der Provider-401 wird als `client_4xx` kategorisiert und ist **nicht retryable**; die Engine fängt den Fehler je Achse ab — der Status kann daher weiterhin **200 mit `UNCERTAIN`-Achsen** sein. Status ist nicht das Prüfkriterium.
- Diagnostics-AttemptEvents: `ok=false`, `errorCategory='client_4xx'`.
- Diagnostics-JSON enthält **weder** den Key-Marker **noch** einen Provider-Marker (`Unauthorized`, `invalid api`, `invalid_api_key`, … — erweiterbare Liste) **noch** freie Fehlertext-Keys: alle Stream-Items laufen durch geschlossene Allowlist-Schemata (String-Felder in Attempts nur `requestId`/`axis`/`callId`/`requestedAlias`/`attemptAlias`/`route`/`errorCategory`), und der gesamte Snapshot wird rekursiv auf `error`/`message`/`details`/`response`/`body`/`stack`-Keys gescannt (G3).
- Der bestehende Response-Body kann weiterhin gekürzten Provider-Fehlertext in `AxisResult.objection` enthalten — das ist **außerhalb** der Diagnostics-No-Leak-Invariante und kein FAIL.

Fehler-Signal: `errorCategory` außerhalb des 7er-Enums **oder** Rohfehler-String in einem Diagnostics-Feld → Leak, sofort escalate.

### Übersichtsmatrix

| Szenario | Immutable Preview-Env | Payload | Erwarteter Diagnostics-Wire |
|---|---|---|---|
| D0 Stub | `DQL_CASCADE=stub` | 1 Axis, sandbox=false | alle drei absent |
| D1 OFF | `ACTIVE=0`, `DIAGNOSTICS=0`, pot-cli gültig | 1 Axis, sandbox=false | alle drei absent |
| D2 ON klein | `ACTIVE=1`, `DIAGNOSTICS=1`, vollständige CB-Config | 1 Axis, sandbox=false | normaler JSON-Header; E5: 200 + `models_used>=1` + ok-Attempt + ok-Summary |
| D2b ACTIVE=0+DIAG=1 | wie D2, `ACTIVE=0` | wie D2 | Header trotzdem präsent (Ist-Vertrag); E5-Kriterien wie D2 |
| D2c Sandbox+Diag | wie D2, **eigener Deploy** (`D2C_URL`) | wie D2, sandbox=true | Header präsent, fünf leere Streams |
| D3 natürliche Last | wie D2, **eigener Deploy** (`D3_URL`) | 5 Achsen, kurzer realistischer Text | normal **oder** bei natürlichen Retries truncated; `NOT_REACHED` erlaubt |
| D4 invalid config | wie D2, CB-Config absichtlich unvollständig | valider Body | `503` + `reasons[]`; Diagnostics absent |
| D5-control aggressive CB | wie D2 + `minSamples=1`, `tripP90LatencyMs=1`, CB aktiv | 1 Axis, sandbox=false | normaler Header; `closed_to_open` (`reason='latency'`) + ok-Attempt + ok-Summary (E5); erster Verify-Call auf frischem Deploy (E3) |
| D5-disabled | exakt wie D5-control + `DQL_DISABLE_CIRCUIT_BREAKER=1` | identisch | normaler Header; ok-Attempt + ok-Summary (F4); Transitions = 0 |
| D6 invalid provider key | eigener Deploy, wie D2 + ungültiger SERV-Key | 1 Axis, sandbox=false | Attempt `client_4xx`; kein Rohtext in Diagnostics; Status ggf. 200/UNCERTAIN |

---

## 5. Runner + Verifier (materialisiert und getestet — Review-§5.2/§5.3)

Beide Skripte existieren als **echte lokale Dateien** und wurden gegen synthetische Fixtures ausgeführt (§5a); die folgenden Codeblöcke sind **aus den Dateien generiert**, nicht abgetippt — Block und Datei sind identisch. Beide bleiben lokal auf dem Ops-Rechner, nicht im Repo.

Pro Szenario eine eigene URL **und ein eigenes redigiertes Env-Manifest** — kein Env-Toggle im Lauf, keine geteilten Deploys (Review-§4). Vor jedem Netzwerk-Call: Bash-4+-Laufzeit-Guard (K8), Tool-Preflight (SM-R1) und Eindeutigkeits-Preflight über alle zehn URLs + Deployment-IDs — **neu v9** mit syntaktischer URL-Schließung: keine Credentials, kein Pfad, keine Query, kein Fragment, kein Nichtstandard-Port; Dedup über den Host (K7, Hold 1). Reihenfolge pro Szenario: Env-Manifest gegen das **G4-Szenarioprofil** validieren + archivieren + Marker-Redaktions-Check (F3/G3/G4) → **K7-BIND: Vercel-Inspect des Szenario-Deployments** (`inspect.id == *_DEPLOY_ID`, `inspect.url == URL-Host`, `target === null` — v13-Vertrag, Feld fehlt = FAIL —, `READY`; archiviert wird das **reduzierte** 4-Key-Artefakt `vercel-inspect.json`, das Raw-Tempfile wird auf jedem Pfad gelöscht — Hold 1/Security v10) → Health mit HTTP-Status erfassen (F1) → Run-Manifest mit Deployment-ID + Config-Fingerprint schreiben (K7/S1) → SHA (immer, E2) → semantische Health-Assertions inkl. Status, D4-Reason-Tokens und Fingerprint-Präsenz (E1/F1/K6/S1) → genau ein evidentiary POST mit `-H 'Expect:'` (H2) → Hashes. Das D5-Paar wird zusätzlich **vor seinen beiden Calls** einmalig durch den strikten Parser-Vergleich validiert (F2/E4). Am Ende ruft der Runner den Offline-Verifier mit `D6_FORBIDDEN_TOKEN` **und dem Pflicht-Input `EXPECTED_DEPLOYED_SHA`** auf. `bash-env.txt` (Bash-Pfad + `bash --version`) schreibt der Runner **bereits beim Anlegen des Run-Ordners** — vor Preflight und jedem Netzwerk-Call, damit der Ops-Beleg jeden Abbruch überlebt (Ops-HOLD v10, §0a/§7).

`scripts/live-drill-v0431-c-integration.sh`:

```bash
#!/usr/bin/env bash
# scripts/live-drill-v0431-c-integration.sh — Live-Drill-Runner (v10: v9 + Hermes-v9-Holds — target:null-Vertrag, reduziertes Inspect-Artefakt, bash-env vor K7).
# Lokal auf dem Ops-Rechner, nicht im Repo. Benötigt: bash 4+, curl, python3, node, sha256sum,
# VERCEL_TOKEN (Read-Scope: Deployment-Inspect für K7-BIND).
# macOS: System-Bash ist 3.2 — gepinnte Homebrew-Bash nutzen, z. B.:
#   /opt/homebrew/bin/bash scripts/live-drill-v0431-c-integration.sh
set -euo pipefail
# K8: Laufzeit-Guard — `bash -n` beweist keine Runnability. Assoziative Arrays
# brauchen Bash 4+; Apple-Bash 3.2.57 scheitert sonst mitten im Script.
(( BASH_VERSINFO[0] >= 4 )) || { echo "FATAL K8: Bash 4+ erforderlich, gefunden: $BASH_VERSION" >&2; exit 2; }
# SM-R1 (Steelman): Tool-Preflight VOR jeder weiteren Aktion — die „Benötigt:"-Zeile im
# Kopf ist nur Prosa. macOS liefert z. B. KEIN sha256sum (nur shasum); ohne diesen Check
# stürbe der Lauf erst am Ende von Schritt 8 — NACH bereits verbrauchten evidentiary
# POSTs (E3: D5-Deploys wären verbrannt). Nur Bash-Builtins bis hierher.
for t in curl python3 node sha256sum date mkdir cp grep tee dirname; do
  command -v "$t" >/dev/null 2>&1 || { echo "FATAL SM-R1: benötigtes Tool fehlt im PATH: $t" >&2; exit 2; }
done
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
mkdir -p ./drill-runs
OUT="./drill-runs/$(date -u +%Y%m%dT%H%M%SZ)"
# SM-R2: frisches Run-Verzeichnis ERZWINGEN (kein -p): kollidieren zwei Läufe in derselben
# Sekunde, dürfen sich ihre Artefakte nicht stillschweigend mischen — Abbruch statt Merge.
mkdir "$OUT"
# Ops-Beleg (Hermes v9, Ops-Hold): Bash-Pfad + Version SOFORT nach Run-Root-Anlage sichern —
# VOR K7-Preflight und jedem Netzwerk-Call. Unter `set -e` existiert der Beleg damit auch
# bei jedem späteren FAIL; er darf NICHT vom Gesamt-PASS abhängen.
printf 'bash_path=%s\nbash_version=%s\n' "$BASH" "$BASH_VERSION" > "$OUT/bash-env.txt"

BASE_CODE_SHA="d7a8ff67ae5b11819ee2c5c8db4223f76f0e7a86"   # approved Code-Basis (fix)
EXPECTED_DEPLOYED_SHA="${EXPECTED_DEPLOYED_SHA:?}"          # freigegebener Spec-Commit-HEAD
VERCEL_TOKEN="${VERCEL_TOKEN:?}"                            # K7-BIND: Inspect-Auth (Read)
# G3: eindeutiger, nicht-produktiver Marker im D6-Test-Key — wird dem Offline-Verifier
# separat übergeben und darf NIE im redigierten Manifest oder in Artefakten stehen.
D6_KEY_MARKER="${D6_KEY_MARKER:?}"

# Pro Szenario: URL des dedizierten immutable Preview-Deploys (Review-§4: auch D2c/D3 eigene Deploys).
declare -A URLS=(
  [D0_stub]="${D0_URL:?}"      [D1_baseline]="${D1_URL:?}"
  [D2_on_small]="${D2_URL:?}"  [D2b_active0_diag1]="${D2B_URL:?}"
  [D2c_sandbox_diag]="${D2C_URL:?}"
  [D3_natural_load]="${D3_URL:?}"
  [D4_invalid_config]="${D4_URL:?}"
  [D5_control]="${D5C_URL:?}"
  [D5_disabled]="${D5D_URL:?}"
  [D6_invalid_key]="${D6_URL:?}"
)
# Pro Szenario: Pfad zum redigierten Env-Manifest des Deploys (F3) — keine Klartext-Secrets.
declare -A ENVM=(
  [D0_stub]="${D0_ENV:?}"      [D1_baseline]="${D1_ENV:?}"
  [D2_on_small]="${D2_ENV:?}"  [D2b_active0_diag1]="${D2B_ENV:?}"
  [D2c_sandbox_diag]="${D2C_ENV:?}"
  [D3_natural_load]="${D3_ENV:?}"
  [D4_invalid_config]="${D4_ENV:?}"
  [D5_control]="${D5C_ENV:?}"
  [D5_disabled]="${D5D_ENV:?}"
  [D6_invalid_key]="${D6_ENV:?}"
)
# K7/P2: Vercel-Deployment-ID des immutable Deploys je Szenario — wird im Run-Manifest
# archiviert (§2/P2: URL allein ist kein Deploy-Beweis) und auf Eindeutigkeit geprüft.
declare -A DEPLOY_IDS=(
  [D0_stub]="${D0_DEPLOY_ID:?}"      [D1_baseline]="${D1_DEPLOY_ID:?}"
  [D2_on_small]="${D2_DEPLOY_ID:?}"  [D2b_active0_diag1]="${D2B_DEPLOY_ID:?}"
  [D2c_sandbox_diag]="${D2C_DEPLOY_ID:?}"
  [D3_natural_load]="${D3_DEPLOY_ID:?}"
  [D4_invalid_config]="${D4_DEPLOY_ID:?}"
  [D5_control]="${D5C_DEPLOY_ID:?}"
  [D5_disabled]="${D5D_DEPLOY_ID:?}"
  [D6_invalid_key]="${D6_DEPLOY_ID:?}"
)

# K7: VOR jedem Call an die Szenario-Deployments — alle zehn URLs und Deployment-IDs
# müssen eindeutig sein, jede URL syntaktisch GESCHLOSSEN ein Vercel-Deployment adressieren
# (kein `-git-`-Branch-Alias, keine Credentials/Ports/Pfade/Query/Fragmente — Hermes v8
# HOLD 1). URL-Reuse hebelt die Deploy-Isolation aus: D2/D2c/D3 haben identische Health-
# Profile — der Preflight würde Reuse nicht bemerken. Die eigentliche URL↔ID-BINDUNG
# passiert je Szenario per Vercel-Inspect (K7-BIND in do_call, Control-Plane-Call).
K7_ROWS=$(for k in "${!URLS[@]}"; do printf '%s\t%s\t%s\n' "$k" "${URLS[$k]}" "${DEPLOY_IDS[$k]}"; done)
K7_ROWS="$K7_ROWS" python3 - <<'PY'
import os, sys
from urllib.parse import urlsplit
rows = [l.split('\t') for l in os.environ['K7_ROWS'].splitlines() if l.strip()]
def fail(m): sys.exit(f"K7 FAIL: {m}")
if len(rows) != 10: fail(f"{len(rows)} Szenarien statt 10")
urls, ids = {}, {}
for scn, url, did in rows:
    u = urlsplit(url.strip().rstrip('/'))
    if u.scheme != 'https': fail(f"{scn}: URL nicht https")
    host = (u.hostname or '').lower()
    if not host.endswith('.vercel.app'): fail(f"{scn}: '{host}' ist kein *.vercel.app-Deployment")
    if '-git-' in host: fail(f"{scn}: '{host}' ist ein mutabler Branch-Alias — immutable Deployment-URL nötig")
    # K7-Schließung (Hermes v8 HOLD 1): keine Credentials, kein Nichtstandard-Port,
    # kein Pfad/Query/Fragment — sonst wäre die „URL“ ein anderes Ziel als der Host.
    if u.username or u.password: fail(f"{scn}: URL trägt Credentials")
    if u.port not in (None, 443): fail(f"{scn}: Nichtstandard-Port {u.port}")
    if u.path not in ('', '/'): fail(f"{scn}: URL trägt Pfad {u.path!r}")
    if u.query: fail(f"{scn}: URL trägt Query")
    if u.fragment: fail(f"{scn}: URL trägt Fragment")
    if host in urls: fail(f"URL-Duplikat: {scn} und {urls[host]} teilen {host} — Deploy-Isolation verletzt")
    urls[host] = scn
    if not did.strip(): fail(f"{scn}: Deployment-ID leer")
    if did in ids: fail(f"Deployment-ID-Duplikat: {scn} und {ids[did]}")
    ids[did] = scn
PY

infra_fail() {  # Transportfehler ist INFRA_FAIL — kein Wire-Ergebnis, keine Matrix-Wertung.
  local name="$1" msg="$2"
  echo "INFRA_FAIL $name: $msg" | tee "$OUT/$name/INFRA_FAIL" >&2
  exit 1
}

# G4: Manifest-Prüfung als strukturiertes Szenarioprofil — nicht nur Einzelkeys.
# Profil-JSON: {"required": {KEY: WERT, ...},          # exakte Pflicht-Schalter
#               "secret_version": true|false,          # SERV_API_KEY_SECRET_VERSION Präsenz
#               "cb": null | {"mode": "active_full"}   # beide Aliases, alle 7 Felder numerisch
#                    | {"mode": "aggressive"}          # + minSamples==1, tripP90LatencyMs==1
#                    | {"mode": "defect",              # D4: exakt EIN benanntes Feld fehlt
#                       "defect_alias": "...", "defect_missing": "..."}}
check_env_manifest() {
  local manifest="$1" profile_json="$2"
  PROFILE="$profile_json" python3 - "$manifest" <<'PY'
import json, os, re, sys
path = sys.argv[1]; prof = json.loads(os.environ["PROFILE"]); kv = {}
def fail(m): sys.exit(f"G4 FAIL {path}: {m}")
for i, line in enumerate(open(path), 1):
    s = line.strip()
    if not s or s.startswith('#'): continue
    if '=' not in s: fail(f"Zeile {i}: keine KEY=VALUE-Zeile")
    k, v = s.split('=', 1)
    if not re.fullmatch(r'[A-Z_][A-Z0-9_]*', k): fail(f"Zeile {i}: ungültiger Key {k!r}")
    # SM-R4: generischer Klartext-Secret-Verdacht — zusätzlich zum expliziten
    # SERV_API_KEY-Verbot. Legitime Keys enden nicht auf diese Suffixe
    # (…_BOUND und …_SECRET_VERSION bleiben erlaubt).
    if re.search(r'(_KEY|_SECRET|_TOKEN|_PASSWORD)$', k):
        fail(f"Zeile {i}: mutmaßlicher Klartext-Secret-Key {k!r} im redigierten Manifest")
    if k in kv: fail(f"Duplicate Key {k}")
    kv[k] = v
if "SERV_API_KEY" in kv:
    fail("Klartext-Secret im Manifest — nur SERV_API_KEY_BOUND + SERV_API_KEY_SECRET_VERSION")
for k, want in prof.get("required", {}).items():
    if kv.get(k) != want: fail(f"{k}={kv.get(k)!r}, erwartet {want!r}")
if prof.get("secret_version") and not kv.get("SERV_API_KEY_SECRET_VERSION"):
    fail("SERV_API_KEY_SECRET_VERSION fehlt oder leer")
cb = prof.get("cb")
if cb:
    ALIASES = ["serv-nano", "serv-swift"]
    FIELDS = ["tripP90LatencyMs", "tripFailureRate", "cooldownMs",
              "windowSize", "windowAgeMs", "minSamples", "probeMaxLatencyMs"]
    raw = kv.get("DQL_CB_CONFIG_BY_ALIAS")
    if raw is None: fail("DQL_CB_CONFIG_BY_ALIAS fehlt")
    try: cfg = json.loads(raw)
    except json.JSONDecodeError: fail("DQL_CB_CONFIG_BY_ALIAS ist kein JSON")
    if not isinstance(cfg, dict) or sorted(cfg) != sorted(ALIASES):
        fail(f"Aliases {sorted(cfg) if isinstance(cfg, dict) else type(cfg).__name__} ≠ {ALIASES}")
    for a in ALIASES:
        entry = cfg[a]
        if not isinstance(entry, dict): fail(f"{a}: kein Objekt")
        want_fields = set(FIELDS)
        if cb["mode"] == "defect" and a == cb["defect_alias"]:
            want_fields.discard(cb["defect_missing"])
            if cb["defect_missing"] in entry:
                fail(f"D4-Defekt fehlt — {cb['defect_missing']} ist in {a} gesetzt")
        missing = sorted(want_fields - set(entry))
        if missing: fail(f"{a}: CB-Felder fehlen {missing}")
        unknown = sorted(set(entry) - set(FIELDS))
        if unknown: fail(f"{a}: unbekannte CB-Keys {unknown}")
        for f in sorted(want_fields):
            if isinstance(entry[f], bool) or not isinstance(entry[f], (int, float)):
                fail(f"{a}.{f} ist nicht numerisch")
        if cb["mode"] == "aggressive" and (entry.get("minSamples") != 1 or entry.get("tripP90LatencyMs") != 1):
            fail(f"{a}: nicht aggressiv — minSamples/tripP90LatencyMs müssen exakt 1 sein")
PY
}

preflight() {  # E1/E2/F1: läuft VOR jedem POST; bricht bei Abweichung non-zero ab.
  local name="$1" expect_json="$2" health_status="$3"
  NAME="$name" EXPECT_JSON="$expect_json" HEALTH_STATUS="$health_status" \
  EXPECTED_DEPLOYED_SHA="$EXPECTED_DEPLOYED_SHA" \
  python3 - "$OUT/$name/health.json" <<'PY'
import json, os, sys
h = json.load(open(sys.argv[1])); name = os.environ["NAME"]
def fail(m):
    print(f"PREFLIGHT FAIL {name}: {m}", file=sys.stderr); sys.exit(1)
# F1: HTTP-Status prüfen — ein plausibler Body mit falschem Status (Proxy/CDN) zählt nicht.
want_status = "503" if name == "D4_invalid_config" else "200"
if os.environ["HEALTH_STATUS"] != want_status:
    fail(f"F1: health HTTP {os.environ['HEALTH_STATUS']}, erwartet {want_status}")
# E2: SHA-Prüfung IMMER — auch D4; der config-invalid 503 trägt commit_sha im Body.
if h.get("commit_sha") != os.environ["EXPECTED_DEPLOYED_SHA"]:
    fail(f"SHA-Drift: {h.get('commit_sha')!r} (P1)")
if name == "D4_invalid_config":  # eigene 503-Regel (§3a)
    if not (h.get("status") == "config_invalid" and h.get("code") == "CONFIG_INVALID"
            and isinstance(h.get("reasons"), list)):
        fail("D4-503-Regel verletzt (status/code/reasons[])")
    # K6: der Health-503 muss GENAU den festgelegten Defekt benennen — enge Tokens
    # ('serv-swift' + 'minSamples') statt Prosa-Vergleich (kein stabiler Reason-Code
    # im Ist-Vertrag). Ein Deploy, der aus einem ANDEREN Config-Grund 503 liefert,
    # fällt hier VOR dem POST auf; Zusatz-Reasons sind FAIL (Claim: exakt dieser Defekt).
    if not h["reasons"]: fail("K6: reasons[] leer")
    for r in h["reasons"]:
        if not (isinstance(r, str) and "serv-swift" in r and "minSamples" in r):
            fail(f"K6: Reason nicht dem D4-Defekt (serv-swift/minSamples) zuordenbar: {r!r}")
    sys.exit(0)
# S1: deploy-seitiger Config-Fingerprint muss vorhanden sein — wird archiviert (health.json,
# hash-gedeckt) und ins Run-Manifest übernommen (Manifest-zu-Deploy-Bindung).
if not h.get("config_hash"): fail("S1: config_hash fehlt/leer")
if not h.get("provider_endpoint_id"): fail("S1: provider_endpoint_id fehlt/leer")
for k, v in json.loads(os.environ["EXPECT_JSON"]).items():
    if h.get(k) != v:
        fail(f"{k}={h.get(k)!r}, erwartet {v!r}")
PY
}

do_call() {
  local name="$1" url="$2" body="$3" expect_json="$4" env_profile="$5"
  mkdir -p "$OUT/$name"
  # 0) F3/G4: redigiertes Env-Manifest gegen das Szenarioprofil prüfen
  #    und IM SZENARIO-ORDNER archivieren (Root-Dateien zählen nicht als Artefakte).
  check_env_manifest "${ENVM[$name]}" "$env_profile"
  cp "${ENVM[$name]}" "$OUT/$name/env-manifest.txt"
  # G3: der D6-Key-Marker darf in KEINEM archivierten Manifest auftauchen.
  if grep -qF "$D6_KEY_MARKER" "$OUT/$name/env-manifest.txt"; then
    infra_fail "$name" "D6-Key-Marker im redigierten Manifest — Redaktion fehlgeschlagen"
  fi
  # 0b) K7-BIND (Hermes v8 HOLD 1, v10-korrigiert nach Hermes v9 HOLD 1): URL↔Deployment-ID
  #     über die Vercel-API binden. v13-IST-VERTRAG (live gegen api.vercel.com verifiziert):
  #     Preview-Deployments tragen target=null — der Wert "preview" existiert im API-Shape
  #     NICHT. Control-Plane-Call an api.vercel.com, KEIN Call an das Szenario-Deployment (E3).
  # Security-Hold (Hermes v9): die volle Inspect-Antwort enthält env-/build-/git-Metadaten
  # des Owners (~107 env-Keys). Sie wird nur TEMPORÄR mit 0600 gehalten; archiviert und
  # hash-gedeckt wird ausschließlich das reduzierte 4-Key-Artefakt {id,url,target,readyState}.
  local raw_ins="$OUT/$name/.vercel-inspect-raw.json"
  ( umask 077 && : > "$raw_ins" )
  curl -sS --max-time 30 -o "$raw_ins" \
    -H "Authorization: Bearer $VERCEL_TOKEN" \
    "https://api.vercel.com/v13/deployments/${DEPLOY_IDS[$name]}" \
    || { rm -f "$raw_ins"; infra_fail "$name" "Vercel-Inspect nicht erreichbar (curl exit $?)"; }
  NAME="$name" URL="$url" DID="${DEPLOY_IDS[$name]}" \
    python3 - "$raw_ins" "$OUT/$name/vercel-inspect.json" <<'PY'
import json, os, sys
from urllib.parse import urlsplit
name = os.environ["NAME"]
def fail(m):
    print(f"K7-BIND FAIL {name}: {m}", file=sys.stderr); sys.exit(1)
try:
    with open(sys.argv[1]) as f: ins = json.load(f)
except Exception as e:
    os.remove(sys.argv[1]); fail(f"Inspect-Antwort kein JSON ({e})")
if not isinstance(ins, dict):
    os.remove(sys.argv[1]); fail("Inspect-Antwort kein Objekt")
# Reduziertes Artefakt ZUERST schreiben, Raw SOFORT löschen — kein Codepfad behält die
# volle Owner-Antwort, auch nicht bei FAIL. Nur real präsente Keys werden übernommen
# (fehlt 'target', fehlt es auch im Artefakt — nichts wird fabriziert).
red = {k: ins[k] for k in ("id", "url", "target", "readyState") if k in ins}
with open(sys.argv[2], "w") as f:
    json.dump(red, f, sort_keys=True); f.write("\n")
os.remove(sys.argv[1])
host = (urlsplit(os.environ["URL"]).hostname or "").lower()
if ins.get("id") != os.environ["DID"]:
    fail(f"inspect.id={ins.get('id')!r} != DEPLOY_ID {os.environ['DID']!r} — erfundene/fremde ID")
if (ins.get("url") or "").lower() != host:
    fail(f"inspect.url={ins.get('url')!r} != URL-Host {host!r} — mutabler Alias oder fremdes Deployment")
if "target" not in ins: fail("Feld 'target' fehlt in der Inspect-Antwort — Preview-Status nicht beweisbar")
if ins["target"] is not None: fail(f"target={ins['target']!r}, erwartet null (v13-Vertrag: null = Preview)")
if ins.get("readyState") != "READY": fail(f"readyState={ins.get('readyState')!r}, erwartet 'READY'")
PY
  # 1) F1: Health-Body UND HTTP-Status atomar erfassen. Kein `|| true`: Transportfehler = INFRA_FAIL.
  local health_status
  #    SM-R3: --max-time — ein hängender Deploy wird begrenzter INFRA_FAIL, kein Endlos-Hänger.
  health_status=$(curl -sS --max-time 30 -o "$OUT/$name/health.json" -w '%{http_code}' "$url/dql/health") \
    || infra_fail "$name" "health nicht erreichbar (curl exit $?)"
  printf '%s\n' "$health_status" > "$OUT/$name/health_status"
  local deployed_sha config_hash endpoint_id
  deployed_sha=$(python3 -c 'import json,sys; print(json.load(sys.stdin).get("commit_sha") or "")' \
    < "$OUT/$name/health.json")
  config_hash=$(python3 -c 'import json,sys; print(json.load(sys.stdin).get("config_hash") or "")' \
    < "$OUT/$name/health.json")
  endpoint_id=$(python3 -c 'import json,sys; print(json.load(sys.stdin).get("provider_endpoint_id") or "")' \
    < "$OUT/$name/health.json")
  # §2a/P2/S1: SHA-Paar + Deployment-ID + deploy-seitiger Config-Fingerprint im Run-Manifest
  # (config_hash/provider_endpoint_id sind bei D4-503 leer — der 503-Body trägt sie nicht).
  printf '%s\n' "url=$url" "deployment_id=${DEPLOY_IDS[$name]}" \
    "base_code_sha=$BASE_CODE_SHA" "deployed_sha=$deployed_sha" \
    "config_hash=$config_hash" "provider_endpoint_id=$endpoint_id" \
    "utc=$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$OUT/$name/manifest.txt"
  # 2)+3) E1/E2/F1: semantischer Preflight inkl. HTTP-Status und SHA — ausnahmslos, auch für D4.
  preflight "$name" "$expect_json" "$health_status"
  # 6) Genau EIN evidentiary POST. `-H 'Expect:'` unterdrückt 100-Continue-Zweitblöcke (H2).
  #    Exitcode separat sichern — kein `|| true`, das Transportfehler in Artefakte verwandeln würde.
  local rc=0
  #    SM-R3: 300 s Deckel — D3 (fünf Achsen, echte LLM-Calls) braucht Luft; Timeout = INFRA_FAIL.
  curl -sS --max-time 300 -D "$OUT/$name/headers" -o "$OUT/$name/body.json" \
    -H "Content-Type: application/json" -H "Expect:" \
    -X POST "$url/dql/verify" \
    --data-binary "$body" || rc=$?
  echo "$rc" > "$OUT/$name/curl_exit"
  [[ "$rc" == 0 ]] || infra_fail "$name" "Transportfehler (curl exit $rc)"
  # 8) Hashes über ALLE Artefakte des Szenarios — inkl. health_status (F1) und env-manifest.txt (F3).
  ( cd "$OUT/$name" && printf '%s' "$body" > request.json \
    && sha256sum health.json health_status env-manifest.txt manifest.txt \
         request.json headers body.json curl_exit vercel-inspect.json > sha256.txt )
}

SMALL='{"mandate":"m","proposed_action":"a","reasoning":"r","axes":["intent"],"sandbox":false}'
SANDBOX='{"mandate":"m","proposed_action":"a","reasoning":"r","axes":["intent"],"sandbox":true}'
# D3 (R6): fünf Achsen, kurzer realistischer Text — keine Lang-Payloads.
FIVE_AXES='{"mandate":"Rebalance the EUR ops buffer","proposed_action":"Move 12k EUR from reserve to ops","reasoning":"Ops account is below the 30-day runway threshold","context":"Monthly treasury routine","axes":["intent","scope","risk","consistency","reversibility"],"sandbox":false}'

# §3a-Erwartungen pro Szenario (E1) — D4 hat seine eigene Regel im Preflight.
# S2: voller deterministischer Redacted-Fingerprint je Szenario (statt Feld-Auswahl) —
# nicht deterministisch und daher bewusst NICHT asserted: version, config_schema_version,
# commit_sha (separat gegen EXPECTED_DEPLOYED_SHA), config_hash (S1: Präsenz),
# provider_endpoint_id (S1: Präsenz), required_healthy_alias_fraction, timestamp.
ON_EXPECT='{"status":"ok","service":"decision-quality-layer","runtime_mode":"pot-cli","active_cascade":"pot-cli","v0431_active":true,"diagnostics_on":true,"capital_path_mode":true,"disable_circuit_breaker":false,"serv_api_key_bound":true,"alias_gate_ready":true}'

# G4: Szenarioprofile — vollständige Pflicht-Schalter + strukturierte CB-Prüfung.
ON_REQ='"DQL_CASCADE":"pot-cli","DQL_V0431_ACTIVE":"1","DQL_RUNTIME_DIAGNOSTICS":"1","DQL_CAPITAL_PATH_MODE":"1","SERV_API_KEY_BOUND":"true"'
ON_PROFILE='{"required":{'"$ON_REQ"'},"secret_version":true,"cb":{"mode":"active_full"}}'
D2B_PROFILE='{"required":{"DQL_CASCADE":"pot-cli","DQL_V0431_ACTIVE":"0","DQL_RUNTIME_DIAGNOSTICS":"1","DQL_CAPITAL_PATH_MODE":"1","SERV_API_KEY_BOUND":"true"},"secret_version":true,"cb":{"mode":"active_full"}}'
# D4: der Defekt ist maschinenlesbar festgelegt — serv-swift ohne minSamples (ACTIVE verlangt es explizit).
D4_PROFILE='{"required":{'"$ON_REQ"'},"secret_version":true,"cb":{"mode":"defect","defect_alias":"serv-swift","defect_missing":"minSamples"}}'
# D5: volles ON-Profil + Disable-Wert + aggressive CB-Werte für BEIDE Aliases (minSamples=1, tripP90LatencyMs=1).
D5C_PROFILE='{"required":{'"$ON_REQ"',"DQL_DISABLE_CIRCUIT_BREAKER":"0"},"secret_version":true,"cb":{"mode":"aggressive"}}'
D5D_PROFILE='{"required":{'"$ON_REQ"',"DQL_DISABLE_CIRCUIT_BREAKER":"1"},"secret_version":true,"cb":{"mode":"aggressive"}}'

# F2/E4/§2b: D5-Paar-Gleichheitsbeweis VOR jedem Verify-POST — strikter Parser statt grep-Diff:
# genau eine Disable-Zeile je Manifest mit exakt 0 (control) bzw. 1 (disabled), Duplicate Keys
# abgelehnt, Secret-Metadaten explizit, Rest identisch. config_hash ist KEIN Gleichheitsbeweis.
python3 - "${ENVM[D5_control]}" "${ENVM[D5_disabled]}" <<'PY'
import sys
def parse(p):
    kv = {}
    for i, line in enumerate(open(p), 1):
        line = line.strip()
        if not line or line.startswith('#'): continue
        if '=' not in line: sys.exit(f"F2 FAIL {p}:{i}: keine KEY=VALUE-Zeile")
        k, v = line.split('=', 1)
        if k in kv: sys.exit(f"F2 FAIL {p}: Duplicate Key {k}")
        kv[k] = v
    return kv
c, d = parse(sys.argv[1]), parse(sys.argv[2])
def req(kv, p, k, want=None):
    if k not in kv: sys.exit(f"F2 FAIL {p}: {k} fehlt")
    if want is not None and kv[k] != want:
        sys.exit(f"F2 FAIL {p}: {k}={kv[k]!r}, erwartet {want!r}")
req(c, sys.argv[1], "DQL_DISABLE_CIRCUIT_BREAKER", "0")   # control: exakt 0
req(d, sys.argv[2], "DQL_DISABLE_CIRCUIT_BREAKER", "1")   # disabled: exakt 1
for kv, p in ((c, sys.argv[1]), (d, sys.argv[2])):
    req(kv, p, "SERV_API_KEY_BOUND", "true")
    req(kv, p, "SERV_API_KEY_SECRET_VERSION")             # nicht-geheime ID, Präsenz Pflicht
if c["SERV_API_KEY_SECRET_VERSION"] != d["SERV_API_KEY_SECRET_VERSION"]:
    sys.exit("F2 FAIL: SERV_API_KEY_SECRET_VERSION differiert")
strip = lambda kv: {k: v for k, v in kv.items() if k != "DQL_DISABLE_CIRCUIT_BREAKER"}
if strip(c) != strip(d):
    diff = sorted(k for k in set(c) | set(d)
                  if k != "DQL_DISABLE_CIRCUIT_BREAKER" and c.get(k) != d.get(k))
    sys.exit(f"E4 FAIL: D5-Manifeste differieren jenseits des Disable-Flags: {diff}")
PY

do_call D0_stub            "${URLS[D0_stub]}"            "$SMALL" \
  '{"status":"ok","service":"decision-quality-layer","runtime_mode":"stub","active_cascade":"stub","alias_gate_ready":false}' \
  '{"required":{"DQL_CASCADE":"stub"}}'
do_call D1_baseline        "${URLS[D1_baseline]}"        "$SMALL" \
  '{"status":"ok","service":"decision-quality-layer","runtime_mode":"pot-cli","active_cascade":"pot-cli","v0431_active":false,"diagnostics_on":false,"capital_path_mode":true,"disable_circuit_breaker":false,"serv_api_key_bound":true,"alias_gate_ready":false}' \
  '{"required":{"DQL_CASCADE":"pot-cli","DQL_V0431_ACTIVE":"0","DQL_RUNTIME_DIAGNOSTICS":"0","DQL_CAPITAL_PATH_MODE":"1","SERV_API_KEY_BOUND":"true"},"secret_version":true}'
do_call D2_on_small        "${URLS[D2_on_small]}"        "$SMALL"     "$ON_EXPECT" "$ON_PROFILE"
do_call D2b_active0_diag1  "${URLS[D2b_active0_diag1]}"  "$SMALL" \
  '{"status":"ok","service":"decision-quality-layer","runtime_mode":"pot-cli","active_cascade":"pot-cli","v0431_active":false,"diagnostics_on":true,"capital_path_mode":true,"disable_circuit_breaker":false,"serv_api_key_bound":true,"alias_gate_ready":false}' \
  "$D2B_PROFILE"
do_call D2c_sandbox_diag   "${URLS[D2c_sandbox_diag]}"   "$SANDBOX"   "$ON_EXPECT" "$ON_PROFILE"
do_call D3_natural_load    "${URLS[D3_natural_load]}"    "$FIVE_AXES" "$ON_EXPECT" "$ON_PROFILE"
# D4: der Config-Bruch steckt IM WERT von DQL_CB_CONFIG_BY_ALIAS (serv-swift ohne minSamples) —
# die Schalter selbst sind wie D2; das Profil prüft den Defekt maschinenlesbar (G4).
do_call D4_invalid_config  "${URLS[D4_invalid_config]}"  "$SMALL"     '{}' "$D4_PROFILE"
# E3: die beiden D5-Calls müssen die ERSTEN Verify-POSTs auf frischen D5-Deploys sein.
# Bei Wiederholung: neue Deploys erzeugen — nie gegen dieselben D5-URLs erneut posten.
do_call D5_control         "${URLS[D5_control]}"         "$SMALL" \
  '{"status":"ok","service":"decision-quality-layer","runtime_mode":"pot-cli","active_cascade":"pot-cli","v0431_active":true,"diagnostics_on":true,"capital_path_mode":true,"disable_circuit_breaker":false,"serv_api_key_bound":true,"alias_gate_ready":true}' \
  "$D5C_PROFILE"
do_call D5_disabled        "${URLS[D5_disabled]}"        "$SMALL" \
  '{"status":"ok","service":"decision-quality-layer","runtime_mode":"pot-cli","active_cascade":"pot-cli","v0431_active":true,"diagnostics_on":true,"capital_path_mode":true,"disable_circuit_breaker":true,"serv_api_key_bound":true,"alias_gate_ready":false}' \
  "$D5D_PROFILE"
do_call D6_invalid_key     "${URLS[D6_invalid_key]}"     "$SMALL"     "$ON_EXPECT" "$ON_PROFILE"

# F4/H1–H3: PASS setzt Verifier-Exit 0 voraus — inkl. Hash-Verifikation und Verdict-Datei.
D6_FORBIDDEN_TOKEN="$D6_KEY_MARKER" EXPECTED_DEPLOYED_SHA="$EXPECTED_DEPLOYED_SHA" \
  node "$SCRIPT_DIR/verify-drill-headers.mjs" "$OUT"
```

Danach läuft `scripts/verify-drill-headers.mjs` — offline reproduzierbar, **Verifier statt Logger** (F4): alle §4-/§6-Assertions sind ausführbarer Code mit non-zero Exit bei jeder Vertragsabweichung. Neu in v8: atomarer Verdict-Write, Schreibfehler = FAIL (K1), geschlossene Snapshot-Top-Level- und Wrapper-Keys (K2), Präsenz-Semantik für Vertragsheader (K3), Header-Multimap + Singleton-Regel (K4), requestId-Provenienz aller Attempt-/Summary-Items + kausale D5-Trip-Korrelation (K5), inhaltliche D4-Reason-Prüfung (K6) und exakte 8er-`sha256.txt`-Liste ohne Duplikate/Extras (S3):

```js
// scripts/verify-drill-headers.mjs — ausführbarer Offline-Verifier (v10: v9 + Hermes-v9-Holds — target:null, closed-set Inspect/Request, strikter D5-Env-Parser, korrelierte Success-Bindings).
// Aufruf: D6_FORBIDDEN_TOKEN='<marker>' EXPECTED_DEPLOYED_SHA='<sha>' node verify-drill-headers.mjs drill-runs/<timestamp>
// Exitcode != 0 bei JEDER Vertragsabweichung — inklusive nicht schreibbarem Verdict (K1).
import { readFileSync, readdirSync, statSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

const dir = process.argv[2];
// SM-V1 (Steelman): Arg-Validierung — ein fehlendes/kaputtes Run-Verzeichnis endet als
// klarer FATAL (Exit 1), nicht als roher Stacktrace ohne Diagnose.
if (!dir || !existsSync(dir) || !statSync(dir).isDirectory()) {
  console.error(`FATAL SM-V1: Run-Verzeichnis fehlt oder ist kein Verzeichnis: '${dir ?? ''}'`);
  process.exit(1);
}
const D6_TOKEN = process.env.D6_FORBIDDEN_TOKEN ?? '';
// SM-V2: dieselbe fixe Code-Basis wie im Runner — manifest.txt wird offline gegengeprüft.
const BASE_CODE_SHA = 'd7a8ff67ae5b11819ee2c5c8db4223f76f0e7a86';
// V9 (Hermes v8 HOLD 2): expliziter Verifier-Input — die SHA-Bindung wird offline ERNEUT
// geprüft, nicht dem Runner-Preflight geglaubt. Ohne Input keine beweisbare Bindung.
const EXPECTED_SHA = process.env.EXPECTED_DEPLOYED_SHA ?? '';
if (!EXPECTED_SHA) {
  console.error('FATAL V9-H: EXPECTED_DEPLOYED_SHA nicht gesetzt — SHA-Bindung offline nicht beweisbar');
  process.exit(1);
}
// G3: bekannte Provider-Body-Marker — im Drill-Setup erweiterbar (kommasepariert).
const PROVIDER_MARKERS = (process.env.D6_PROVIDER_MARKERS ??
  'Unauthorized,invalid api,invalid_api_key,incorrect API key')
  .split(',').map(s => s.trim()).filter(Boolean);

const KNOWN = new Set(['D0_stub', 'D1_baseline', 'D2_on_small', 'D2b_active0_diag1',
  'D2c_sandbox_diag', 'D3_natural_load', 'D4_invalid_config',
  'D5_control', 'D5_disabled', 'D6_invalid_key']);
const STREAMS = ['transitions', 'stale_results', 'invalid_outcomes', 'attempts', 'binding_summaries'];
const CATEGORIES = new Set(['timeout', 'rate_limit', 'network', 'server_5xx', 'client_4xx', 'parse', 'other']);
const ROUTES = new Set(['primary', 'fallback']);
// H1: Hashprüfung ist Bestandteil von PASS — alle neun Artefakte müssen gelistet sein und stimmen.
const ARTIFACTS = ['health.json', 'health_status', 'env-manifest.txt', 'manifest.txt',
  'request.json', 'headers', 'body.json', 'curl_exit', 'vercel-inspect.json'];
// G3: keine freien Fehlertext-Felder irgendwo im Diagnostics-Snapshot.
const FORBIDDEN_KEYS = new Set(['error', 'message', 'details', 'response', 'body', 'stack']);
// SM-V3: geschlossene Response-Schemata (d7a8ff6: src/engine/index.ts baut die 200-Antwort
// ausschließlich aus Objekt-Literalen — top-level exakt {id, version, axes, aggregate, meta}).
const AXES5 = ['intent', 'scope', 'risk', 'consistency', 'reversibility'];
const AXIS_SET = new Set(AXES5);
const AXIS_VERDICTS = new Set(['PASS', 'FAIL', 'UNCERTAIN']);
const AGG_VERDICTS = new Set(['ALLOW', 'BLOCK', 'REVIEW']);
const PROVIDER_OUTCOMES = new Set(['served', 'circuit_rejected', 'provider_error']);
const MANIFEST_KEYS = ['url', 'deployment_id', 'base_code_sha', 'deployed_sha',
  'config_hash', 'provider_endpoint_id', 'utc'];
// V9 (HOLD 2): Health-Erwartungsmatrix — identisch zur Runner-Preflight-Matrix (§3a/§4).
// Der Offline-Verifier rechnet die archivierte health.json ERNEUT gegen das Szenario.
const H_COMMON = { status: 'ok', service: 'decision-quality-layer' };
const H_ON = { ...H_COMMON, runtime_mode: 'pot-cli', active_cascade: 'pot-cli',
  v0431_active: true, diagnostics_on: true, capital_path_mode: true,
  disable_circuit_breaker: false, serv_api_key_bound: true, alias_gate_ready: true };
const HEALTH_EXPECT = {
  D0_stub: { ...H_COMMON, runtime_mode: 'stub', active_cascade: 'stub', alias_gate_ready: false },
  D1_baseline: { ...H_COMMON, runtime_mode: 'pot-cli', active_cascade: 'pot-cli',
    v0431_active: false, diagnostics_on: false, capital_path_mode: true,
    disable_circuit_breaker: false, serv_api_key_bound: true, alias_gate_ready: false },
  D2_on_small: H_ON,
  D2b_active0_diag1: { ...H_ON, v0431_active: false, alias_gate_ready: false },
  D2c_sandbox_diag: H_ON,
  D3_natural_load: H_ON,
  D5_control: H_ON,
  D5_disabled: { ...H_ON, disable_circuit_breaker: true, alias_gate_ready: false },
  D6_invalid_key: H_ON,
};
// V9 (HOLD 2): Request-Erwartung je Szenario (§4) — request.json ist Teil der Beweiskette.
const REQ_EXPECT = {
  D2c_sandbox_diag: { axes: ['intent'], sandbox: true },
  D3_natural_load: { axes: null /* AXES5, s. u. */, sandbox: false },
};
// V10 (Hermes v9 HOLD 2a): GESCHLOSSENER Request-Vergleich — request.json muss BYTE-EXAKT
// der Runner-Payload des Szenarios entsprechen (§4). Damit ist die gesamte Key-Menge
// (mandate/proposed_action/reasoning/context/Zusatzfelder) gedeckt, nicht nur axes+sandbox:
// ein ausgetauschter Stimulus mit korrekten axes/sandbox ist FAIL, nicht PASS.
const REQ_SMALL = '{"mandate":"m","proposed_action":"a","reasoning":"r","axes":["intent"],"sandbox":false}';
const REQ_SANDBOX = '{"mandate":"m","proposed_action":"a","reasoning":"r","axes":["intent"],"sandbox":true}';
const REQ_FIVE_AXES = '{"mandate":"Rebalance the EUR ops buffer","proposed_action":"Move 12k EUR from reserve to ops","reasoning":"Ops account is below the 30-day runway threshold","context":"Monthly treasury routine","axes":["intent","scope","risk","consistency","reversibility"],"sandbox":false}';
const REQ_RAW = {
  D2c_sandbox_diag: REQ_SANDBOX,
  D3_natural_load: REQ_FIVE_AXES,
};   // alle übrigen Szenarien: REQ_SMALL
// V9 (HOLD 3): Szenarien mit live erreichbarem Provider-Pfad — dort erzeugt
// runVerification() IMMER einen nichtleeren callId je Achse (engine/index.ts);
// Abwesenheit ist keine zulässige Variante, sondern eine Provenienzverletzung.
const LIVE = new Set(['D2_on_small', 'D2b_active0_diag1', 'D3_natural_load',
  'D5_control', 'D5_disabled', 'D6_invalid_key']);

let failures = 0;
const perScenario = new Map();
const d5raw = new Map();   // V9 (HOLD 2): Roh-Artefakte für die D5-Paarprüfung nach der Schleife
const notes = [];
const fail = (s, m) => { failures++; perScenario.set(s, (perScenario.get(s) ?? 0) + 1); console.error(`FAIL ${s}: ${m}`); };

// --- Typprüfer ------------------------------------------------------------
const T = {
  str: v => typeof v === 'string',
  num: v => typeof v === 'number' && Number.isFinite(v),
  int0: v => Number.isInteger(v) && v >= 0,
  int1: v => Number.isInteger(v) && v >= 1,
  bool: v => typeof v === 'boolean',
};

// --- V10 (Hermes v9 Rest-HOLD 3): Erfolg ist ein KORRELIERTES Attempt/Summary-Paar ------
// Koexistenz (irgendein ok-Attempt + irgendeine ok-Summary) reicht nicht: beide müssen
// dieselbe nichtleere callId tragen und in axis, requestId, requestedAlias und route
// übereinstimmen — sonst ist der „Erfolg“ aus zwei unzusammenhängenden Events collagiert.
const hasCorrelatedSuccessfulBinding = snap =>
  !!snap?.attempts?.items.some(a => a.ok === true
    && T.str(a.callId) && a.callId !== ''
    && snap.binding_summaries.items.some(b => b.ok === true
      && b.callId === a.callId && b.axis === a.axis && b.requestId === a.requestId
      && b.requestedAlias === a.requestedAlias && b.route === a.route));

// --- G2/G3: geschlossene Item-Schemata (exakte Key-Mengen, Enums, Typen) ---
function checkKeys(scn, ctx, item, required, optional) {
  const allowed = new Set([...Object.keys(required), ...Object.keys(optional)]);
  for (const k of Object.keys(item)) if (!allowed.has(k)) fail(scn, `${ctx}: unerlaubter Key '${k}'`);
  for (const [k, t] of Object.entries(required))
    if (!t(item[k])) fail(scn, `${ctx}: Feld '${k}' fehlt oder hat falschen Typ/Wert`);
  for (const [k, t] of Object.entries(optional))
    if (k in item && !t(item[k])) fail(scn, `${ctx}: optionales Feld '${k}' hat falschen Typ`);
}
const inSet = set => v => set.has(v);
const eq = want => v => v === want;

function checkAttempt(scn, i, a) {
  checkKeys(scn, `attempts[${i}]`, a, {
    requestId: T.str, requestedAlias: T.str, attemptAlias: T.str,
    route: inSet(ROUTES), iteration: T.int1, ok: T.bool, elapsedMs: T.num,
  }, { axis: T.str, callId: T.str, errorCategory: inSet(CATEGORIES) });
  if (a.ok === false && !CATEGORIES.has(a.errorCategory))
    fail(scn, `attempts[${i}]: ok=false ohne gültige errorCategory`);
  if (a.ok === true && 'errorCategory' in a)
    fail(scn, `attempts[${i}]: errorCategory präsent trotz ok=true (Vertrag: absent)`);
}
function checkSummary(scn, i, b) {
  checkKeys(scn, `binding_summaries[${i}]`, b, {
    requestId: T.str, requestedAlias: T.str, attemptAlias: T.str,
    route: inSet(ROUTES), ok: T.bool, netLatencyMs: T.num,
    backoffWaitedMs: T.num, wallClockMs: T.num, attemptCount: T.int1,
  }, { axis: T.str, callId: T.str });
}
const TRANSITION_SPECS = {
  closed_to_open: {
    required: { kind: eq('closed_to_open'), reason: inSet(new Set(['failure_rate', 'latency'])), alias: T.str, from: eq('CLOSED'), to: eq('OPEN'), at: T.int0, tripGeneration: T.int0, stateRevision: T.int0 },
  },
  open_to_half_open: {
    required: { kind: eq('open_to_half_open'), alias: T.str, from: eq('OPEN'), to: eq('HALF_OPEN'), at: T.int0, tripGeneration: T.int0, recoveryEpoch: T.int0, probeSequence: T.int0, stateRevision: T.int0 },
  },
  half_open_to_open: {
    required: { kind: eq('half_open_to_open'), reason: inSet(new Set(['probe_failed', 'probe_slow'])), alias: T.str, from: eq('HALF_OPEN'), to: eq('OPEN'), at: T.int0, tripGeneration: T.int0, recoveryEpoch: T.int0, probeSequence: T.int0, stateRevision: T.int0 },
  },
  half_open_to_closed: {
    required: { kind: eq('half_open_to_closed'), alias: T.str, from: eq('HALF_OPEN'), to: eq('CLOSED'), at: T.int0, tripGeneration: T.int0, recoveryEpoch: T.int0, probeSequence: T.int0, closedEpoch: T.int0, stateRevision: T.int0 },
  },
};
function checkTransition(scn, i, t) {
  const spec = TRANSITION_SPECS[t?.kind];
  if (!spec) { fail(scn, `transitions[${i}]: unbekannter kind '${t?.kind}'`); return; }
  checkKeys(scn, `transitions[${i}]`, t, spec.required, {});
}
function checkStale(scn, i, e) {
  checkKeys(scn, `stale_results[${i}]`, e, {
    kind: eq('stale_result'),
    reason: inSet(new Set(['invalid_token', 'already_consumed', 'wrong_state', 'wrong_epoch', 'wrong_generation'])),
    alias: T.str, at: T.int0, stateRevision: T.int0,
  }, {});
}
function checkInvalid(scn, i, e) {
  checkKeys(scn, `invalid_outcomes[${i}]`, e, {
    kind: eq('invalid_outcome'),
    reason: inSet(new Set(['nan_latency', 'infinite_latency', 'negative_latency'])),
    alias: T.str, at: T.int0, stateRevision: T.int0,
  }, {});
}
function scanForbiddenKeys(scn, node, path) {
  if (Array.isArray(node)) { node.forEach((v, i) => scanForbiddenKeys(scn, v, `${path}[${i}]`)); return; }
  if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      if (FORBIDDEN_KEYS.has(k)) fail(scn, `G3: verbotener Freitext-Key '${k}' unter ${path}`);
      scanForbiddenKeys(scn, v, `${path}.${k}`);
    }
  }
}

// --- G1: Counts-Header exakt gegen den d7a8ff6-Wire-Vertrag ---------------
// verify.ts emittiert: { <fünf Streams>: retainedCount, dropped: { <fünf Streams>: droppedCount } }
function checkCounts(scn, countsRaw) {
  let c;
  try { c = JSON.parse(countsRaw); } catch { fail(scn, 'Counts-Header kein JSON'); return; }
  if (c === null || typeof c !== 'object' || Array.isArray(c)) { fail(scn, 'Counts-Header kein Objekt'); return; }
  const wantTop = JSON.stringify([...STREAMS, 'dropped'].sort());
  if (JSON.stringify(Object.keys(c).sort()) !== wantTop)
    fail(scn, `Counts-Top-Keys ${JSON.stringify(Object.keys(c).sort())} ≠ Vertrag (fünf Streams + dropped)`);
  for (const s of STREAMS)
    if (!T.int0(c?.[s])) fail(scn, `Counts.${s} kein Integer >= 0`);
  const d = c?.dropped;
  if (d === null || typeof d !== 'object' || Array.isArray(d)) { fail(scn, 'Counts.dropped kein Objekt'); return; }
  if (JSON.stringify(Object.keys(d).sort()) !== JSON.stringify([...STREAMS].sort()))
    fail(scn, 'Counts.dropped-Keys ≠ exakt die fünf Streams');
  for (const s of STREAMS)
    if (!T.int0(d?.[s])) fail(scn, `Counts.dropped.${s} kein Integer >= 0`);
}

// --- SM-V3: geschlossener 200-Body — DqlResponse aus src/types.ts + engine/index.ts ---
// Bewusst NICHT geprüft: Inhalte von reasoning/objection (dürfen Providertext tragen —
// die No-Leak-Invariante gilt nur für Diagnostics-Felder), version-Wert, Zahlenwerte.
const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const arrOf = t => v => Array.isArray(v) && v.every(t);
function checkDqlResponse(scn, body, reqRaw) {
  if (!isObj(body)) { fail(scn, 'SM-V3: 200-Body kein Objekt'); return; }
  checkKeys(scn, 'body', body, {
    id: T.str, version: T.str, axes: v => Array.isArray(v), aggregate: isObj, meta: isObj,
  }, {});
  if (isObj(body.meta))
    checkKeys(scn, 'body.meta', body.meta, {
      duration_ms: T.int0, models_used: arrOf(T.str),
      axes_evaluated: arrOf(v => AXIS_SET.has(v)), sandbox: T.bool,
    }, {});
  if (isObj(body.aggregate))
    checkKeys(scn, 'body.aggregate', body.aggregate, {
      verdict: inSet(AGG_VERDICTS), confidence: T.num,
      triggered_by: arrOf(v => AXIS_SET.has(v)), rationale: T.str,
    }, {});
  (Array.isArray(body.axes) ? body.axes : []).forEach((a, i) => isObj(a)
    ? checkKeys(scn, `body.axes[${i}]`, a, {
        axis: inSet(AXIS_SET), verdict: inSet(AXIS_VERDICTS), confidence: T.num,
        reasoning: T.str, objection: T.str,
      }, { provider_route: inSet(ROUTES), provider_outcome: inSet(PROVIDER_OUTCOMES) })
    : fail(scn, `SM-V3: body.axes[${i}] kein Objekt`));
  // Kreuzbezüge zur archivierten Anfrage: meta.sandbox spiegelt request.sandbox (Default
  // false); axes_evaluated und die Achsen-Reihenfolge der Ergebnisse sind exakt die
  // Request-Achsen (engine/index.ts übernimmt request.axes in Originalreihenfolge).
  let req = null;
  try { req = JSON.parse(reqRaw); } catch { fail(scn, 'SM-V3: request.json kein JSON'); }
  if (isObj(req)) {
    const wantSandbox = req.sandbox === true;
    if (isObj(body.meta) && body.meta.sandbox !== wantSandbox)
      fail(scn, `SM-V3: meta.sandbox=${body.meta.sandbox} ≠ request.sandbox=${wantSandbox}`);
    const wantAxes = JSON.stringify(Array.isArray(req.axes) ? req.axes : AXES5);
    if (isObj(body.meta) && JSON.stringify(body.meta.axes_evaluated) !== wantAxes)
      fail(scn, 'SM-V3: meta.axes_evaluated ≠ request.axes');
    if (Array.isArray(body.axes) && JSON.stringify(body.axes.map(a => a?.axis)) !== wantAxes)
      fail(scn, 'SM-V3: axes[].axis ≠ request.axes (Reihenfolge ist Teil des Ist-Vertrags)');
  }
}

// --- V9 (HOLD 2): health.json semantisch gegen die Szenario-Matrix prüfen -------------
function checkHealth(scn, h) {
  if (!isObj(h)) { fail(scn, 'V9-H: health.json kein Objekt'); return; }
  // E2 offline: SHA-Bindung gegen den EXPLIZITEN Verifier-Input — auch für D4 (503 trägt commit_sha).
  if ((h.commit_sha ?? '') !== EXPECTED_SHA)
    fail(scn, `V9-H: health.commit_sha=${JSON.stringify(h.commit_sha)} ≠ EXPECTED_DEPLOYED_SHA`);
  if (scn === 'D4_invalid_config') {
    if (h.status !== 'config_invalid' || h.code !== 'CONFIG_INVALID' || !Array.isArray(h.reasons))
      fail(scn, 'V9-H: D4-Health-503-Regel verletzt (status/code/reasons[])');
    else if (h.reasons.length === 0) fail(scn, 'V9-H/K6: health.reasons[] leer');
    else for (const r of h.reasons)
      if (typeof r !== 'string' || !r.includes('serv-swift') || !r.includes('minSamples'))
        fail(scn, `V9-H/K6: Health-Reason nicht dem D4-Defekt zuordenbar: '${String(r).slice(0, 120)}'`);
    return;
  }
  for (const [k, v] of Object.entries(HEALTH_EXPECT[scn] ?? {}))
    if (h[k] !== v) fail(scn, `V9-H: health.${k}=${JSON.stringify(h[k])} ≠ ${JSON.stringify(v)}`);
  if (!h.config_hash) fail(scn, 'V9-H/S1: health.config_hash fehlt/leer');
  if (!h.provider_endpoint_id) fail(scn, 'V9-H/S1: health.provider_endpoint_id fehlt/leer');
}

// --- V9 (HOLD 2) + V10 (HOLD 2a): request.json gegen die Szenario-Erwartung prüfen -----
function checkRequest(scn, raw) {
  const wantRaw = REQ_RAW[scn] ?? REQ_SMALL;
  if (raw !== wantRaw)
    fail(scn, `V10-R: request.json nicht byte-identisch zur Szenario-Payload (§4) — ${raw.length} Bytes, erwartet ${wantRaw.length} Bytes`);
  let req = null;
  try { req = JSON.parse(raw); } catch { fail(scn, 'V9-R: request.json kein JSON'); return null; }
  if (!isObj(req)) { fail(scn, 'V9-R: request.json kein Objekt'); return null; }
  const want = REQ_EXPECT[scn] ?? { axes: ['intent'], sandbox: false };
  const wantAxes = want.axes ?? AXES5;
  if (JSON.stringify(req.axes ?? null) !== JSON.stringify(wantAxes))
    fail(scn, `V9-R: request.axes=${JSON.stringify(req.axes)} ≠ Szenario-Erwartung ${JSON.stringify(wantAxes)}`);
  if ((req.sandbox === true) !== want.sandbox)
    fail(scn, `V9-R: request.sandbox=${JSON.stringify(req.sandbox)} ≠ Szenario-Erwartung ${want.sandbox}`);
  return req;
}

// --- V9 (HOLD 1) + V10 (Hermes v9 HOLD 1/Security): vercel-inspect.json prüfen ---------
// v13-Ist-Vertrag (live verifiziert): Preview = target:null — 'preview' existiert nicht.
// Das Artefakt ist das vom Runner REDUZIERTE 4-Key-Objekt; jede Zusatz-Key-Menge (z. B.
// env/build/git der vollen Owner-Antwort) ist selbst ein FAIL (geschlossenes Schema).
function checkInspect(scn, raw, man) {
  let ins = null;
  try { ins = JSON.parse(raw); } catch { fail(scn, 'V9-K7: vercel-inspect.json kein JSON'); return; }
  if (!isObj(ins)) { fail(scn, 'V9-K7: Inspect-Artefakt kein Objekt'); return; }
  const keys = JSON.stringify(Object.keys(ins).sort());
  if (keys !== '["id","readyState","target","url"]')
    fail(scn, `V10-K7: Inspect-Artefakt-Keys ${keys} ≠ exakt {id,url,target,readyState}`);
  let host = '';
  try { host = new URL(man?.url ?? '').hostname.toLowerCase(); } catch { /* SM-V2 failt bereits */ }
  if (ins.id !== (man?.deployment_id ?? '')) fail(scn, `V9-K7: inspect.id=${JSON.stringify(ins.id)} ≠ manifest.deployment_id`);
  if ((ins.url ?? '').toLowerCase() !== host) fail(scn, `V9-K7: inspect.url=${JSON.stringify(ins.url)} ≠ manifest-URL-Host '${host}'`);
  if (!('target' in ins) || ins.target !== null)
    fail(scn, `V10-K7: target=${'target' in ins ? JSON.stringify(ins.target) : 'FEHLT'} ≠ null (v13-Vertrag: null = Preview)`);
  if (ins.readyState !== 'READY') fail(scn, `V9-K7: readyState=${JSON.stringify(ins.readyState)} ≠ 'READY'`);
}

// --- SM-V2: manifest.txt offline gegenprüfen — Runner-Behauptungen sind nachrechenbar --
// deployment_id/url-Eindeutigkeit macht K7 offline reproduzierbar (aus den Artefakten,
// nicht nur aus dem Runner-Preflight); SHA-/Fingerprint-Felder müssen health.json spiegeln.
const seenManUrls = new Map(), seenManIds = new Map();
function checkManifest(scn, raw, health) {
  const kv = {};
  for (const [i, line] of raw.split('\n').entries()) {
    const s = line.trim();
    if (!s) continue;
    const eq = s.indexOf('=');
    if (eq === -1) { fail(scn, `SM-V2: manifest.txt Zeile ${i + 1} ohne '='`); continue; }
    const k = s.slice(0, eq);
    if (k in kv) { fail(scn, `SM-V2: manifest.txt Duplicate Key '${k}'`); continue; }
    kv[k] = s.slice(eq + 1);
  }
  if (JSON.stringify(Object.keys(kv).sort()) !== JSON.stringify([...MANIFEST_KEYS].sort()))
    fail(scn, `SM-V2: manifest.txt-Keys ${JSON.stringify(Object.keys(kv).sort())} ≠ Vertrag (${MANIFEST_KEYS.length} Felder)`);
  if (kv.base_code_sha !== BASE_CODE_SHA) fail(scn, `SM-V2: base_code_sha '${kv.base_code_sha}' ≠ approved Code-Basis`);
  if (!kv.deployment_id) fail(scn, 'SM-V2: deployment_id leer');
  else if (seenManIds.has(kv.deployment_id)) fail(scn, `SM-V2/K7: deployment_id auch in ${seenManIds.get(kv.deployment_id)} — Deploy-Isolation verletzt`);
  else seenManIds.set(kv.deployment_id, scn);
  let host = '';
  try { host = new URL(kv.url ?? '').hostname.toLowerCase(); } catch { fail(scn, `SM-V2: url unparsebar: '${kv.url}'`); }
  if (host) {
    if (!(kv.url ?? '').startsWith('https://') || !host.endsWith('.vercel.app') || host.includes('-git-'))
      fail(scn, `SM-V2/K7: url '${kv.url}' ist kein immutable https-*.vercel.app-Deployment`);
    if (seenManUrls.has(host)) fail(scn, `SM-V2/K7: url-Host auch in ${seenManUrls.get(host)} — Deploy-Isolation verletzt`);
    else seenManUrls.set(host, scn);
  }
  if (isObj(health)) {
    if ((kv.deployed_sha ?? '') !== (health.commit_sha ?? '')) fail(scn, 'SM-V2: deployed_sha ≠ health.commit_sha');
    if ((kv.config_hash ?? '') !== (health.config_hash ?? '')) fail(scn, 'SM-V2: config_hash ≠ health.config_hash');
    if ((kv.provider_endpoint_id ?? '') !== (health.provider_endpoint_id ?? '')) fail(scn, 'SM-V2: provider_endpoint_id ≠ health.provider_endpoint_id');
  }
  // V9 (HOLD 2): deployed_sha zusätzlich gegen den expliziten Verifier-Input.
  if ((kv.deployed_sha ?? '') !== EXPECTED_SHA) fail(scn, 'V9-H: manifest.deployed_sha ≠ EXPECTED_DEPLOYED_SHA');
  return kv;
}

// --- H1: sha256.txt verifizieren (Node-seitig, keine Toolchain-Annahme) ----
function checkHashes(scn, read) {
  const listed = new Map();
  for (const line of read('sha256.txt').split('\n').filter(Boolean)) {
    const m = line.match(/^([0-9a-f]{64})\s[\s*](.+)$/);
    if (!m) { fail(scn, `sha256.txt: unparsebare Zeile '${line}'`); continue; }
    if (listed.has(m[2])) { fail(scn, `sha256.txt: Duplikat-Eintrag für '${m[2]}'`); continue; }
    listed.set(m[2], m[1]);
  }
  // S3/v9: exakt die neun Artefakte — Extra-Einträge machen den Artefakt-Vertrag offen.
  for (const f of listed.keys())
    if (!ARTIFACTS.includes(f)) fail(scn, `sha256.txt: unerwarteter Eintrag '${f}' — Vertrag: exakt die neun Artefakte`);
  for (const f of ARTIFACTS) {
    if (!listed.has(f)) { fail(scn, `sha256.txt: Artefakt '${f}' nicht gelistet`); continue; }
    const h = createHash('sha256').update(readFileSync(join(dir, scn, f))).digest('hex');
    if (h !== listed.get(f)) fail(scn, `Hash-Mismatch für '${f}' — Artefakt nach dem Hashen verändert`);
  }
}

// --- Hauptschleife ---------------------------------------------------------
const entries = readdirSync(dir).filter(e => statSync(join(dir, e)).isDirectory());
// verifier-verdict.txt(.tmp) sind verifier-eigene ROOT-Artefakte, keine Szenarien —
// ein Verzeichnis-Squat auf diesen Namen failt über K1 (Verdict nicht schreibbar).
for (const e of entries)
  if (!KNOWN.has(e) && !/^verifier-verdict\.txt(\.tmp)?$/.test(e)) fail(e, 'unbekanntes Szenario-Verzeichnis');
for (const want of KNOWN) if (!entries.includes(want)) fail(want, 'Szenario-Artefakte fehlen');
if (!D6_TOKEN) fail('D6_invalid_key', 'D6_FORBIDDEN_TOKEN nicht gesetzt — No-Leak-Invariante nicht beweisbar (G3)');

for (const name of entries.filter(e => KNOWN.has(e))) {
 try {
  const read = f => readFileSync(join(dir, name, f), 'utf8');
  if (read('curl_exit').trim() !== '0') {          // INFRA_FAIL: kein Wire-Ergebnis
    fail(name, 'curl_exit != 0 — INFRA_FAIL, Szenario nicht wertbar'); continue;
  }
  checkHashes(name, read);                          // H1: Hashes sind Teil von PASS
  const healthStatus = read('health_status').trim();          // F1
  // SM-V2: manifest.txt gegen health.json — offline nachrechenbar statt Runner-Vertrauen.
  let healthBody = null;
  try { healthBody = JSON.parse(read('health.json')); } catch { fail(name, 'SM-V2: health.json kein JSON'); }
  const man = checkManifest(name, read('manifest.txt'), healthBody);
  checkHealth(name, healthBody);                    // V9 (HOLD 2): Szenario-Matrix + SHA-Input
  const reqParsed = checkRequest(name, read('request.json'));   // V9 (HOLD 2)
  checkInspect(name, read('vercel-inspect.json'), man);         // V9 (HOLD 1)
  if (name === 'D5_control' || name === 'D5_disabled')
    d5raw.set(name, { request: read('request.json'), env: read('env-manifest.txt') });
  const wantHealth = name === 'D4_invalid_config' ? '503' : '200';
  if (healthStatus !== wantHealth) fail(name, `health HTTP ${healthStatus}, erwartet ${wantHealth}`);

  // H2: genau EIN HTTP-Headerblock — Redirects/100-Continue sind Vertragsabweichungen.
  const raw = read('headers');
  const blocks = raw.split(/\r?\n\r?\n/).map(b => b.trim()).filter(b => /^HTTP\//.test(b));
  if (blocks.length !== 1) fail(name, `${blocks.length} HTTP-Headerblöcke — erwartet genau 1 (kein Redirect/100-Continue)`);
  const block = blocks[blocks.length - 1] ?? '';
  const status = Number(block.match(/^HTTP\/[\d.]+ (\d{3})/)?.[1] ?? NaN);
  // V9 (HOLD 4): die Statuszeile muss ein GÜLTIGER HTTP-Status sein — 'HTTP/WUT' → NaN
  // darf keine status!==503-Prüfung still passieren („nicht 503“ ist kein Beweis).
  if (!Number.isInteger(status) || status < 100 || status > 599)
    fail(name, `V9-S: Wire-Status unparsebar/ungültig — Statuszeile '${(block.split(/\r?\n/)[0] ?? '').trim()}'`);
  // K4: Multimap statt Object.fromEntries — Duplikate dürfen nicht stillschweigend
  // auf das letzte Vorkommen kollabieren (mehrdeutiger Wire darf nicht PASSen).
  const hmap = new Map();
  for (const l of block.split(/\r?\n/).slice(1)) {
    const i = l.indexOf(':');
    if (i === -1) { if (l.trim()) fail(name, `headers: Zeile ohne ':' — '${l.trim()}'`); continue; }
    const k = l.slice(0, i).trim().toLowerCase();
    hmap.set(k, [...(hmap.get(k) ?? []), l.slice(i + 1).trim()]);
  }
  // K4: Singleton-Vertragsheader — Duplikate sind FAIL, auch bei identischem Wert.
  const SINGLETONS = ['x-request-id', 'x-dql-version', 'x-dql-diagnostics',
    'x-dql-diagnostics-truncated', 'x-dql-diagnostics-counts'];
  for (const h of SINGLETONS)
    if ((hmap.get(h) ?? []).length > 1)
      fail(name, `K4: Header '${h}' ${hmap.get(h).length}x im Block — Singleton-Vertrag verletzt`);
  // K3: Präsenz = Key existiert (hasOwn-Semantik) — NICHT Truthiness. Ein präsenter,
  // aber leerer Vertragsheader ist eine Vertragsverletzung, kein "absent".
  const has = h => hmap.has(h);
  const val = h => (hmap.get(h) ?? [])[0];
  for (const h of SINGLETONS)
    if (has(h) && val(h) === '') fail(name, `K3: Header '${h}' präsent, aber leer`);
  const body = JSON.parse(read('body.json'));
  const diag = val('x-dql-diagnostics');
  const trunc = val('x-dql-diagnostics-truncated');
  const counts = val('x-dql-diagnostics-counts');
  const reqId = val('x-request-id');

  if (!has('x-dql-version')) fail(name, 'X-DQL-Version fehlt');
  if (!has('x-request-id') || !reqId?.startsWith('dql_')) fail(name, 'X-Request-Id fehlt/ohne dql_-Präfix'); // R3: kein Längen-Regex
  if (has('x-dql-diagnostics') && (has('x-dql-diagnostics-truncated') || has('x-dql-diagnostics-counts')))
    fail(name, 'Diagnostics und Truncated/Counts gleichzeitig');                       // paarweise Exklusivität
  if (has('x-dql-diagnostics-truncated') !== has('x-dql-diagnostics-counts'))
    fail(name, 'Truncated/Counts nicht paarweise');                                    // Präsenz-, nicht Wert-Paarung (K3)
  if (has('x-dql-diagnostics-truncated') && trunc !== '1') fail(name, `Truncated-Header '${trunc}' ≠ '1'`); // G1
  if (has('x-dql-diagnostics-counts')) checkCounts(name, counts);                                            // G1
  if (diag && Buffer.byteLength(diag, 'utf8') > 8192) fail(name, 'Diagnostics-Header > 8192 Bytes');
  if (status === 200 && body?.id !== reqId) fail(name, 'body.id != X-Request-Id');
  // SM-V3: jeder 200-Body ist eine GESCHLOSSENE DqlResponse — gilt auch für D6 (HTTP 200
  // mit UNCERTAIN-Achsen ist vertragskonform, S4). D4 (503) hat seine eigene Regel unten.
  if (status === 200) checkDqlResponse(name, body, read('request.json'));

  let snap = null;
  if (diag) { try { snap = JSON.parse(diag); } catch { fail(name, 'Diagnostics-Header kein JSON'); } }
  if (snap && (typeof snap !== 'object' || Array.isArray(snap))) { fail(name, 'Snapshot kein Objekt'); snap = null; }
  if (snap) {
    // K2: GESCHLOSSENER Snapshot — flush() in runtime-diagnostics.ts emittiert exakt
    // requestId + fünf Streams, jeder Wrapper exakt {items, dropped}. Freie Zusatzfelder
    // (z. B. debugText) sind Leak-Oberfläche und FAIL; Forbidden-Key-/Marker-Scan bleibt
    // als Defense-in-Depth zusätzlich bestehen.
    const wantSnap = JSON.stringify(['requestId', ...STREAMS].sort());
    if (JSON.stringify(Object.keys(snap).sort()) !== wantSnap)
      fail(name, `K2: Snapshot-Top-Keys ${JSON.stringify(Object.keys(snap).sort())} ≠ Vertrag (requestId + fünf Streams)`);
    for (const s of STREAMS) {
      const w = snap[s];
      if (w === null || typeof w !== 'object' || Array.isArray(w)) { fail(name, `Stream ${s}: Wrapper kein Objekt`); continue; }
      if (JSON.stringify(Object.keys(w).sort()) !== '["dropped","items"]')
        fail(name, `K2: Stream ${s}: Wrapper-Keys ${JSON.stringify(Object.keys(w).sort())} ≠ {items, dropped}`);
    }
    for (const s of STREAMS)
      if (!Array.isArray(snap[s]?.items) || !T.int0(snap[s]?.dropped))
        fail(name, `Stream ${s}: items[]/dropped fehlt oder falscher Typ`);
    if (snap.requestId !== reqId) fail(name, 'snapshot.requestId != X-Request-Id');
    // K5: jede Attempt-/Summary-Zeile trägt die Handler-requestId — llm-client.ts setzt
    // requestId aus ctx, und collector.requestId === ctx.requestId ist Client-Invariante.
    for (const [sName, items] of [['attempts', snap.attempts?.items], ['binding_summaries', snap.binding_summaries?.items]])
      (items ?? []).forEach((x, i) => {
        if (x?.requestId !== snap.requestId) fail(name, `K5: ${sName}[${i}].requestId ≠ snapshot.requestId`);
      });
    // V9 (HOLD 3): live erreichbarer Provider-Pfad ⇒ callId ist PFLICHT — engine/index.ts
    // setzt callId IMMER via generateCallId() je Achse. Abwesenheit ist keine zulässige
    // Variante, sondern eine Provenienzverletzung; axis muss aus request.axes stammen.
    if (LIVE.has(name)) {
      const reqAxes = new Set(reqParsed?.axes ?? []);
      for (const [sName, items] of [['attempts', snap.attempts?.items], ['binding_summaries', snap.binding_summaries?.items]])
        (items ?? []).forEach((x, i) => {
          if (!T.str(x?.callId) || x.callId === '') fail(name, `V9-K5: ${sName}[${i}].callId fehlt/leer — Provenienz nicht beweisbar`);
          if (!T.str(x?.axis) || !reqAxes.has(x.axis)) fail(name, `V9-K5: ${sName}[${i}].axis=${JSON.stringify(x?.axis)} ∉ request.axes`);
        });
    }
    // G2/G3: geschlossene Schemata für ALLE Items aller Streams.
    (snap.attempts?.items ?? []).forEach((a, i) => checkAttempt(name, i, a));
    (snap.binding_summaries?.items ?? []).forEach((b, i) => checkSummary(name, i, b));
    (snap.transitions?.items ?? []).forEach((t, i) => checkTransition(name, i, t));
    (snap.stale_results?.items ?? []).forEach((e, i) => checkStale(name, i, e));
    (snap.invalid_outcomes?.items ?? []).forEach((e, i) => checkInvalid(name, i, e));
    scanForbiddenKeys(name, snap, 'snapshot');      // G3: keine freien Fehlertext-Felder
  }
  // K3: "kein Diagnostics" heißt ABWESEND (Präsenz-Semantik) — ein präsenter,
  // leerer Header ist bereits oben gefailt und zählt hier NICHT als abwesend.
  const noDiag = !has('x-dql-diagnostics') && !has('x-dql-diagnostics-truncated') && !has('x-dql-diagnostics-counts');
  const success200 = status === 200 && Array.isArray(body?.meta?.models_used)
    && body.meta.models_used.length >= 1;                     // E5

  switch (name) {
    case 'D0_stub':
    case 'D1_baseline':
      if (status !== 200) fail(name, `HTTP ${status}`);
      if (!noDiag) fail(name, 'Diagnostics-Header präsent');
      break;
    case 'D2_on_small':
    case 'D2b_active0_diag1':
      if (!snap) { fail(name, 'X-DQL-Diagnostics fehlt'); break; }
      if (!success200) fail(name, 'E5: kein HTTP 200 + models_used >= 1');
      if (!hasCorrelatedSuccessfulBinding(snap))
        fail(name, 'V10-E5: kein korreliertes ok-Attempt/ok-Summary-Paar (identische callId/axis/requestId/requestedAlias/route) — Koexistenz allein ist kein Erfolg');
      break;
    case 'D2c_sandbox_diag':
      if (status !== 200) fail(name, `HTTP ${status}, erwartet 200`);      // G2
      if (!snap) { fail(name, 'X-DQL-Diagnostics fehlt'); break; }
      for (const s of STREAMS)
        if (snap[s].items.length !== 0 || snap[s].dropped !== 0) fail(name, `Stream ${s} nicht exakt leer`);
      break;
    case 'D3_natural_load':
      if (status !== 200) fail(name, `HTTP ${status}`);
      if (trunc === '1') {
        // G1: Counts-Shape wird bereits global geprüft (checkCounts).
      } else if (!snap) {
        fail(name, 'weder Diagnostics- noch Truncation-Paar');
      } else {
        notes.push('D3_natural_load=NOT_REACHED');           // H3: maschinenlesbar reporten
      }
      break;
    case 'D4_invalid_config':
      if (status !== 503) fail(name, `HTTP ${status}, erwartet 503`);
      if (!noDiag) fail(name, 'Diagnostics-Header auf config-invalid 503');
      if (typeof body?.error !== 'string') fail(name, 'body.error fehlt oder kein String'); // G2
      if (body?.code !== 'CONFIG_INVALID') fail(name, `code ${body?.code}`);
      if (!Array.isArray(body?.reasons)) fail(name, 'reasons[] fehlt oder kein Array');
      else {
        // K6: der 503 muss GENAU den festgelegten Defekt benennen. Kein stabiler
        // Per-Reason-Code im Ist-Vertrag → enge Tokens statt Prosa-Vergleich: jede
        // Reason muss 'serv-swift' UND 'minSamples' referenzieren. Eine unrelated
        // Config-Ursache (oder Zusatz-Reasons) ist FAIL — Claim ist "exakt dieser Defekt".
        if (body.reasons.length === 0) fail(name, 'K6: reasons[] leer');
        for (const r of body.reasons)
          if (typeof r !== 'string' || !r.includes('serv-swift') || !r.includes('minSamples'))
            fail(name, `K6: Reason nicht dem festgelegten D4-Defekt (serv-swift/minSamples) zuordenbar: '${String(r).slice(0, 120)}'`);
      }
      if ('details' in (body ?? {})) fail(name, 'details-Feld statt reasons[]');
      // SM-V4: der 503-Body ist im Code ein Literal mit exakt drei Feldern (verify.ts:149–153)
      // — freie Zusatzfelder wären Leak-Oberfläche auf dem Fehlerpfad.
      if (isObj(body) && JSON.stringify(Object.keys(body).sort()) !== '["code","error","reasons"]')
        fail(name, `SM-V4: 503-Body-Keys ${JSON.stringify(Object.keys(body).sort())} ≠ exakt {error, code, reasons}`);
      break;
    case 'D5_control': {
      if (!snap) { fail(name, 'X-DQL-Diagnostics fehlt'); break; }
      if (!success200) fail(name, 'G2/E5: kein HTTP 200 + models_used >= 1');
      if (!hasCorrelatedSuccessfulBinding(snap))
        fail(name, 'V10-E5: kein korreliertes ok-Attempt/ok-Summary-Paar — der Latenz-Trip muss aus einem beweisbaren erfolgreichen Call entstehen');
      const trips = snap.transitions.items.filter(t => t.kind === 'closed_to_open' && t.reason === 'latency');
      if (trips.length === 0) { fail(name, "kein closed_to_open mit reason='latency' — Failure-Rate-Trip zählt nicht"); break; }
      // K5: Kausalität statt Koexistenz — der Breaker ist per-Alias, also muss der
      // Latenz-Trip zu einem ok-Attempt UND einer ok-Summary DESSELBEN Alias gehören
      // (attemptAlias = tatsächlich gerufener Alias). V9 (HOLD 3): Attempt und Summary
      // MÜSSEN dieselbe nichtleere callId tragen — Abwesenheit ist FAIL, nicht Match —
      // und zusätzlich in axis, requestId, requestedAlias und route übereinstimmen.
      const corr = trips.some(t => snap.attempts.items.some(a =>
        a.ok === true && a.attemptAlias === t.alias
        && snap.binding_summaries.items.some(b =>
          b.ok === true && b.attemptAlias === t.alias
          && T.str(a.callId) && a.callId !== '' && b.callId === a.callId
          && b.axis === a.axis && b.requestId === a.requestId
          && b.requestedAlias === a.requestedAlias && b.route === a.route)));
      if (!corr) fail(name, `K5: latency-Trip (alias=${trips.map(t => t.alias).join(',')}) nicht über identische callId/axis/requestId/route mit ok-Attempt+ok-Summary desselben Alias korreliert`);
      break;
    }
    case 'D5_disabled':
      if (!snap) { fail(name, 'X-DQL-Diagnostics fehlt'); break; }
      if (!success200) fail(name, 'G2/E5: kein HTTP 200 + models_used >= 1');
      if (!hasCorrelatedSuccessfulBinding(snap))
        fail(name, 'V10-F4: Provider-Erfolg fehlt — kein korreliertes ok-Attempt/ok-Summary-Paar (identische callId/axis/requestId/requestedAlias/route)');
      if (snap.transitions.items.length !== 0) fail(name, 'transitions != 0 trotz Disable-Flag');
      break;
    case 'D6_invalid_key': {
      if (!snap) { fail(name, 'X-DQL-Diagnostics fehlt'); break; }
      if (!snap.attempts.items.some(x => x.ok === false && x.errorCategory === 'client_4xx'))
        fail(name, 'kein fehlgeschlagener Attempt mit client_4xx');
      // G3: Forbidden-Token-Suche — der D6-Test-Key trägt einen eindeutigen Marker,
      // der dem Verifier separat übergeben wird (nie im redigierten Manifest).
      if (D6_TOKEN && diag.includes(D6_TOKEN))
        fail(name, 'No-Leak verletzt: D6-Test-Key-Marker im Diagnostics-JSON');
      for (const m of PROVIDER_MARKERS)
        if (diag.toLowerCase().includes(m.toLowerCase()))
          fail(name, `No-Leak verletzt: Provider-Marker '${m}' im Diagnostics-JSON`);
      break;
    }
  }
 } catch (err) { fail(name, `Artefakt fehlt/unlesbar: ${err.message}`); }
}

// V9 (HOLD 2): D5-Paarprüfung — identischer Stimulus, isolierte Env-Differenz (F2/E4
// offline nachgerechnet statt dem Runner geglaubt). Byte-Identität der Requests plus
// Env-Manifeste, die sich EXAKT im Disable-Flag unterscheiden (0 vs. 1), Secret-Version
// vorhanden und identisch, alle übrigen Schlüssel gleich.
{
  const c = d5raw.get('D5_control'), d = d5raw.get('D5_disabled');
  if (c && d) {
    if (c.request !== d.request)
      fail('D5_disabled', 'V9-D5: request.json von D5_control und D5_disabled nicht byte-identisch');
    // V10 (Hermes v9 HOLD 2b): STRIKTER Parser — spiegelt die Runner-G4-Regeln (F2/E4)
    // statt eines toleranten split/indexOf-Parsers: Leer-/Kommentarzeilen erlaubt, sonst
    // exakt KEY=VALUE mit Key-Regex, Duplicate=FAIL, Secret-Suffix-/Klartext-Verbote,
    // SERV_API_KEY_BOUND muss 'true' sein. Malformte Zeilen werden NICHT ignoriert.
    const parseEnvStrict = (scn, raw) => {
      const kv = new Map();
      const lines = raw.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const s = lines[i].trim();
        if (!s || s.startsWith('#')) continue;
        const eq = s.indexOf('=');
        if (eq === -1) { fail(scn, `V10-D5/G4: Zeile ${i + 1} keine KEY=VALUE-Zeile`); return null; }
        const k = s.slice(0, eq);
        if (!/^[A-Z_][A-Z0-9_]*$/.test(k)) { fail(scn, `V10-D5/G4: Zeile ${i + 1} ungültiger Key '${k}'`); return null; }
        if (/(_KEY|_SECRET|_TOKEN|_PASSWORD)$/.test(k)) { fail(scn, `V10-D5/G4: mutmaßlicher Klartext-Secret-Key '${k}' im redigierten Manifest`); return null; }
        if (kv.has(k)) { fail(scn, `V10-D5/G4: Duplicate Key '${k}'`); return null; }
        kv.set(k, s.slice(eq + 1));
      }
      if (kv.has('SERV_API_KEY')) { fail(scn, 'V10-D5/G4: Klartext-Secret im Manifest — nur SERV_API_KEY_BOUND + SERV_API_KEY_SECRET_VERSION'); return null; }
      if (kv.get('SERV_API_KEY_BOUND') !== 'true') { fail(scn, `V10-D5/E4: SERV_API_KEY_BOUND=${JSON.stringify(kv.get('SERV_API_KEY_BOUND'))} ≠ 'true'`); return null; }
      return kv;
    };
    const ce = parseEnvStrict('D5_control', c.env), de = parseEnvStrict('D5_disabled', d.env);
    if (ce && de) {
      if (ce.get('DQL_DISABLE_CIRCUIT_BREAKER') !== '0') fail('D5_control', "V9-D5/F2: DQL_DISABLE_CIRCUIT_BREAKER ≠ '0'");
      if (de.get('DQL_DISABLE_CIRCUIT_BREAKER') !== '1') fail('D5_disabled', "V9-D5/F2: DQL_DISABLE_CIRCUIT_BREAKER ≠ '1'");
      for (const [scn, kv] of [['D5_control', ce], ['D5_disabled', de]])
        if (!kv.get('SERV_API_KEY_SECRET_VERSION')) fail(scn, 'V9-D5/E4: SERV_API_KEY_SECRET_VERSION fehlt/leer');
      if ((ce.get('SERV_API_KEY_SECRET_VERSION') ?? '') !== (de.get('SERV_API_KEY_SECRET_VERSION') ?? ''))
        fail('D5_disabled', 'V9-D5/E4: SERV_API_KEY_SECRET_VERSION der D5-Deploys ungleich');
      for (const k of new Set([...ce.keys(), ...de.keys()])) {
        if (k === 'DQL_DISABLE_CIRCUIT_BREAKER') continue;
        if (ce.get(k) !== de.get(k)) fail('D5_disabled', `V9-D5: Env-Differenz außerhalb des Flags — '${k}'`);
      }
    }
  }
}

// H3/K1: maschinenlesbares Verdict — Root-Datei, bewusst KEIN Szenario-Artefakt.
// Atomar geschrieben (tmp + rename). Ein Schreibfehler ist SELBST ein FAIL:
// „Exit 0 + verifier-verdict.txt" ist Bestandteil von Drill-PASS — ein unterdrückter
// Write-Fehler wäre ein falscher PASS ohne beweisbares Verdict.
const verdictLines = [...KNOWN].sort().map(s =>
  `${s}=${perScenario.get(s) ? 'FAIL' : (notes.includes(`${s}=NOT_REACHED`) ? 'PASS_NOT_REACHED' : 'PASS')}`);
verdictLines.push(...notes.map(n => `NOTE ${n}`));
verdictLines.push(`OVERALL=${failures ? 'FAIL' : 'PASS'}`);
try {
  const tmp = join(dir, 'verifier-verdict.txt.tmp');
  writeFileSync(tmp, verdictLines.join('\n') + '\n');
  renameSync(tmp, join(dir, 'verifier-verdict.txt'));
} catch (err) {
  failures++;
  console.error(`FAIL H3/K1: verifier-verdict.txt nicht schreibbar: ${err.message}`);
}
for (const n of notes) console.log(`NOTE ${n}`);
console.log(failures ? `FAIL (${failures} Abweichungen)` : 'PASS');
process.exit(failures ? 1 : 0);
```

Hinweis zur `body.id`-Assertion: sie läuft auf **allen** 200-Antworten (G2), nicht nur bei vorhandenem Snapshot; der D4-503-Body hat kein `id`-Feld und wird über seine eigene Regel geprüft. `AxisResult.objection` wird bewusst **nicht** auf Providertext geprüft — die No-Leak-Invariante gilt nur für Diagnostics-Felder.

### 5a. Fixture-Tests (Review-§5.3) + Counter-Fixtures (Re-Review-Paket) — ausgeführt

**Counter-Fixtures CF1–CF10** (gefordert im v7-Review): jede Manipulation setzt auf einer frischen, ansonsten grünen 10-Szenarien-Fixture auf; `sha256.txt` wird nach der Manipulation korrekt neu berechnet, damit ausschließlich der Zielpunkt failt (kein Hash-Nebeneffekt). Alle 31 Checks grün; FAIL-Meldungen wörtlich aus den Logs:

| # | Counter-Fixture | Erwartet | Ergebnis |
|---|---|---|---|
| CF1 | Verdict-Pfad unschreibbar (Verzeichnisse auf `verifier-verdict.txt` **und** `.tmp` — `chmod` blockt als root nicht) | non-zero + K1-Meldung | ✅ Exit 1: „FAIL H3/K1: verifier-verdict.txt nicht schreibbar: EISDIR …“ |
| CF2 | Unbekannter Snapshot-Top-Level-Key (`debugText` mit Prompt-Text) | FAIL | ✅ „K2: Snapshot-Top-Keys […,"debugText",…] ≠ Vertrag (requestId + fünf Streams)“ |
| CF3 | Unbekannter Stream-Wrapper-Key (`attempts.note`) | FAIL | ✅ „K2: Stream attempts: Wrapper-Keys ["dropped","items","note"] ≠ {items, dropped}“ |
| CF4 | Präsenter, **leerer** `X-DQL-Diagnostics` auf D0, D1 und D4 (3 Läufe) | FAIL je Szenario | ✅ 3× Exit 1: „K3: Header 'x-dql-diagnostics' präsent, aber leer“ |
| CF5a | `X-Request-Id` doppelt (identischer Wert) | FAIL | ✅ „K4: Header 'x-request-id' 2x im Block — Singleton-Vertrag verletzt“ |
| CF5b | `X-DQL-Diagnostics` doppelt (identischer Wert) | FAIL | ✅ „K4: Header 'x-dql-diagnostics' 2x im Block — Singleton-Vertrag verletzt“ |
| CF6 | D5: Erfolg auf `serv-nano`, Latenz-Trip auf `serv-swift` | FAIL | ✅ „K5: latency-Trip (alias=serv-swift) nicht mit ok-Attempt+ok-Summary desselben Alias korreliert“ |
| CF7 | `attempts[0].requestId` ≠ `snapshot.requestId` | FAIL | ✅ „K5: attempts[0].requestId ≠ snapshot.requestId“ |
| CF8 | D4-Body-`reasons = ["UNRELATED_CONFIG_ERROR"]` (Verifier) | FAIL | ✅ „K6: Reason nicht dem festgelegten D4-Defekt (serv-swift/minSamples) zuordenbar“ |
| CF8b | Runner-Preflight standalone: unrelated Reason im Health-503 → FAIL; echter Defekt-Reason → PASS (Kontrolle) | FAIL / PASS | ✅ „PREFLIGHT FAIL D4_invalid_config: K6: …“ / ✅ Kontrolle Exit 0 |
| CF9 | Doppelte Szenario-URL (D2 = D3), Dummy-Envs, `curl` durch Wächter-Shim ersetzt | Abbruch **vor** jedem Netzwerk-Call | ✅ Exit ≠ 0: „K7 FAIL: URL-Duplikat: D2_on_small und D3_natural_load teilen dql-ccc333.vercel.app — Deploy-Isolation verletzt“; Shim-Marker **nicht** berührt → kein curl-Aufruf |
| CF9b | Eindeutige URLs, doppelte Deployment-ID | Abbruch | ✅ „K7 FAIL: Deployment-ID-Duplikat: D2_on_small und D3_natural_load“ |
| CF9c | Mutabler `-git-`-Branch-Alias als URL | Abbruch | ✅ „K7 FAIL: … ist ein mutabler Branch-Alias — immutable Deployment-URL nötig“ |
| CF10 | Runner unter Sandbox-Bash 5 | K8-Guard passiert (CF9-Läufe erreichen den K7-Check hinter dem Guard) | ✅ passiert. **Negativtest (Bash 3.2) remote nicht beweisbar** → operativer Schritt auf dem Ops-Mac, §7 |

Zusätzliche S3-Probe (v9 frisch wiederholt, Neun-Artefakte-Vertrag): `sha256.txt` mit korrektem **zehnten** Eintrag (`extra-notes.txt`) → ✅ FAIL „sha256.txt: unerwarteter Eintrag 'extra-notes.txt' — Vertrag: exakt die neun Artefakte“.

**T1–T8-Regression** gegen die v10-Dateien — alle 16 Prüfungen unverändert wie erwartet (Fixture-Generator auf den v10-Vertrag nachgezogen: reduziertes 4-Key-Inspect-Artefakt mit `target: null`, byte-exakte normierte Szenario-Payloads; zuvor v9: neun Artefakte, volle §3a-Health-Matrix, D5-Flag-Paar, `EXPECTED_DEPLOYED_SHA` + `VERCEL_TOKEN` im Harness). **CF1–CF10 wurden ebenfalls komplett gegen die v10-Dateien wiederholt — alle 31 Checks grün**, ebenso CF11–CF15 (26 Checks, §5b), CF16–CF20 (40 Checks, §5c — Inspect-Shapes auf den echten v13-Vertrag `"target":null` umgestellt) und die neuen CF21–CF26 (29 Checks, §5d): **142 Checks gesamt**:

| # | Fixture | Erwartet | Ergebnis |
|---|---|---|---|
| T1 | Golden-Vector: D3 mit Truncation-Paar, Counts im **echten nested Shape** | PASS (Exit 0) | ✅ PASS |
| T1b | PASS-Variante: D3 mit Diagnostics ohne Trip | PASS + `D3_natural_load=PASS_NOT_REACHED` im Verdict | ✅ beides |
| T2 | Flacher Counts-Shape (`<stream>_retained`/`_dropped` — der v6-Irrtum) | FAIL | ✅ FAIL |
| T3 | D2c: HTTP 500 mit korrektem leerem Snapshot | FAIL | ✅ FAIL |
| T4 | D5-control ohne `meta.models_used` | FAIL | ✅ FAIL |
| T5a | D6: Test-Key-Marker in einem Snapshot-Stringfeld | FAIL | ✅ FAIL |
| T5b | D6: rohes `error`-Feld im Attempt (mit `Unauthorized`-Text) | FAIL | ✅ FAIL |
| T5c | Verifier-Aufruf **ohne** `D6_FORBIDDEN_TOKEN` | FAIL | ✅ FAIL |
| T6a | D5-Manifest mit aggressiver CB-Config | Profil-PASS | ✅ PASS |
| T6b | D5-Manifest mit lascher CB-Config | G4 FAIL | ✅ FAIL |
| T6c | D4-Manifest mit dem festgelegten Defekt | Profil-PASS | ✅ PASS |
| T6d | D4-Manifest **ohne** Defekt | G4 FAIL | ✅ FAIL |
| T7 | `body.json` **nach** `sha256.txt`-Erstellung manipuliert | Hash-FAIL | ✅ FAIL |
| T8 | Zwei HTTP-Headerblöcke (`100 Continue` + `200`) | FAIL | ✅ FAIL |

Abschließende Gegenprobe: Golden-Fixture mit Token erneut verifiziert → `PASS`, Exit 0, `verifier-verdict.txt` mit `OVERALL=PASS`, kein `.tmp`-Rest (atomarer Write sauber). Syntax: `bash -n` (Runner), `node --check` (Verifier), `ast.parse` für alle fünf eingebetteten Python-Blöcke (v10: K7-BIND-Validator reduziert das Inspect-Artefakt auf das geschlossene 4-Key-Set); zusätzlich `shellcheck -S warning` ohne Befund. Die FAIL-Fälle scheitern jeweils **aus dem intendierten Grund** — die Meldungs-Zitate oben stammen wörtlich aus den Logs, und jede Counter-Fixture prüft zusätzlich per Log-Grep, dass die **richtige** K-Meldung feuert.

### 5b. Steelman-Counter-Fixtures CF11–CF15 (v8.1, vor dem Review) — ausgeführt

26 Checks grün; FAIL-Meldungen wörtlich aus den Logs:

| # | Counter-Fixture | Erwartet | Ergebnis |
|---|---|---|---|
| CF11 | PATH ohne `sha256sum`, `curl` durch Wächter-Shim ersetzt | `FATAL` Exit 2 **vor** jedem Netzwerk-Call | ✅ „FATAL SM-R1: benötigtes Tool fehlt im PATH: sha256sum“; Shim-Marker unberührt |
| CF11k | Kontrolle: vollständiger PATH | Preflight passiert (Abbruch erst später, ohne SM-R1-Meldung) | ✅ passiert |
| CF12a | `manifest.txt`: `deployed_sha` ≠ `health.commit_sha` | FAIL | ✅ „SM-V2: deployed_sha ≠ health.commit_sha“ |
| CF12b | Deployment-ID-Duplikat **offline** (zwei Szenarien, gleiche ID) | FAIL | ✅ „SM-V2/K7: deployment_id auch in D0_stub — Deploy-Isolation verletzt“ |
| CF12c | Manifest-Key fehlt (`utc`) | FAIL | ✅ „SM-V2: manifest.txt-Keys […] ≠ Vertrag (7 Felder)“ |
| CF12d | `base_code_sha` ≠ approved Code-Basis | FAIL | ✅ „SM-V2: base_code_sha '…' ≠ approved Code-Basis“ |
| CF13a | freier Top-Level-Key `debug` im 200-Body | FAIL | ✅ „body: unerlaubter Key 'debug'“ |
| CF13b | `meta.sandbox` ≠ `request.sandbox` (D2c) | FAIL | ✅ „SM-V3: meta.sandbox=false ≠ request.sandbox=true“ |
| CF13c | `meta.axes_evaluated` ≠ `request.axes` (D3) | FAIL | ✅ „SM-V3: meta.axes_evaluated ≠ request.axes“ |
| CF14 | Zusatzfeld `hint` im D4-503-Body | FAIL | ✅ „SM-V4: 503-Body-Keys ["code","error","hint","reasons"] ≠ exakt {error, code, reasons}“ |
| CF15a | Verifier ohne Argument | `FATAL`, kein roher Stacktrace | ✅ „FATAL SM-V1: Run-Verzeichnis fehlt oder ist kein Verzeichnis: ''“ |
| CF15b | Verifier auf nichtexistentem Verzeichnis | `FATAL` | ✅ „FATAL SM-V1: Run-Verzeichnis fehlt oder ist kein Verzeichnis: '…/does_not_exist_xyz'“ |

### 5c. Counter-Fixtures CF16–CF20 für die v9-Hold-Fixes — gegen die v10-Dateien wiederholt

40 Checks grün (alle Inspect-Shapes auf den echten v13-Vertrag `"target":null` umgestellt; Zitate aus dem frischen v10-Lauf); jede Manipulation auf frischer, sonst grüner Fixture, `sha256.txt` nach der Manipulation korrekt neu berechnet; FAIL-Meldungen wörtlich aus den Logs. CF16 fährt den **echten Runner** mit `curl`-Shim, der ein konfigurierbares Inspect-JSON liefert und jeden echten Netzwerk-Call markiert:

| # | Counter-Fixture | Erwartet | Ergebnis |
|---|---|---|---|
| CF16a | Inspect-URL ≠ Eingabe-Host (mutabler Alias/fremdes Deployment) | Runner-Abbruch | ✅ „K7-BIND FAIL D0_stub: inspect.url='dql-other000.vercel.app' != URL-Host 'dql-aaa111.vercel.app' — mutabler Alias oder fremdes Deployment“ |
| CF16b | erfundene, eindeutige `*_DEPLOY_ID` (der v8-Bypass) | Abbruch | ✅ „K7-BIND FAIL D0_stub: inspect.id='dpl_fremd' != DEPLOY_ID 'dpl_0' — erfundene/fremde ID“ |
| CF16c | `target=production` | Abbruch | ✅ „K7-BIND FAIL D0_stub: target='production', erwartet null (v13-Vertrag: null = Preview)“ |
| CF16d | `readyState=BUILDING` | Abbruch | ✅ „K7-BIND FAIL D0_stub: readyState='BUILDING', erwartet 'READY'“ |
| CF16e | URL mit Query (`?probe=1`) | K7-Abbruch **vor** jedem Netzwerk-Call | ✅ „K7 FAIL: D0_stub: URL trägt Query“; Shim-Marker unberührt |
| CF16f | Kontrolle: korrektes URL↔ID-Paar im echten v13-Shape (`"target":null`) | K7-BIND passiert (keine `K7-BIND FAIL`-Meldung; Abbruch erst später am Shim-Health) | ✅ passiert |
| CF17a | D2-`request.json` durch Sandbox-Request getauscht (Review-Mutation 1) | FAIL | ✅ „V10-R: request.json nicht byte-identisch zur Szenario-Payload (§4) — 86 Bytes, erwartet 87 Bytes“ + „V9-R: request.sandbox=true ≠ Szenario-Erwartung false“ (Zweitlinie) |
| CF17b | D2-`health.json` auf `runtime_mode=stub` (Review-Mutation 2, Teil 1) | FAIL | ✅ „V9-H: health.runtime_mode="stub" ≠ "pot-cli"“ |
| CF17b2 | **konsistent** falsche SHA in `health.json` **und** `manifest.txt` (Review-Mutation 2/3 — SM-V2-Kreuzcheck allein wäre blind) | FAIL | ✅ „V9-H: health.commit_sha="beef…" ≠ EXPECTED_DEPLOYED_SHA“ + „V9-H: manifest.deployed_sha ≠ EXPECTED_DEPLOYED_SHA“ |
| CF17c | Verifier **ohne** `EXPECTED_DEPLOYED_SHA` | `FATAL`, Exit 1 | ✅ „FATAL V9-H: EXPECTED_DEPLOYED_SHA nicht gesetzt — SHA-Bindung offline nicht beweisbar“ |
| CF17d | D5-`request.json` nicht byte-identisch (Whitespace) | FAIL | ✅ „V10-R: … nicht byte-identisch zur Szenario-Payload (§4) — 88 Bytes, erwartet 87 Bytes“ + „V9-D5: request.json von D5_control und D5_disabled nicht byte-identisch“ |
| CF17e | D5-Env-Differenz jenseits des Flags (`DQL_EXTRA_TUNING=1`) | FAIL | ✅ „V9-D5: Env-Differenz außerhalb des Flags — 'DQL_EXTRA_TUNING'“ |
| CF18a | `callId` aus D2-Attempt entfernt | FAIL | ✅ „V9-K5: attempts[0].callId fehlt/leer — Provenienz nicht beweisbar“ |
| CF18b | Summary-`axis` ∉ `request.axes` (D2) | FAIL | ✅ „V9-K5: binding_summaries[0].axis="scope" ∉ request.axes“ |
| CF18c | D5-control: `callId` aus Attempt **und** Summary entfernt (der v8-Absenz-Bypass) | FAIL, auch der Korrelator | ✅ beide „V9-K5: … callId fehlt/leer“ **und** „K5: latency-Trip … nicht … korreliert“ |
| CF19a | D6-Statuszeile `HTTP/WUT 200` (Review-Mutation, Hold 4) | FAIL | ✅ „V9-S: Wire-Status unparsebar/ungültig — Statuszeile 'HTTP/WUT 200'“ |
| CF19b | D6-Status `999` | FAIL | ✅ „V9-S: Wire-Status unparsebar/ungültig — Statuszeile 'HTTP/2 999'“ |
| CF20a | `vercel-inspect.json`-`id` offline mutiert | FAIL | ✅ „V9-K7: inspect.id="dpl_evil" ≠ manifest.deployment_id“ |
| CF20b | `vercel-inspect.json`-`target=production` offline | FAIL | ✅ „V10-K7: target="production" ≠ null (v13-Vertrag: null = Preview)“ |

Hermes' K7-Gegenproben aus dem Review sind damit vollständig abgedeckt: Projekt-/Branch-Alias und URL-Syntaxöffnungen scheitern an der K7-Schließung (CF16e), reale URL + fremde ID an `inspect.id` (CF16b), reale ID + fremde URL an `inspect.url` (CF16a), `production`/nicht-`READY` an CF16c/d, und das korrekte Paar **im echten v13-Shape** passiert (CF16f) — Referenzbeispiel aus der Live-Verifikation (dort auch `target: null` bestätigt, §0a): `decision-quality-layer-datsqe0bc-…vercel.app` ↔ `dpl_AW1xhcTd2eqq5akqqkVUQ4Hgv2j1` (PASS-Paar) vs. Projekt-Alias `decision-quality-layer.vercel.app`, der aktuell auf `…-b9ec8jebl-…` / `dpl_eCscKBUXMeY6s5nnPEuiA7j6UBgu` auflöst (FAIL, mutabel).

### 5d. Counter-Fixtures CF21–CF26 für die v10-Fixes — ausgeführt

29 Checks grün; jede Offline-Manipulation auf frischer, sonst grüner Fixture mit korrekt neu berechneter `sha256.txt`; CF21/CF26 fahren den **echten Runner** mit dem `curl`-Shim; FAIL-Meldungen wörtlich aus den Logs:

| # | Counter-Fixture | Erwartet | Ergebnis |
|---|---|---|---|
| CF21a | Inspect-Antwort **ohne** `target`-Feld | Runner-Abbruch (nichts wird fabriziert) | ✅ „K7-BIND FAIL D0_stub: Feld 'target' fehlt in der Inspect-Antwort — Preview-Status nicht beweisbar“ |
| CF21b | `target='staging'` | Abbruch; Raw-Tempfile auch nach FAIL gelöscht | ✅ „K7-BIND FAIL D0_stub: target='staging', erwartet null (v13-Vertrag: null = Preview)“; `find … -name '.vercel-inspect-raw.json'` leer |
| CF21r | archiviertes Artefakt nach bestandenem K7-BIND (CF16f-Lauf) | exakt `{id, url, target, readyState}`, `target` null, kein Raw-Tempfile im Baum | ✅ beide Prüfungen grün |
| CF22a | D2-Stimulus getauscht (`mandate/proposed_action/reasoning`), `axes`+`sandbox` **korrekt** — der Hold-2a-Bypass | FAIL, ohne dass ein V9-R-Check anschlägt | ✅ „V10-R: request.json nicht byte-identisch zur Szenario-Payload (§4) — 92 Bytes, erwartet 87 Bytes“; `nolog 'V9-R:'` bestätigt: v9 hätte das passieren lassen |
| CF23a | malformte Zeile (`MALFORMED LINE`) + Duplicate-Flag in **beiden** D5-Manifesten (Hermes-Mutation) | FAIL | ✅ „V10-D5/G4: Zeile 2 keine KEY=VALUE-Zeile“ (beide Szenarien) |
| CF23a2 | **nur** Duplicate Key, syntaktisch valide Zeilen | FAIL | ✅ „V10-D5/G4: Duplicate Key 'DQL_CASCADE'“ |
| CF23b | `SERV_API_KEY_BOUND` aus beiden Manifesten entfernt | FAIL | ✅ „V10-D5/E4: SERV_API_KEY_BOUND=undefined ≠ 'true'“ |
| CF23c | `SERV_API_KEY=sk_livexxx` in beiden Manifesten | FAIL (Secret-Suffix offline) | ✅ „V10-D5/G4: mutmaßlicher Klartext-Secret-Key 'SERV_API_KEY' im redigierten Manifest“ |
| CF23d | Kontrolle: identische Kommentar-/Leerzeile in beiden Manifesten | weiterhin PASS | ✅ Exit 0 |
| CF24a | D5-disabled: `attempts[0].callId='attempt'`, `summaries[0].callId='summary'` (ok-Koexistenz ohne Korrelation) | FAIL | ✅ „V10-F4: Provider-Erfolg fehlt — kein korreliertes ok-Attempt/ok-Summary-Paar (identische callId/axis/requestId/requestedAlias/route)“ |
| CF24b | dieselbe Splittung auf D2 | FAIL | ✅ „V10-E5: kein korreliertes ok-Attempt/ok-Summary-Paar (identische callId/axis/requestId/requestedAlias/route) — Koexistenz allein ist kein Erfolg“ |
| CF25a | Zusatz-Key `env` ins Inspect-Artefakt injiziert (Owner-Datenrückfluss) | FAIL (geschlossenes Set) | ✅ „V10-K7: Inspect-Artefakt-Keys ["env","id","readyState","target","url"] ≠ exakt {id,url,target,readyState}“ |
| CF25b | `target="preview"` — die v9-Fantasie-Shape als Artefakt | FAIL | ✅ „V10-K7: target="preview" ≠ null (v13-Vertrag: null = Preview)“ |
| CF26a | `bash-env.txt` nach spätem Abbruch (CF16f-Lauf, FAIL am Shim-Health) | vorhanden, mit `bash_path`+`bash_version` | ✅ vorhanden |
| CF26b | `bash-env.txt` nach **frühem** K7-BIND-Abbruch (CF21a-Lauf, vor jedem Health-Call) | vorhanden | ✅ vorhanden |

## 6. Erfolgs-/Abbruchkriterien

**Drill-PASS** ⇔ alle Szenarien produzieren den in §4 normierten Wire-Kontrakt **und der Offline-Verifier (§5) endet mit Exitcode 0** — inklusive bestandener `sha256.txt`-Verifikation aller **neun** Artefakte je Szenario (exakt neun, keine Duplikate/Extras — H1/S3/v9) **und erfolgreich atomar geschriebenem `verifier-verdict.txt`** (ein Schreibfehler ist selbst FAIL, K1). Ein sichtbar falscher Run mit Verifier-Exit 0 ist ein Verifier-Defekt, kein PASS (F4). Bei D3-`NOT_REACHED` gilt PASS unter Vorbehalt: der Verifier schreibt `D3_natural_load=PASS_NOT_REACHED` + `NOTE`-Zeile maschinenlesbar in `verifier-verdict.txt` (H3) — der Truncation-Pfad ist dann nur unit-/mutationsverifiziert, der Vercel-Headertransport des Truncation-Zweigs nicht live belegt.

**Drill-FAIL** (Ursachenanalyse offline gegen `drill-runs/*`, kein Live-Debugging):

- D0/D1 zeigt irgendeinen Diagnostics-Header.
- Header-Präsenz weicht in D2/D2b/D2c/D3/D5-control/D5-disabled von der Matrix ab.
- **E5:** D2/D2b erfüllt die Erfolgskriterien nicht — `HTTP 200` + `meta.models_used.length >= 1` + **ein korreliertes ok-Attempt/ok-Summary-Paar mit identischer `callId`/`axis`/`requestId`/`requestedAlias`/`route`** (V10-E5, Rest-Hold 3). `attempts>=1`/`summaries>=1` allein ist **kein** Success-Beweis (wird auch bei Provider-401/Netz-/Parse-Fehler grün), und unkorrelierte ok-Koexistenz ebenfalls nicht.
- D5-control produziert **kein** `closed_to_open` mit `reason='latency'` aus einem erfolgreichen Call (korreliertes ok-Attempt/ok-Summary-Paar, V10-E5/V10-F4) — ein Failure-Rate-Trip zählt nicht als Latenzpfad-Beleg. Das Paar ist dann nicht diskriminierend: **verwerfen, nicht wiederverwenden**, Ursache klären statt D5-disabled allein zu werten.
- **E4/F2:** der D5-Manifest-Vergleich zeigt Differenzen jenseits von `DQL_DISABLE_CIRCUIT_BREAKER` — **oder** der strikte Parser findet die Disable-Zeile nicht genau einmal je Manifest mit exakt `0` (control) / `1` (disabled), Duplicate Keys, malformte Zeilen, Klartext-Secret-Keys (`*_KEY`/`*_SECRET`/`*_TOKEN`/`*_PASSWORD`), fehlendes `SERV_API_KEY_BOUND=true` oder abweichende `SERV_API_KEY_SECRET_VERSION` — offline vom Verifier mit demselben strikten Parser nachgerechnet (V10-D5/G4, V10-D5/E4); Paar ungültig, ON/OFF-Kontrast nicht kausal interpretierbar.
- **F1:** `health_status` weicht von der Erwartung ab (D4: `503`, alle anderen: `200`) — ein plausibler Health-Body mit falschem HTTP-Status zählt nicht als Preflight-Beleg.
- **F3/F4:** unbekannte Verzeichnisse unter `drill-runs/<timestamp>/`, Root-Dateien als Szenario-Ersatz oder fehlende Szenario-Artefakte (`env-manifest.txt`, `health_status`, `curl_exit`, …).
- Health-Response eines Szenarios weicht von der §3a-Erwartung ab (der ausführbare Preflight hätte den Wire-Call verhindern müssen — E1).
- **`INFRA_FAIL` (eigene Kategorie, kein Drill-FAIL):** `curl`-Exitcode ≠ 0 — Transportfehler ist kein Wire-Ergebnis und geht nicht in die Matrix-Wertung ein; Szenario mit frischem Deploy wiederholen (für D5: neues Paar).
- D4 liefert einen Diagnostics-Header, `details` statt `reasons[]`, oder `reasons` ist kein Array.
- `DiagnosticsSnapshot.requestId` fehlt, ist snake_case oder ≠ `X-Request-Id`. (Format-Assertion nur `startsWith('dql_')` — kein Längen-Regex, R3.)
- `errorCategory` außerhalb des 7er-Enums.
- **G3:** D6-Key-Marker oder ein Provider-Marker (`Unauthorized`, `invalid api`, `invalid_api_key`, …) im Diagnostics-JSON, ein freier Fehlertext-Key (`error`/`message`/`details`/`response`/`body`/`stack`) irgendwo im Snapshot, **oder** `D6_FORBIDDEN_TOKEN` beim Verifier-Aufruf nicht gesetzt („No-Leak nicht beweisbar“). (`AxisResult.objection` mit gekürztem Providertext ist kein FAIL — außerhalb der Invariante.)
- **G1:** Counts-Header verletzt den nested Wire-Vertrag (Top-Keys ≠ fünf Streams + `dropped`, `dropped`-Keys ≠ exakt die fünf Streams, Nicht-Integer/negative Werte) oder `X-DQL-Diagnostics-Truncated` ≠ `'1'`.
- **G2:** ein Stream-Item verletzt sein geschlossenes Schema — unbekannte Keys, `route` außerhalb `{primary,fallback}`, `iteration < 1`/kein Integer, `ok` nicht boolesch, fehlende Pflichtfelder, `errorCategory` präsent trotz `ok===true`, Transition/Stale/Invalid mit unbekanntem `kind` oder `reason`.
- **G4:** ein Env-Manifest verletzt sein Szenarioprofil — fehlende Pflicht-Keys, ungültiges KEY-Format, `DQL_CB_CONFIG_BY_ALIAS` nicht parsebar/unvollständig, D5 ohne aggressive Werte (`minSamples`/`tripP90LatencyMs` ≠ 1), D4 ohne den festgelegten `serv-swift`-Defekt.
- **H1:** `sha256.txt` listet nicht exakt die neun Artefakte oder ein Hash stimmt nicht — Artefakt nach dem Hashen verändert.
- **H2:** mehr als ein HTTP-Headerblock in `headers` (Redirect/100-Continue) — Wire-Antwort nicht eindeutig attribuierbar.
- **K2:** Snapshot-Top-Level enthält andere Keys als `requestId` + die fünf Streams, oder ein Stream-Wrapper andere Keys als `{items, dropped}` — freie Zusatzfelder sind Leak-Oberfläche.
- **K3:** ein Vertragsheader ist präsent, aber leer — zählt nicht als „absent“.
- **K4:** ein Singleton-Vertragsheader (`X-Request-Id`, `X-DQL-Version`, `X-DQL-Diagnostics*`) tritt mehrfach im Headerblock auf, auch wertgleich — mehrdeutiger Wire ist kein PASS.
- **K5:** eine Attempt-/Summary-Item-`requestId` ≠ `snapshot.requestId`, **oder** der D5-Latenz-Trip ist nicht per `attemptAlias` (+ `callId`, wo beide vorhanden) mit einem ok-Attempt und einer ok-Summary korreliert.
- **K6:** eine D4-Reason benennt nicht den festgelegten Defekt (`serv-swift` + `minSamples`) oder `reasons` ist leer — unrelated `CONFIG_INVALID` ist kein D4-Beleg.
- **K7 (Runner-Abbruch vor jedem Call):** doppelte/nicht-immutable Szenario-URLs, doppelte oder leere Deployment-IDs, URL mit Credentials/Pfad/Query/Fragment/Nichtstandard-Port — **oder K7-BIND-Verstoß:** `inspect.id` ≠ `*_DEPLOY_ID`, `inspect.url` ≠ URL-Host, `target` ≠ `null` (v13-Vertrag: `null` = Preview; fehlendes Feld = FAIL), `readyState` ≠ `READY` (Hold 1/v10).
- **V9-H (Hold 2):** archivierte `health.json`/`health_status` widersprechen der §3a-Matrix, `commit_sha`/`deployed_sha` ≠ `EXPECTED_DEPLOYED_SHA`, oder Fingerprint-Differenz Manifest↔Health.
- **V9-R/V10-R (Hold 2/2a):** `request.json` nicht **byte-identisch** zur normierten Szenario-Payload (§4) — die semantischen Achsen-/`sandbox`-Checks bleiben als Zweitlinie.
- **V9-D5 (Hold 2):** D5-`request.json` nicht byte-identisch, Flag-Zeile nicht exakt `0`/`1`, `SERV_API_KEY_SECRET_VERSION` fehlt/differiert, oder Env-Differenz außerhalb des Flags — offline nachgerechnet.
- **V9-K5 (Hold 3):** ein Live-Attempt/-Summary ohne nichtleeren `callId` oder mit `axis` ∉ `request.axes`; D5-Korrelation ohne vollständigen Binding-Kontext (`callId`/`axis`/`requestId`/`requestedAlias`/`route`).
- **V9-S (Hold 4):** Wire-Status unparsebar oder außerhalb 100–599 — in jedem Szenario, auch D6.
- **V9-K7/V10-K7 (Hold 1/Security, offline):** `vercel-inspect.json` fehlt, widerspricht `manifest.txt` (`id`/`url`/`readyState`), trägt `target` ≠ `null`, oder verletzt das geschlossene Artefakt-Schema (Keys exakt `{id, url, target, readyState}` — jeder Zusatz-Key ist Owner-Datenrückfluss und damit FAIL).
- Body wird gesendet, aber ein laut Matrix erwarteter Header fehlt (Ordering-Verstoß → H4-Regression).

**Rollback:** Szenario-Deploys sind Wegwerf-Artefakte — es gibt nichts zurückzudrehen. Das produktiv referenzierte Preview und dessen Keys werden zu keinem Zeitpunkt angefasst.

---

## 7. Freigabe-Reihenfolge (gemäß Review — Sequenz unverändert zu v8)

**Unverändert:** der Spec-Commit rückt erst **hinter** das Script-Review. Erst wenn Runner-/Verifier-Dateien, Counter-Fixtures und Regression approved sind, wird committed und deployt.

1. Hermes reviewt **fokussiert den v10-Diff (Holds 1, 2a, 2b, Rest-3, Security, Ops)**: die beiden materialisierten Dateien (§5, byte-identisch aus den Dateien generiert) + neue Counter-Fixtures CF21–CF26 (§5d), die auf v13-`target:null` umgestellten CF16–CF20 (§5c) und die komplette Regression T1–T8 + CF1–CF15 gegen die v10-Dateien (§5a/§5b) — **142 Checks**. Architektur, Runtime-Code (`d7a8ff6`) und OpenAPI-Delta (v5) sind approved und unverändert — es geht nur noch um Runner/Verifier/Ops.
2. **Erst nach dessen Approval:** Spec-Patch + Spec-Tests committen und pushen (inkl. S1/S2-Präzisierungen) — die Implementierungsfreigabe liegt vor (Review v5 §5); das ist noch keine Merge-Freigabe.
3. Echten neuen PR-HEAD live prüfen; Diff gegen `d7a8ff6` auditieren (einziger Produktdatei-Diff: `api/openapi.ts` + Tests).
4. Suite, Typecheck und Build auf dem neuen HEAD laufen lassen.
5. `/openapi.json` extrahieren und OpenAPI-3.1-validieren; alle `$ref` auflösen (UI-Rendering zusätzlich, nicht alleiniger Beweis).
6. Per-Szenario immutable Preview-Deploys — **auch D2c/D3 eigene Deploys** (Review-§4) — mit vollständigen **redigierten, maschinenlesbaren** Env-Manifesten **aus der Deployment-Automation** (S1) erstellen; pro Szenario gegen das G4-Profil validieren + archivieren (§2/§2a, F3/G4); **URL + Deployment-ID je Szenario notieren** — der Runner verlangt beide und bricht bei Duplikaten/Branch-Aliassen vor jedem Call ab (K7); für das D5-Paar den strikten Parser-Vergleich fahren (§2b, E4/F2); D6-Key mit Marker erzeugen (`D6_KEY_MARKER`, §4 D6/G3); **`VERCEL_TOKEN` (read-only) für die K7-BIND-Inspect-Calls bereitstellen (Hold 1)**. Optionale zusätzliche Härtung gegen Komplett-Neuschreiben des Run-Ordners: Hash/Signatur des Run-Manifests extern ablegen (z. B. Commit-Kommentar) — vom Review empfohlen, nicht Teil des Verifier-Vertrags.
7. **Bash-Pin auf dem Ops-Mac (K8, operativ):** Runner ausschließlich über die gepinnte Homebrew-Bash starten (`/opt/homebrew/bin/bash scripts/live-drill-v0431-c-integration.sh`). Vorab beide Guard-Pfade belegen: Aufruf mit `/bin/bash` (3.2.57) muss sofort mit `FATAL K8 … Exit 2` abbrechen, Aufruf mit der gepinnten Bash muss den Guard passieren — dieser Negativ-/Positivtest ist remote nicht beweisbar (CF10) und gehört als Ops-Schritt in den Drill-Ablauf. **Ops-HOLD (weiterhin offen, Paul):** auf dem Ops-Mac fehlt `/opt/homebrew/bin/bash` — vor dem Drill `brew install bash`, dann den Runner mit exakt diesem Pfad mindestens bis **hinter das korrigierte K7-BIND (`target:null`)** laufen lassen und **Pfad + `bash --version` als Beleg sichern**; `bash-env.txt` schreibt der Runner seit v10 bereits beim Run-Start und der Beleg überlebt jeden Abbruch (CF26). Dieser Positivlauf ist explizite Freigabebedingung des v9-Reviews und wird nicht als erledigt markiert.
8. Health je Szenario gegen die semantischen Erwartungen (§3a, voller deterministischer Feldsatz — S2) prüfen und archivieren — **ausführbar im Runner-Preflight, inkl. HTTP-Status (F1), SHA-Check auch für D4 (E2), D4-Reason-Tokens (K6) und Fingerprint-Präsenz (S1)**.
9. Erst dann Provider-Wire-Calls ausführen (nur Preview, nie Prod; D5: erster Verify-Call auf frischem Deploy, E3; POSTs mit `-H 'Expect:'`, H2); Raw-Artefakte, Curl-Exitcodes und Hashes sichern.
10. Offline-Verifier mit `D6_FORBIDDEN_TOKEN` **und `EXPECTED_DEPLOYED_SHA` (Pflicht-Input, Hold 2)** laufen lassen (Exit 0 + atomar geschriebenes `verifier-verdict.txt`, H1/H3/K1); Hermes prüft `drill-runs/*` + Verdict gegen die §4-Matrix. Nach Drill-PASS: **erst dann** Schritt 3 des §C+integration-Fahrplans (Canary-Kalibrierung / Roll-out-Plan).
