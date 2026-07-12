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
# Optional: Vercel "Protection Bypass for Automation" — nötig, wenn das Projekt
# SSO-Deployment-Protection aktiv hat (Stand 2026-07-12: all_except_custom_domains).
# Wird NUR als Request-Header gesendet; landet in keinem archivierten Artefakt
# (request.json = Body, headers = RESPONSE-Header). Leer = kein Header (Altverhalten).
VERCEL_BYPASS_SECRET="${VERCEL_BYPASS_SECRET:-}"
BYPASS_ARGS=()
if [[ -n "$VERCEL_BYPASS_SECRET" ]]; then
  BYPASS_ARGS=(-H "x-vercel-protection-bypass: $VERCEL_BYPASS_SECRET")
fi

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
  health_status=$(curl -sS --max-time 30 ${BYPASS_ARGS[@]+"${BYPASS_ARGS[@]}"} -o "$OUT/$name/health.json" -w '%{http_code}' "$url/dql/health") \
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
  curl -sS --max-time 300 ${BYPASS_ARGS[@]+"${BYPASS_ARGS[@]}"} -D "$OUT/$name/headers" -o "$OUT/$name/body.json" \
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
