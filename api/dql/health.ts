/**
 * GET /dql/health
 *
 * Liveness + resolved-config fingerprint endpoint.
 *
 * v0.4.3.1 §D (Hermes 2026-07-11):
 *   - When runtime resolves cleanly (in whichever mode env implies), returns
 *     200 with { status: 'ok', runtime_mode, capital_path_mode, config_hash }.
 *   - When resolution fails (missing / invalid safety-relevant env), returns
 *     503 with { status: 'unhealthy', reasons: [...] }.
 *
 * The endpoint reads env and calls the same resolver used at cold-start,
 * so /dql/health is a self-test of the runtime the /dql/verify endpoint
 * would use.
 *
 * SECURITY: this endpoint MUST NOT return raw secrets. `serv_api_key_bound`
 * is a boolean, never the key value. `config_hash` is a SHA-256 fingerprint.
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import {
  resolveProductionConfig,
  computeConfigHash,
  ProductionConfigError,
  type RuntimeMode,
} from '../../src/engine/production-config.js';

const VERSION = '0.2.0';

function inferMode(env: NodeJS.ProcessEnv): RuntimeMode {
  const raw = (env.DQL_CASCADE ?? 'stub').trim().toLowerCase();
  return raw === 'pot-cli' || raw === 'potcli' || raw === 'live' ? 'pot-cli' : 'stub';
}

export default function handler(_req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('X-DQL-Version', VERSION);

  const mode = inferMode(process.env);
  try {
    const config = resolveProductionConfig(process.env, { requiredMode: mode });
    const configHash = computeConfigHash(config);
    return res.status(200).json({
      status: 'ok',
      service: 'decision-quality-layer',
      version: VERSION,
      runtime_mode: config.runtime_mode,
      capital_path_mode: config.capital_path_mode,
      diagnostics_on: config.diagnostics_on,
      config_hash: configHash,
      serv_api_key_bound: config.serv_api_key_bound,
      serv_base_url: config.serv_base_url,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    if (err instanceof ProductionConfigError) {
      return res.status(503).json({
        status: 'unhealthy',
        service: 'decision-quality-layer',
        version: VERSION,
        runtime_mode: mode,
        reasons: err.reasons,
        timestamp: new Date().toISOString(),
      });
    }
    // Any other unexpected error is also 503, but with a redacted message.
    return res.status(503).json({
      status: 'unhealthy',
      service: 'decision-quality-layer',
      version: VERSION,
      runtime_mode: mode,
      reasons: ['unexpected-resolver-error'],
      timestamp: new Date().toISOString(),
    });
  }
}
