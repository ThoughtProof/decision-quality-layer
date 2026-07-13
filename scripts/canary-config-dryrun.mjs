/**
 * Canary-Kalibrierung §C+integration Schritt 3 — lokaler Dry-Run (NON-PRODUCT).
 *
 * Läuft rein lokal, berührt weder Vercel noch geteilte Envs. Lädt das
 * repo-getrackte, nicht-geheime Artefakt `config/canary/v0431-cb-config.json`,
 * baut eine vollständige Canary-Env (Dummy-Testkey, KEIN Secret) und ruft die
 * ECHTEN Contract-Funktionen aus dem Build auf, um VOR jedem Deploy zu
 * beweisen:
 *   1. Artefakt trägt exakt 2 Aliases × 7 live-konsumierte CB-Felder.
 *   2. `resolveProductionConfig` akzeptiert das Artefakt verbatim als
 *      DQL_CB_CONFIG_BY_ALIAS; alle 7 Felder überleben je Alias.
 *   3. `computeConfigHash` ist deterministisch + key-order-invariant.
 *   4. Canary-AKTIV ohne DQL_CB_CONFIG_BY_ALIAS wird abgelehnt (Pflicht-Gate).
 *   5. Die alias_gate_ready-Konjunktion (Health-Handler-äquivalent) ist erfüllt.
 *
 * Voraussetzung: `npm run build` (importiert aus ../dist/...), wie die
 * übrigen scripts/*.mjs.
 *
 * Aufruf:  node scripts/canary-config-dryrun.mjs
 * Exit 0 = alle Checks bestanden, 1 = mindestens ein Check FAIL.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  resolveProductionConfig,
  computeConfigHash,
  KNOWN_ALIASES,
} from '../dist/src/engine/production-config.js';

const ARTIFACT_PATH = fileURLToPath(
  new URL('../config/canary/v0431-cb-config.json', import.meta.url),
);
const ARTIFACT_RAW = readFileSync(ARTIFACT_PATH, 'utf8');
const ARTIFACT = JSON.parse(ARTIFACT_RAW);

const CB_FIELDS = [
  'tripP90LatencyMs',
  'tripFailureRate',
  'cooldownMs',
  'windowSize',
  'windowAgeMs',
  'minSamples',
  'probeMaxLatencyMs',
];

let failures = 0;
function check(name, cond, detail = '') {
  const ok = !!cond;
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
}

function canaryEnv(overrides = {}) {
  return {
    DQL_CASCADE: 'pot-cli',
    DQL_V0431_ACTIVE: '1',
    DQL_CAPITAL_PATH_MODE: '1',
    DQL_RUNTIME_DIAGNOSTICS: '1',
    SERV_API_KEY: 'dummy-local-key-not-a-secret',
    DQL_CB_CONFIG_BY_ALIAS: ARTIFACT_RAW,
    DQL_COMMIT_SHA: '0fab28c5421f42a67bbc12f635eaf2f61700a510',
    ...overrides,
  };
}

console.log(`Canary Dry-Run — Artefakt: ${ARTIFACT_PATH}\n`);

// 1. Shape
check(
  'Artefakt hat exakt die zwei bekannten Aliases',
  JSON.stringify(Object.keys(ARTIFACT).sort()) ===
    JSON.stringify([...KNOWN_ALIASES].sort()),
);
for (const alias of KNOWN_ALIASES) {
  const entry = ARTIFACT[alias] ?? {};
  check(
    `${alias}: alle 7 CB-Felder als endliche Zahlen`,
    CB_FIELDS.every((f) => Number.isFinite(entry[f])) &&
      Object.keys(entry).length === CB_FIELDS.length,
  );
}

// 2. Resolver acceptance
let config = null;
try {
  config = resolveProductionConfig(canaryEnv(), { requiredMode: 'pot-cli' });
  check('resolveProductionConfig akzeptiert die Canary-Config', true);
} catch (e) {
  check('resolveProductionConfig akzeptiert die Canary-Config', false, String(e));
}
if (config) {
  for (const alias of KNOWN_ALIASES) {
    const resolved = config.circuit_breaker_config_by_alias[alias];
    check(
      `${alias}: alle 7 Felder überleben in die resolved config`,
      CB_FIELDS.every((f) => resolved[f] === ARTIFACT[alias][f]),
    );
  }
}

// 3. Deterministic hash
if (config) {
  const h1 = computeConfigHash(config);
  const h2 = computeConfigHash(
    resolveProductionConfig(canaryEnv(), { requiredMode: 'pot-cli' }),
  );
  check('config_hash stabil über wiederholte Auflösung', h1 === h2, h1);
  check('config_hash ist 64-hex', /^[0-9a-f]{64}$/.test(h1));

  const shuffled = {};
  for (const alias of [...KNOWN_ALIASES].reverse()) {
    const entry = ARTIFACT[alias];
    const rev = {};
    for (const f of [...CB_FIELDS].reverse()) rev[f] = entry[f];
    shuffled[alias] = rev;
  }
  const hShuffled = computeConfigHash(
    resolveProductionConfig(
      canaryEnv({ DQL_CB_CONFIG_BY_ALIAS: JSON.stringify(shuffled) }),
      { requiredMode: 'pot-cli' },
    ),
  );
  check('config_hash invariant gegen Key-Reihenfolge', hShuffled === h1);
}

// 4. Mandatory gate
try {
  resolveProductionConfig(canaryEnv({ DQL_CB_CONFIG_BY_ALIAS: undefined }), {
    requiredMode: 'pot-cli',
  });
  check('Canary-AKTIV ohne DQL_CB_CONFIG_BY_ALIAS wird abgelehnt', false, 'kein Throw');
} catch (e) {
  check(
    'Canary-AKTIV ohne DQL_CB_CONFIG_BY_ALIAS wird abgelehnt',
    /DQL_CB_CONFIG_BY_ALIAS/.test(String(e)),
  );
}

// 5. alias_gate_ready conjunction (Health-Handler-äquivalent)
if (config) {
  const env = canaryEnv();
  const commitSha = env.VERCEL_GIT_COMMIT_SHA || env.DQL_COMMIT_SHA || '';
  const aliasGateReady =
    config.runtime_mode === 'pot-cli' &&
    config.v0431_active &&
    config.capital_path_mode &&
    !config.disable_circuit_breaker &&
    config.diagnostics_on &&
    commitSha.length > 0 &&
    config.serv_api_key_bound;
  check('alias_gate_ready-Konjunktion erfüllt (Health-äquivalent)', aliasGateReady);
}

console.log(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAIL(S)'}`);
process.exit(failures === 0 ? 0 : 1);
