/**
 * GET /dql/health
 *
 * Liveness + resolved-config fingerprint + build identity.
 *
 * v0.4.3.1 hardening (Hermes 2026-07-11 review of `8c7bba6`):
 *   • Uses parseRuntimeMode() from production-config — the SAME parser
 *     /dql/verify uses. No `inferMode()` duplicate.
 *   • 200 → { status: 'ok', ...redacted-config-view, config_hash,
 *              provider_endpoint_id, commit_sha, config_schema_version,
 *              v0431_active, active_cascade }
 *   • 503 → { status: 'config_invalid', code: 'CONFIG_INVALID',
 *              reasons: [...] }
 *   • `serv_base_url` is NEVER echoed. `provider_endpoint_id` is a
 *     stable enum ('openserv-default' | 'custom' | 'unset').
 *   • `commit_sha` / `config_schema_version` are BUILD identity; they
 *     are surfaced but NOT part of `config_hash`.
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
      capital_path_mode: config.capital_path_mode,
      disable_circuit_breaker: config.disable_circuit_breaker,
      diagnostics_on: config.diagnostics_on,
      provider_endpoint_id: endpointIdFor(config.serv_base_url),
      serv_api_key_bound: config.serv_api_key_bound,
      required_healthy_headroom: config.required_healthy_headroom,
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
    return res.status(503).json({
      status: 'config_invalid',
      code: 'CONFIG_INVALID',
      service: 'decision-quality-layer',
      version: VERSION,
      config_schema_version: CONFIG_SCHEMA_VERSION,
      commit_sha: commitSha,
      runtime_mode: mode,
      reasons: ['unexpected-resolver-error'],
      timestamp: new Date().toISOString(),
    });
  }
}
