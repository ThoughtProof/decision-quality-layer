/**
 * ProductionConfig — resolved, validated, hashable.
 *
 * v0.4.3.1 §C.2-follow-up + §D (Hermes 2026-07-11):
 * The ProductionRuntime constructor previously used silent `?? false` defaults
 * for safety-relevant knobs (capitalPathMode). This file introduces a
 * mode-aware resolver that FORCES explicit configuration for prod and admits
 * looser defaults for stub-only paths.
 *
 * Key properties:
 *   1. `resolveProductionConfig(env, { requiredMode })` returns a
 *      ProductionConfig or throws ProductionConfigError with a precise
 *      list of missing/invalid keys.
 *   2. `computeConfigHash(config)` returns a deterministic SHA-256 of
 *      the canonicalized config JSON — exposed via /dql/health and used
 *      by benchmark manifests to fingerprint the runtime that produced
 *      a dataset.
 *   3. Values are read from a passed `env` map, NEVER from `process.env`
 *      directly, so the resolver is trivially testable.
 *
 * Explicitly excluded: SECRETS (API keys). The presence of an API key is
 * validated, but its value never enters the hash.
 */

import crypto from 'node:crypto';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type RuntimeMode = 'stub' | 'pot-cli';

export interface ProductionConfig {
  /** Whether the DQL cascade runs against real providers or stubs. */
  runtime_mode: RuntimeMode;
  /**
   * When true, both primary and fallback SERV aliases must be certified
   * before fallback is enabled. When false, fallback is enabled per PR #10
   * design. Required explicitly in pot-cli mode — no default fallback.
   */
  capital_path_mode: boolean;
  /**
   * SERV base URL. Present only when applicable to the mode; hashed as-is.
   */
  serv_base_url: string | null;
  /**
   * Whether a SERV_API_KEY is bound in env. The KEY VALUE is never included
   * in the hash. This boolean is enough to invalidate hashes when a key
   * appears/disappears.
   */
  serv_api_key_bound: boolean;
  /** Cascade config-shape flag from env. */
  confirm_fail: boolean;
  /**
   * Diagnostics ON/OFF. Enables per-request RuntimeDiagnosticsCollector
   * wiring (populated in a follow-up commit). Included in the hash so a
   * diagnostics-toggle explicitly forces a new fingerprint.
   */
  diagnostics_on: boolean;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class ProductionConfigError extends Error {
  constructor(
    public readonly mode: RuntimeMode,
    public readonly reasons: readonly string[],
  ) {
    super(
      `[production-config] ${mode} mode: config resolution failed — ` +
        reasons.map((r, i) => `(${i + 1}) ${r}`).join(' | '),
    );
    this.name = 'ProductionConfigError';
  }
}

// ---------------------------------------------------------------------------
// Resolver
// ---------------------------------------------------------------------------

export interface ResolveOptions {
  /**
   * Which mode the caller expects. In pot-cli mode the resolver enforces
   * every safety-relevant knob to be explicit. In stub mode looser defaults
   * are admissible because no real provider is contacted.
   */
  requiredMode: RuntimeMode;
}

const TRUTHY = new Set(['1', 'true', 'yes', 'on', 'TRUE', 'YES', 'ON']);
const FALSY = new Set(['0', 'false', 'no', 'off', 'FALSE', 'NO', 'OFF']);

function parseExplicitBool(raw: string | undefined): boolean | 'unset' | 'invalid' {
  if (raw === undefined || raw === '') return 'unset';
  if (TRUTHY.has(raw)) return true;
  if (FALSY.has(raw)) return false;
  return 'invalid';
}

function readOptionalBool(raw: string | undefined, defaultValue: boolean): boolean {
  if (raw === undefined || raw === '') return defaultValue;
  if (TRUTHY.has(raw)) return true;
  if (FALSY.has(raw)) return false;
  return defaultValue;
}

/**
 * Resolve a fully-validated ProductionConfig from `env`. Throws
 * ProductionConfigError on any failure with a precise reason list.
 *
 * The prod contract (requiredMode='pot-cli'):
 *   • SERV_API_KEY must be set (value is not hashed).
 *   • DQL_CAPITAL_PATH_MODE must be explicitly '1'|'true'|... or '0'|'false'|...
 *     — no implicit default under prod. Ambiguity in a safety-relevant
 *     knob is not acceptable.
 *   • SERV_BASE_URL falls back to the OpenServ default. This IS part of
 *     the hash so a URL change forces a new fingerprint.
 *
 * The stub contract (requiredMode='stub'):
 *   • No provider connectivity required.
 *   • capital_path_mode defaults to `false` if unset, because the stub
 *     cannot contact a provider and the flag has no runtime effect there.
 *     Explicit values are still respected.
 */
export function resolveProductionConfig(
  env: NodeJS.ProcessEnv,
  opts: ResolveOptions,
): ProductionConfig {
  const reasons: string[] = [];
  const mode = opts.requiredMode;

  // --- capital_path_mode -----------------------------------------------
  const cpmRaw = env.DQL_CAPITAL_PATH_MODE;
  const cpmParsed = parseExplicitBool(cpmRaw);
  let capitalPathMode: boolean;
  if (mode === 'pot-cli') {
    if (cpmParsed === 'unset') {
      reasons.push(
        'DQL_CAPITAL_PATH_MODE is required in pot-cli mode; must be set explicitly to "1" or "0"',
      );
      capitalPathMode = false; // placeholder; will throw below
    } else if (cpmParsed === 'invalid') {
      reasons.push(
        `DQL_CAPITAL_PATH_MODE has invalid value ${JSON.stringify(cpmRaw)}; expected boolean literal`,
      );
      capitalPathMode = false;
    } else {
      capitalPathMode = cpmParsed;
    }
  } else {
    if (cpmParsed === 'invalid') {
      reasons.push(
        `DQL_CAPITAL_PATH_MODE has invalid value ${JSON.stringify(cpmRaw)}; expected boolean literal`,
      );
      capitalPathMode = false;
    } else if (cpmParsed === 'unset') {
      capitalPathMode = false;
    } else {
      capitalPathMode = cpmParsed;
    }
  }

  // --- serv_api_key_bound + serv_base_url ------------------------------
  const servApiKey = env.SERV_API_KEY;
  const servApiKeyBound = typeof servApiKey === 'string' && servApiKey.length > 0;
  if (mode === 'pot-cli' && !servApiKeyBound) {
    reasons.push('SERV_API_KEY is required in pot-cli mode');
  }

  const servBaseUrlRaw = env.SERV_BASE_URL;
  const servBaseUrl =
    typeof servBaseUrlRaw === 'string' && servBaseUrlRaw.length > 0
      ? servBaseUrlRaw
      : mode === 'pot-cli'
        ? 'https://inference-api.openserv.ai/v1'
        : null;

  // --- confirm_fail (cascade shape) ------------------------------------
  const confirmFail = readOptionalBool(env.DQL_CONFIRM_FAIL, false);

  // --- diagnostics_on --------------------------------------------------
  // v0.4.3.1 §D-Hermes: Diagnostics is a first-class runtime toggle. In
  // pot-cli under active canary we WILL require this to be '1' (enforced
  // by a separate policy check outside the resolver). Here we only parse.
  const diagnosticsOn = readOptionalBool(env.DQL_DIAGNOSTICS_ON, false);

  if (reasons.length > 0) {
    throw new ProductionConfigError(mode, reasons);
  }

  return {
    runtime_mode: mode,
    capital_path_mode: capitalPathMode,
    serv_base_url: servBaseUrl,
    serv_api_key_bound: servApiKeyBound,
    confirm_fail: confirmFail,
    diagnostics_on: diagnosticsOn,
  };
}

// ---------------------------------------------------------------------------
// Canonical hash
// ---------------------------------------------------------------------------

/**
 * Deterministic SHA-256 fingerprint of the resolved config.
 *
 * Canonicalisation rules:
 *   1. Keys are emitted in a fixed alphabetical order (independent of any
 *      runtime object-property order).
 *   2. Booleans are emitted as `true`/`false` string literals in JSON.
 *   3. `null` is emitted as the JSON literal `null`.
 *   4. SECRETS are never in the config object — only the bound-boolean is.
 *
 * The resulting hex string is stable across processes and machines.
 * Two runtimes returning the same hash MUST have byte-identical
 * ProductionConfig values.
 */
export function computeConfigHash(config: ProductionConfig): string {
  const canonical: Record<string, unknown> = {
    capital_path_mode: config.capital_path_mode,
    confirm_fail: config.confirm_fail,
    diagnostics_on: config.diagnostics_on,
    runtime_mode: config.runtime_mode,
    serv_api_key_bound: config.serv_api_key_bound,
    serv_base_url: config.serv_base_url,
  };
  const payload = JSON.stringify(canonical, Object.keys(canonical).sort());
  return crypto.createHash('sha256').update(payload, 'utf8').digest('hex');
}
