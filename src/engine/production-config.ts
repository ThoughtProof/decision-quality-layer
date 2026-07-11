/**
 * ProductionConfig — resolved, validated, hashable (v0.4.3.1 Hardening).
 *
 * Hardening addresses Hermes Review on `8c7bba6`:
 *   B3  SERV_BASE_URL is validated (https, no creds/query/fragment) and
 *       normalised; Health redacts to endpoint_id, hash uses normalised URL.
 *   B4  Strict boolean: any set-but-invalid literal throws (no silent
 *       false). Unset → documented default per mode.
 *   B5  parseRuntimeMode enumerates allowed values; unknown → error.
 *       Health + Verify SHARE this parser (single source of truth).
 *   B6  Full v0.4.3.1 schema: DQL_V0431_ACTIVE, disableCircuitBreaker,
 *       circuitBreakerConfigByAlias (nano+swift), productLatencyCeiling
 *       MsByAlias, requiredHealthyHeadroom. Canary rule: active && live
 *       ⇒ diagnostics MUST be ON.
 *   B7  Recursive canonicalisation for nested config. Deterministic
 *       SHA-256 regardless of object-key order at any depth.
 *   M8  Error contract: ProductionConfigError.code = 'CONFIG_INVALID';
 *       Health status 'config_invalid'; Verify 503 CONFIG_INVALID.
 *   M9  Build-identity fields (commit_sha, config_schema_version) are
 *       surfaced by Health but NOT included in the config hash.
 *
 * SECURITY:
 *   • Secret VALUES never enter the config object. `serv_api_key_bound`
 *     is the only observable signal about the key's presence.
 *   • URLs with userinfo/query/fragment are rejected at resolution time.
 *   • Reasons never contain raw env VALUES for JSON/URL fields (CPM value
 *     is echoed because it is a boolean literal).
 */

import crypto from 'node:crypto';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type RuntimeMode = 'stub' | 'pot-cli';

/** Fixed monotonic schema version. Bump when the resolved shape changes. */
export const CONFIG_SCHEMA_VERSION = '0.4.3.1-hardening-1';

/** Aliases the v0.4.3.1 resolver knows about. Wired in per-alias config. */
export const KNOWN_ALIASES = ['serv-nano', 'serv-swift'] as const;
export type KnownAlias = (typeof KNOWN_ALIASES)[number];

/**
 * Per-alias CircuitBreaker knobs. Mirrors CircuitBreakerConfig from
 * circuit-breaker.ts but kept independent so the Config module doesn't
 * depend on the CB module.
 */
export interface AliasCircuitBreakerConfig {
  /** p90 network latency (ms) above which the breaker trips. */
  tripP90LatencyMs: number;
  /** failure rate in the sliding window above which the breaker trips. */
  tripFailureRate: number;
  /** cooldown in ms before HALF_OPEN probe. */
  cooldownMs: number;
}

/** Product-side latency ceiling (kept separate from CB trip). */
export interface AliasLatencyCeiling {
  /** Product SLA ceiling in ms; used by RuntimeDiagnosticsCollector. */
  p90CeilingMs: number;
}

export interface ProductionConfig {
  /** Which mode this config was resolved for. */
  runtime_mode: RuntimeMode;
  /** v0.4.3.1 canary switch: hardened path enabled iff true. */
  v0431_active: boolean;
  /** Whether capital-path calls fail closed. */
  capital_path_mode: boolean;
  /** When true, every CB is bypassed (baseline / diagnostic runs only). */
  disable_circuit_breaker: boolean;
  /**
   * Normalised, credential-free SERV base URL. Null in stub mode with
   * no explicit override.
   */
  serv_base_url: string | null;
  /**
   * Presence flag for SERV_API_KEY. Never the value.
   */
  serv_api_key_bound: boolean;
  /** cascade shape flag. */
  confirm_fail: boolean;
  /** telemetry toggle (env: DQL_RUNTIME_DIAGNOSTICS). */
  diagnostics_on: boolean;
  /** Per-alias CB knobs — validated, complete for KNOWN_ALIASES. */
  circuit_breaker_config_by_alias: Record<KnownAlias, AliasCircuitBreakerConfig>;
  /** Per-alias product latency ceiling — validated, complete. */
  product_latency_ceiling_by_alias: Record<KnownAlias, AliasLatencyCeiling>;
  /** Fraction (0..1) of aliases that must remain healthy under Gate 2. */
  required_healthy_headroom: number;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class ProductionConfigError extends Error {
  public readonly code = 'CONFIG_INVALID' as const;
  constructor(
    public readonly mode: RuntimeMode | 'unknown',
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
// Primitive parsers
// ---------------------------------------------------------------------------

const TRUTHY = new Set(['1', 'true', 'yes', 'on', 'TRUE', 'YES', 'ON']);
const FALSY = new Set(['0', 'false', 'no', 'off', 'FALSE', 'NO', 'OFF']);

/** unset | true | false | 'invalid' */
export function parseBool(raw: string | undefined): boolean | 'unset' | 'invalid' {
  if (raw === undefined || raw === '') return 'unset';
  if (TRUTHY.has(raw)) return true;
  if (FALSY.has(raw)) return false;
  return 'invalid';
}

/**
 * STRICT bool. Any set-but-invalid literal is a fatal ConfigError reason.
 * Unset → returns `defaultValue`. Callers push a reason into `reasons`
 * when the literal is invalid.
 */
function readStrictBool(
  raw: string | undefined,
  envName: string,
  defaultValue: boolean,
  reasons: string[],
): boolean {
  const parsed = parseBool(raw);
  if (parsed === 'invalid') {
    reasons.push(
      `${envName} has invalid value ${JSON.stringify(raw)}; expected boolean literal (1/0/true/false/yes/no/on/off)`,
    );
    return defaultValue;
  }
  if (parsed === 'unset') return defaultValue;
  return parsed;
}

// ---------------------------------------------------------------------------
// Runtime-mode parser (B5) — single source of truth
// ---------------------------------------------------------------------------

const MODE_ALIASES: Record<string, RuntimeMode> = {
  stub: 'stub',
  'pot-cli': 'pot-cli',
  potcli: 'pot-cli',
  live: 'pot-cli',
};

/**
 * Parse DQL_CASCADE (or equivalent) into a canonical RuntimeMode.
 *
 * Contract:
 *   • unset → 'stub' (documented default).
 *   • one of the known aliases → canonical mode.
 *   • anything else → throws ProductionConfigError immediately. No silent
 *     downgrade to stub — a typo like `pot-clii` used to succeed with mode
 *     stub. Now it fails loudly.
 */
export function parseRuntimeMode(raw: string | undefined): RuntimeMode {
  if (raw === undefined || raw === '') return 'stub';
  const canonical = MODE_ALIASES[raw.trim().toLowerCase()];
  if (canonical) return canonical;
  throw new ProductionConfigError('unknown', [
    `DQL_CASCADE has invalid value ${JSON.stringify(raw)}; expected one of stub|pot-cli|potcli|live`,
  ]);
}

// ---------------------------------------------------------------------------
// SERV_BASE_URL validator (B3)
// ---------------------------------------------------------------------------

/**
 * Validate and normalise a SERV provider URL. Rejects URLs that could
 * carry secrets or ambient state; returns a stable, redactable form.
 *
 * Rules:
 *   • Scheme MUST be https:// (Prod). In stub mode http://localhost is
 *     also permitted for local testing.
 *   • username/password MUST NOT be present.
 *   • query MUST NOT be present.
 *   • fragment MUST NOT be present.
 *   • pathname is preserved verbatim.
 *   • trailing slash is REMOVED (canonical form has no trailing slash).
 *
 * Errors are pushed onto `reasons`. Returns `null` on failure so the
 * caller can gate on `reasons.length > 0` for final throw.
 */
export function normaliseServBaseUrl(
  raw: string,
  mode: RuntimeMode,
  reasons: string[],
): string | null {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    reasons.push('SERV_BASE_URL is not a valid absolute URL');
    return null;
  }
  const isHttps = parsed.protocol === 'https:';
  const isLocalhostHttp =
    mode === 'stub' &&
    parsed.protocol === 'http:' &&
    (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1');
  if (!isHttps && !isLocalhostHttp) {
    reasons.push(
      'SERV_BASE_URL must use https:// (stub mode may use http://localhost)',
    );
    return null;
  }
  if (parsed.username !== '' || parsed.password !== '') {
    reasons.push('SERV_BASE_URL must not contain userinfo (username:password@)');
    return null;
  }
  if (parsed.search !== '') {
    reasons.push('SERV_BASE_URL must not contain a query string');
    return null;
  }
  if (parsed.hash !== '') {
    reasons.push('SERV_BASE_URL must not contain a fragment');
    return null;
  }
  // Normalise: strip trailing slash from pathname if present and pathname > '/'.
  let path = parsed.pathname;
  if (path.length > 1 && path.endsWith('/')) path = path.replace(/\/+$/, '');
  const normalised = `${parsed.protocol}//${parsed.host}${path}`;
  return normalised;
}

/**
 * Given a normalised URL, return an endpoint-id for Health surfaces.
 * Callers should prefer this over shipping the raw host.
 */
export function endpointIdFor(url: string | null): 'openserv-default' | 'custom' | 'unset' {
  if (url === null) return 'unset';
  if (url === 'https://inference-api.openserv.ai/v1') return 'openserv-default';
  return 'custom';
}

// ---------------------------------------------------------------------------
// Alias config parser (B6)
// ---------------------------------------------------------------------------

/**
 * Default per-alias CB knobs. Chosen from PR #10/#11 defaults; each alias
 * currently gets the same trip thresholds. The resolver still emits them
 * PER-ALIAS so subsequent tuning does not require a config-schema change.
 */
const DEFAULT_CB_BY_ALIAS: Record<KnownAlias, AliasCircuitBreakerConfig> = {
  'serv-nano': { tripP90LatencyMs: 8_000, tripFailureRate: 0.5, cooldownMs: 30_000 },
  'serv-swift': { tripP90LatencyMs: 15_000, tripFailureRate: 0.5, cooldownMs: 30_000 },
};

const DEFAULT_LATENCY_CEILING_BY_ALIAS: Record<KnownAlias, AliasLatencyCeiling> = {
  'serv-nano': { p90CeilingMs: 6_000 },
  'serv-swift': { p90CeilingMs: 12_000 },
};

/**
 * Optional overrides via a single JSON env: DQL_CB_CONFIG_BY_ALIAS.
 * If present, must parse to a partial map keyed by KnownAlias with
 * numeric fields; unknown aliases or non-numeric fields → error.
 */
function readCbByAlias(
  raw: string | undefined,
  reasons: string[],
): Record<KnownAlias, AliasCircuitBreakerConfig> {
  const out: Record<KnownAlias, AliasCircuitBreakerConfig> = {
    'serv-nano': { ...DEFAULT_CB_BY_ALIAS['serv-nano'] },
    'serv-swift': { ...DEFAULT_CB_BY_ALIAS['serv-swift'] },
  };
  if (raw === undefined || raw === '') return out;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    reasons.push('DQL_CB_CONFIG_BY_ALIAS is not valid JSON');
    return out;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    reasons.push('DQL_CB_CONFIG_BY_ALIAS must be a JSON object keyed by alias');
    return out;
  }
  const obj = parsed as Record<string, unknown>;
  for (const alias of Object.keys(obj)) {
    if (!(KNOWN_ALIASES as readonly string[]).includes(alias)) {
      reasons.push(
        `DQL_CB_CONFIG_BY_ALIAS contains unknown alias ${JSON.stringify(alias)}`,
      );
      continue;
    }
    const v = obj[alias];
    if (v === null || typeof v !== 'object' || Array.isArray(v)) {
      reasons.push(
        `DQL_CB_CONFIG_BY_ALIAS[${alias}] must be an object`,
      );
      continue;
    }
    const cur = out[alias as KnownAlias];
    const spec = v as Record<string, unknown>;
    for (const key of ['tripP90LatencyMs', 'tripFailureRate', 'cooldownMs'] as const) {
      if (spec[key] === undefined) continue;
      if (typeof spec[key] !== 'number' || !Number.isFinite(spec[key])) {
        reasons.push(
          `DQL_CB_CONFIG_BY_ALIAS[${alias}].${key} must be a finite number`,
        );
        continue;
      }
      cur[key] = spec[key] as number;
    }
  }
  return out;
}

function readLatencyCeilingByAlias(
  raw: string | undefined,
  reasons: string[],
): Record<KnownAlias, AliasLatencyCeiling> {
  const out: Record<KnownAlias, AliasLatencyCeiling> = {
    'serv-nano': { ...DEFAULT_LATENCY_CEILING_BY_ALIAS['serv-nano'] },
    'serv-swift': { ...DEFAULT_LATENCY_CEILING_BY_ALIAS['serv-swift'] },
  };
  if (raw === undefined || raw === '') return out;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    reasons.push('DQL_LATENCY_CEILING_BY_ALIAS is not valid JSON');
    return out;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    reasons.push(
      'DQL_LATENCY_CEILING_BY_ALIAS must be a JSON object keyed by alias',
    );
    return out;
  }
  const obj = parsed as Record<string, unknown>;
  for (const alias of Object.keys(obj)) {
    if (!(KNOWN_ALIASES as readonly string[]).includes(alias)) {
      reasons.push(
        `DQL_LATENCY_CEILING_BY_ALIAS contains unknown alias ${JSON.stringify(alias)}`,
      );
      continue;
    }
    const v = obj[alias];
    if (v === null || typeof v !== 'object' || Array.isArray(v)) {
      reasons.push(`DQL_LATENCY_CEILING_BY_ALIAS[${alias}] must be an object`);
      continue;
    }
    const spec = v as Record<string, unknown>;
    if (spec.p90CeilingMs !== undefined) {
      if (typeof spec.p90CeilingMs !== 'number' || !Number.isFinite(spec.p90CeilingMs)) {
        reasons.push(
          `DQL_LATENCY_CEILING_BY_ALIAS[${alias}].p90CeilingMs must be a finite number`,
        );
      } else {
        out[alias as KnownAlias].p90CeilingMs = spec.p90CeilingMs;
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Resolver
// ---------------------------------------------------------------------------

export interface ResolveOptions {
  requiredMode: RuntimeMode;
}

/**
 * Resolve the full v0.4.3.1 ProductionConfig from `env`.
 *
 * pot-cli contract:
 *   • SERV_API_KEY required.
 *   • DQL_CAPITAL_PATH_MODE explicit (no default).
 *   • SERV_BASE_URL defaults to https://inference-api.openserv.ai/v1
 *     if unset; if set, validated by normaliseServBaseUrl.
 *   • Canary rule (B6): v0431_active && runtime_mode==='pot-cli' →
 *     DQL_RUNTIME_DIAGNOSTICS MUST be '1'.
 */
export function resolveProductionConfig(
  env: NodeJS.ProcessEnv,
  opts: ResolveOptions,
): ProductionConfig {
  const reasons: string[] = [];
  const mode = opts.requiredMode;

  // --- capital_path_mode (safety-relevant → explicit in pot-cli) ---------
  const cpmParsed = parseBool(env.DQL_CAPITAL_PATH_MODE);
  let capitalPathMode = false;
  if (cpmParsed === 'invalid') {
    reasons.push(
      `DQL_CAPITAL_PATH_MODE has invalid value ${JSON.stringify(env.DQL_CAPITAL_PATH_MODE)}; expected boolean literal`,
    );
  } else if (cpmParsed === 'unset') {
    if (mode === 'pot-cli') {
      reasons.push(
        'DQL_CAPITAL_PATH_MODE is required in pot-cli mode; must be set explicitly to "1" or "0"',
      );
    }
  } else {
    capitalPathMode = cpmParsed;
  }

  // --- SERV_API_KEY presence --------------------------------------------
  const servApiKey = env.SERV_API_KEY;
  const servApiKeyBound = typeof servApiKey === 'string' && servApiKey.length > 0;
  if (mode === 'pot-cli' && !servApiKeyBound) {
    reasons.push('SERV_API_KEY is required in pot-cli mode');
  }

  // --- SERV_BASE_URL (B3) -----------------------------------------------
  let servBaseUrl: string | null = null;
  const rawUrl = env.SERV_BASE_URL;
  if (rawUrl !== undefined && rawUrl !== '') {
    servBaseUrl = normaliseServBaseUrl(rawUrl, mode, reasons);
  } else if (mode === 'pot-cli') {
    servBaseUrl = 'https://inference-api.openserv.ai/v1';
  }

  // --- v0431_active + disable_circuit_breaker ---------------------------
  const v0431Active = readStrictBool(env.DQL_V0431_ACTIVE, 'DQL_V0431_ACTIVE', false, reasons);
  const disableCb = readStrictBool(
    env.DQL_DISABLE_CIRCUIT_BREAKER,
    'DQL_DISABLE_CIRCUIT_BREAKER',
    false,
    reasons,
  );

  // --- confirm_fail + diagnostics ---------------------------------------
  const confirmFail = readStrictBool(env.DQL_CONFIRM_FAIL, 'DQL_CONFIRM_FAIL', false, reasons);
  const diagnosticsOn = readStrictBool(
    env.DQL_RUNTIME_DIAGNOSTICS,
    'DQL_RUNTIME_DIAGNOSTICS',
    false,
    reasons,
  );

  // --- Canary rule: active && pot-cli → diagnostics ON ------------------
  if (v0431Active && mode === 'pot-cli' && !diagnosticsOn) {
    reasons.push(
      'DQL_V0431_ACTIVE=true in pot-cli mode requires DQL_RUNTIME_DIAGNOSTICS=1',
    );
  }

  // --- per-alias CB + latency ceilings ----------------------------------
  const cbByAlias = readCbByAlias(env.DQL_CB_CONFIG_BY_ALIAS, reasons);
  const latencyByAlias = readLatencyCeilingByAlias(
    env.DQL_LATENCY_CEILING_BY_ALIAS,
    reasons,
  );

  // --- required_healthy_headroom ----------------------------------------
  let requiredHealthyHeadroom = 0.5;
  if (env.DQL_REQUIRED_HEALTHY_HEADROOM !== undefined && env.DQL_REQUIRED_HEALTHY_HEADROOM !== '') {
    const n = Number(env.DQL_REQUIRED_HEALTHY_HEADROOM);
    if (!Number.isFinite(n) || n < 0 || n > 1) {
      reasons.push(
        `DQL_REQUIRED_HEALTHY_HEADROOM must be a number in [0,1]; got ${JSON.stringify(env.DQL_REQUIRED_HEALTHY_HEADROOM)}`,
      );
    } else {
      requiredHealthyHeadroom = n;
    }
  }

  if (reasons.length > 0) {
    throw new ProductionConfigError(mode, reasons);
  }

  return {
    runtime_mode: mode,
    v0431_active: v0431Active,
    capital_path_mode: capitalPathMode,
    disable_circuit_breaker: disableCb,
    serv_base_url: servBaseUrl,
    serv_api_key_bound: servApiKeyBound,
    confirm_fail: confirmFail,
    diagnostics_on: diagnosticsOn,
    circuit_breaker_config_by_alias: cbByAlias,
    product_latency_ceiling_by_alias: latencyByAlias,
    required_healthy_headroom: requiredHealthyHeadroom,
  };
}

// ---------------------------------------------------------------------------
// Recursive canonical hash (B7)
// ---------------------------------------------------------------------------

/**
 * Return a canonical JSON string for any JSON-safe value.
 *
 * Rules:
 *   • primitives: JSON.stringify verbatim.
 *   • arrays: `[e0,e1,...]` — order preserved, each element canonicalised.
 *   • objects: `{k0:v0,k1:v1,...}` with keys sorted ascending, each
 *     value canonicalised recursively.
 *   • undefined values on objects are omitted (mirroring JSON.stringify).
 *
 * The output is a deterministic byte-string. Two structurally-equal
 * inputs produce identical output regardless of insertion order at ANY
 * depth. This replaces the shallow `JSON.stringify(x, sortedTopKeys)`
 * pattern which silently dropped nested keys not listed at the top.
 */
export function canonicaliseJson(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      // JSON.stringify would emit `null`; canonicalisation must be explicit.
      return 'null';
    }
    return JSON.stringify(value);
  }
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (Array.isArray(value)) {
    return '[' + value.map((v) => canonicaliseJson(v)).join(',') + ']';
  }
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj)
      .filter((k) => obj[k] !== undefined)
      .sort();
    return (
      '{' +
      keys
        .map((k) => JSON.stringify(k) + ':' + canonicaliseJson(obj[k]))
        .join(',') +
      '}'
    );
  }
  // functions / symbols / undefined at the top level → null (defensive)
  return 'null';
}

/**
 * Deterministic SHA-256 fingerprint of the resolved config.
 *
 * The hash MUST NOT include:
 *   • secret values (SERV_API_KEY value; only `serv_api_key_bound` is hashed).
 *   • build identity (commit_sha, config_schema_version).
 * The hash MUST include:
 *   • every runtime-behaviour-affecting field of ProductionConfig.
 */
export function computeConfigHash(config: ProductionConfig): string {
  const canonical = {
    capital_path_mode: config.capital_path_mode,
    circuit_breaker_config_by_alias: config.circuit_breaker_config_by_alias,
    confirm_fail: config.confirm_fail,
    diagnostics_on: config.diagnostics_on,
    disable_circuit_breaker: config.disable_circuit_breaker,
    product_latency_ceiling_by_alias: config.product_latency_ceiling_by_alias,
    required_healthy_headroom: config.required_healthy_headroom,
    runtime_mode: config.runtime_mode,
    serv_api_key_bound: config.serv_api_key_bound,
    serv_base_url: config.serv_base_url,
    v0431_active: config.v0431_active,
  };
  const payload = canonicaliseJson(canonical);
  return crypto.createHash('sha256').update(payload, 'utf8').digest('hex');
}
