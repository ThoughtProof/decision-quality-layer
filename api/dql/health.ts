/**
 * GET /dql/health
 *
 * Liveness + resolved-config fingerprint + build identity.
 *
 * v0.4.3.1 hardening (Hermes 2026-07-11 review of `da6847a`):
 *   • Uses parseRuntimeMode() from production-config — the SAME parser
 *     /dql/verify uses. No `inferMode()` duplicate.
 *   • 200 → { status: 'ok', ...redacted-config-view, config_hash,
 *              provider_endpoint_id, commit_sha, config_schema_version,
 *              v0431_active, active_cascade, alias_gate_ready }
 *   • 503 → { status: 'config_invalid', code: 'CONFIG_INVALID',
 *              reasons: [...] }  (known Config/Resolver errors only)
 *   • 500 → { status: 'error', code: 'INTERNAL_ERROR', message } for
 *              unexpected bugs. NEVER re-labelled as CONFIG_INVALID —
 *              a hashing bug or handler bug is not an operator problem.
 *   • `serv_base_url` is NEVER echoed. `provider_endpoint_id` is a
 *     stable enum ('openserv-default' | 'custom' | 'unset').
 *   • `commit_sha` / `config_schema_version` are BUILD identity; they
 *     are surfaced but NOT part of `config_hash`.
 *   • `alias_gate_ready` is only true when the deploy is Canary-ready
 *     AND the safety posture is intact:
 *       - runtime_mode === 'pot-cli'
 *       - v0431_active === true
 *       - capital_path_mode === true  (fallback disabled — explicit)
 *       - disable_circuit_breaker === false  (CB actually in play)
 *       - diagnostics_on === true  (observability required for canary)
 *       - commit_sha non-empty  (deploy identity)
 *       - serv_api_key_bound === true  (provider auth wired)
 *     A safety-inactive deploy (CB disabled, CPM off, diagnostics off,
 *     null commit_sha, or missing key binding) MUST NOT be waved through
 *     by this signal — alias_gate_ready=false makes that unambiguous.
 *     Kalibrierungs- or dogfooding-modes that intentionally disable the
 *     CB MUST use a SEPARATE signal, not `alias_gate_ready` (Hermes H1).
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import {
  resolveProductionConfig,
  computeConfigHash,
  parseRuntimeMode,
  endpointIdFor,
  ProductionConfigError,
  CONFIG_SCHEMA_VERSION,
} from '../../src/engine/production-config.js';

const VERSION = '0.2.0';

function readCommitSha(env: NodeJS.ProcessEnv): string | null {
  // Vercel populates VERCEL_GIT_COMMIT_SHA automatically on every deploy.
  // DQL_COMMIT_SHA is an escape hatch for other hosts.
  return env.VERCEL_GIT_COMMIT_SHA ?? env.DQL_COMMIT_SHA ?? null;
}

export default function handler(_req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('X-DQL-Version', VERSION);

  const commitSha = readCommitSha(process.env);
  let mode;
  try {
    mode = parseRuntimeMode(process.env.DQL_CASCADE);
  } catch (e) {
    if (e instanceof ProductionConfigError) {
      return res.status(503).json({
        status: 'config_invalid',
        code: 'CONFIG_INVALID',
        service: 'decision-quality-layer',
        version: VERSION,
        config_schema_version: CONFIG_SCHEMA_VERSION,
        commit_sha: commitSha,
        reasons: e.reasons,
        timestamp: new Date().toISOString(),
      });
    }
    throw e;
  }

  try {
    const config = resolveProductionConfig(process.env, { requiredMode: mode });
    const configHash = computeConfigHash(config);
    // Alias-Gate readiness (Hermes H1 fix, 2026-07-11 review of 260d125):
    // a Canary deploy is only preflight-ready when EVERY safety-relevant
    // knob is set to its canary-safe value AND the deploy identity is
    // fully bound. Any one of the following being false collapses the
    // signal to false — no partial "looks ready" states.
    //   - pot-cli mode (Live path chosen)
    //   - v0431_active (canary flag ON)
    //   - capital_path_mode (fallback path explicitly disabled)
    //   - !disable_circuit_breaker (CB actually running)
    //   - diagnostics_on (observability required for canary)
    //   - commit_sha non-empty (deploy identity known)
    //   - serv_api_key_bound (provider auth wired)
    // Stub or non-canary deploys explicitly report alias_gate_ready=false
    // — not "n/a" — so a deploy pipeline cannot accidentally treat
    // "absence of the field" as ready. Calibration-mode deploys that
    // deliberately disable the CB MUST introduce their OWN signal; they
    // must NOT reuse this one.
    const aliasGateReady =
      config.runtime_mode === 'pot-cli' &&
      config.v0431_active &&
      config.capital_path_mode &&
      !config.disable_circuit_breaker &&
      config.diagnostics_on &&
      typeof commitSha === 'string' &&
      commitSha.length > 0 &&
      config.serv_api_key_bound;
    return res.status(200).json({
      status: 'ok',
      service: 'decision-quality-layer',
      version: VERSION,
      config_schema_version: CONFIG_SCHEMA_VERSION,
      commit_sha: commitSha,
      config_hash: configHash,
      active_cascade: config.runtime_mode,
      runtime_mode: config.runtime_mode,
      v0431_active: config.v0431_active,
      alias_gate_ready: aliasGateReady,
      capital_path_mode: config.capital_path_mode,
      disable_circuit_breaker: config.disable_circuit_breaker,
      diagnostics_on: config.diagnostics_on,
      provider_endpoint_id: endpointIdFor(config.serv_base_url),
      serv_api_key_bound: config.serv_api_key_bound,
      required_healthy_alias_fraction: config.required_healthy_alias_fraction,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    if (err instanceof ProductionConfigError) {
      return res.status(503).json({
        status: 'config_invalid',
        code: 'CONFIG_INVALID',
        service: 'decision-quality-layer',
        version: VERSION,
        config_schema_version: CONFIG_SCHEMA_VERSION,
        commit_sha: commitSha,
        runtime_mode: mode,
        reasons: err.reasons,
        timestamp: new Date().toISOString(),
      });
    }
    // M7 (Hermes 2026-07-11): unexpected internal errors are NOT operator
    // config problems. A hashing bug or handler bug must surface as 500
    // INTERNAL_ERROR with a generic redacted message, so ops teams can
    // distinguish operator-fixable Config problems from server bugs.
    return res.status(500).json({
      status: 'error',
      code: 'INTERNAL_ERROR',
      service: 'decision-quality-layer',
      version: VERSION,
      config_schema_version: CONFIG_SCHEMA_VERSION,
      commit_sha: commitSha,
      runtime_mode: mode,
      message: 'Internal server error',
      timestamp: new Date().toISOString(),
    });
  }
}
