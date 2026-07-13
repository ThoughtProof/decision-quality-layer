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
