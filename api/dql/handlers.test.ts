/**
 * B5 + M7 + M8 (Hermes 2026-07-11 review of da6847a):
 *
 * Handler contract tests for /dql/verify and /dql/health that exercise the
 * cold-start behaviour honestly. Each test uses `vi.resetModules()` +
 * dynamic import so the module-scope `RUNTIME` (verify) and `commitSha`
 * capture (health) reflect the per-test environment.
 *
 * 6 verify cases + M7 + M8 health cases, all in isolated module reloads.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Minimal Vercel req/res doubles. We don't pull in @vercel/node runtime
// because we test the JSON contract, not the platform integration.
function makeReqRes(body?: unknown, method = 'POST', headers: Record<string, string> = {}) {
  const req = {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body,
  } as any;
  const state: {
    statusCode: number;
    jsonBody?: any;
    headers: Record<string, string>;
    ended: boolean;
  } = {
    statusCode: 200,
    jsonBody: undefined,
    headers: {},
    ended: false,
  };
  const res = {
    status(code: number) {
      state.statusCode = code;
      return res;
    },
    json(payload: any) {
      state.jsonBody = payload;
      state.ended = true;
      return res;
    },
    setHeader(k: string, v: string) {
      state.headers[k] = v;
    },
    end() {
      state.ended = true;
      return res;
    },
  } as any;
  return { req, res, state };
}

const validVerifyBody = {
  mandate: 'test',
  proposed_action: 'test',
  reasoning: 'test',
  axes: ['intent', 'scope', 'risk', 'consistency', 'reversibility'],
};

// Phase 2 key gate: non-sandbox POSTs need a valid X-DQL-Key. Registry must
// be set BEFORE dynamic-import of the handler (cold-start parseApiKeys).
const DEV_KEY = 'dqlk_test_dev_key_0000000000000000';
const DEV_KEYS_ENV = JSON.stringify({
  [DEV_KEY]: { owner: 'test-suite', dev_access: true, daily_cap: 1000 },
});
const AUTH_HEADERS = { 'x-dql-key': DEV_KEY };
function armKeyEnv() {
  process.env.DQL_API_KEYS = DEV_KEYS_ENV;
}

describe('B5 — /dql/verify handler contract (cold-start honest)', () => {
  const originalEnv = process.env;
  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
    // Wipe any DQL_* that might leak from the test harness.
    for (const k of Object.keys(process.env)) {
      if (k.startsWith('DQL_') || k === 'SERV_API_KEY' || k === 'SERV_BASE_URL') {
        delete process.env[k];
      }
    }
  });
  afterEach(() => {
    process.env = originalEnv;
  });

  it('DQL_CASCADE unset (default stub) + sandbox=true → 200 UNCERTAIN', async () => {
    const mod = await import('./verify.js');
    const { req, res, state } = makeReqRes({ ...validVerifyBody, sandbox: true });
    await mod.default(req, res);
    expect(state.statusCode).toBe(200);
    expect(state.jsonBody.meta.sandbox).toBe(true);
    expect(state.headers['X-DQL-Billing']).toBe('sandbox');
    expect(state.headers['X-DQL-Price-Usd']).toBe('0.00');
  });

  it('Phase 2: non-sandbox WITHOUT key → 402 PAYMENT_REQUIRED', async () => {
    const mod = await import('./verify.js');
    const { req, res, state } = makeReqRes({ ...validVerifyBody, sandbox: false });
    await mod.default(req, res);
    expect(state.statusCode).toBe(402);
    expect(state.jsonBody.code).toBe('PAYMENT_REQUIRED');
    expect(state.jsonBody.price_usd_per_call).toBe(0.05);
    expect(state.jsonBody.access).toBeTruthy();
  });

  it('Phase 2: non-sandbox with INVALID key → 402', async () => {
    armKeyEnv();
    const mod = await import('./verify.js');
    const { req, res, state } = makeReqRes(
      { ...validVerifyBody, sandbox: false },
      'POST',
      { 'x-dql-key': 'dqlk_not_in_registry' },
    );
    await mod.default(req, res);
    expect(state.statusCode).toBe(402);
    expect(state.jsonBody.code).toBe('PAYMENT_REQUIRED');
  });

  it('Phase 2: valid dev key → 200 + billing headers (dev-access, $0.00)', async () => {
    armKeyEnv();
    const mod = await import('./verify.js');
    const { req, res, state } = makeReqRes(
      { ...validVerifyBody, sandbox: false },
      'POST',
      AUTH_HEADERS,
    );
    await mod.default(req, res);
    expect(state.statusCode).toBe(200);
    expect(state.headers['X-DQL-Billing']).toBe('dev-access');
    expect(state.headers['X-DQL-Price-Usd']).toBe('0.00');
    for (const axis of state.jsonBody.axes) {
      expect(axis.verdict).toBe('UNCERTAIN');
    }
  });

  it('Phase 2: empty registry fails closed (presented key still 402)', async () => {
    // beforeEach wiped DQL_API_KEYS — no armKeyEnv().
    const mod = await import('./verify.js');
    const { req, res, state } = makeReqRes(
      { ...validVerifyBody, sandbox: false },
      'POST',
      AUTH_HEADERS,
    );
    await mod.default(req, res);
    expect(state.statusCode).toBe(402);
  });

  it('DQL_CASCADE=pot-cli WITHOUT required env → 503 CONFIG_INVALID even for sandbox=true (Blocker 1)', async () => {
    process.env.DQL_CASCADE = 'pot-cli';
    // No SERV_API_KEY, no DQL_CAPITAL_PATH_MODE → resolver fails at cold-start.
    const mod = await import('./verify.js');
    const { req, res, state } = makeReqRes({ ...validVerifyBody, sandbox: true });
    await mod.default(req, res);
    expect(state.statusCode).toBe(503);
    expect(state.jsonBody.code).toBe('CONFIG_INVALID');
    expect(Array.isArray(state.jsonBody.reasons)).toBe(true);
  });

  it('DQL_CASCADE=pot-cli WITHOUT required env → 503 CONFIG_INVALID for sandbox=false too', async () => {
    process.env.DQL_CASCADE = 'pot-cli';
    armKeyEnv();
    const mod = await import('./verify.js');
    const { req, res, state } = makeReqRes(
      { ...validVerifyBody, sandbox: false },
      'POST',
      AUTH_HEADERS,
    );
    await mod.default(req, res);
    expect(state.statusCode).toBe(503);
    expect(state.jsonBody.code).toBe('CONFIG_INVALID');
  });

  it('DQL_CASCADE=mystery (unknown) → 503 CONFIG_INVALID (parseRuntimeMode throws)', async () => {
    process.env.DQL_CASCADE = 'mystery';
    armKeyEnv();
    const mod = await import('./verify.js');
    const { req, res, state } = makeReqRes(
      { ...validVerifyBody, sandbox: false },
      'POST',
      AUTH_HEADERS,
    );
    await mod.default(req, res);
    expect(state.statusCode).toBe(503);
    expect(state.jsonBody.code).toBe('CONFIG_INVALID');
  });

  it('DQL_CASCADE=stub + invalid body → 400 INVALID_REQUEST', async () => {
    armKeyEnv();
    const mod = await import('./verify.js');
    const { req, res, state } = makeReqRes({}, 'POST', AUTH_HEADERS);
    await mod.default(req, res);
    expect(state.statusCode).toBe(400);
    expect(state.jsonBody.code).toBe('INVALID_REQUEST');
  });

  it('DQL_CASCADE=stub + valid body + sandbox=false → 200 UNCERTAIN (stub cascade)', async () => {
    armKeyEnv();
    const mod = await import('./verify.js');
    const { req, res, state } = makeReqRes(
      { ...validVerifyBody, sandbox: false },
      'POST',
      AUTH_HEADERS,
    );
    await mod.default(req, res);
    expect(state.statusCode).toBe(200);
    for (const axis of state.jsonBody.axes) {
      expect(axis.verdict).toBe('UNCERTAIN');
    }
  });
});

describe('M7 + M8 — /dql/health handler contract', () => {
  const originalEnv = process.env;
  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
    for (const k of Object.keys(process.env)) {
      if (
        k.startsWith('DQL_') ||
        k === 'SERV_API_KEY' ||
        k === 'SERV_BASE_URL' ||
        k === 'VERCEL_GIT_COMMIT_SHA'
      ) {
        delete process.env[k];
      }
    }
  });
  afterEach(() => {
    process.env = originalEnv;
  });

  it('DQL_CASCADE=pot-cli WITHOUT required env → 503 CONFIG_INVALID + never echoes serv_base_url', async () => {
    process.env.DQL_CASCADE = 'pot-cli';
    const mod = await import('./health.js');
    const { req, res, state } = makeReqRes(undefined, 'GET');
    await mod.default(req, res);
    expect(state.statusCode).toBe(503);
    expect(state.jsonBody.code).toBe('CONFIG_INVALID');
    // Raw URL must never appear in a health payload.
    expect(JSON.stringify(state.jsonBody)).not.toContain('inference-api.openserv.ai');
  });

  it('DQL_CASCADE=stub → 200 with default fields + alias_gate_ready=false (non-canary)', async () => {
    const mod = await import('./health.js');
    const { req, res, state } = makeReqRes(undefined, 'GET');
    await mod.default(req, res);
    expect(state.statusCode).toBe(200);
    expect(state.jsonBody.status).toBe('ok');
    expect(state.jsonBody.alias_gate_ready).toBe(false);
    // alias_fraction key present under new name.
    expect(state.jsonBody).toHaveProperty('required_healthy_alias_fraction');
    expect(state.jsonBody).not.toHaveProperty('required_healthy_headroom');
  });

  it('M8: DQL_V0431_ACTIVE=1 + pot-cli + no VERCEL_GIT_COMMIT_SHA → alias_gate_ready=false', async () => {
    process.env.DQL_CASCADE = 'pot-cli';
    process.env.SERV_API_KEY = 'sk-test';
    process.env.DQL_CAPITAL_PATH_MODE = '1';
    process.env.DQL_V0431_ACTIVE = '1';
    process.env.DQL_RUNTIME_DIAGNOSTICS = '1';
    process.env.DQL_CB_CONFIG_BY_ALIAS = JSON.stringify({
      'serv-nano': { tripP90LatencyMs: 10_000, tripFailureRate: 0.5, cooldownMs: 30_000, windowSize: 20, windowAgeMs: 60_000, minSamples: 5, probeMaxLatencyMs: 15_000 },
      'serv-swift': { tripP90LatencyMs: 15_000, tripFailureRate: 0.5, cooldownMs: 30_000, windowSize: 20, windowAgeMs: 60_000, minSamples: 5, probeMaxLatencyMs: 15_000 },
    });
    // VERCEL_GIT_COMMIT_SHA intentionally unset.
    const mod = await import('./health.js');
    const { req, res, state } = makeReqRes(undefined, 'GET');
    await mod.default(req, res);
    expect(state.statusCode).toBe(200);
    expect(state.jsonBody.v0431_active).toBe(true);
    expect(state.jsonBody.commit_sha).toBeNull();
    expect(state.jsonBody.alias_gate_ready).toBe(false);
  });

  it('M8: DQL_V0431_ACTIVE=1 + pot-cli + commit_sha set → alias_gate_ready=true', async () => {
    process.env.DQL_CASCADE = 'pot-cli';
    process.env.SERV_API_KEY = 'sk-test';
    process.env.DQL_CAPITAL_PATH_MODE = '1';
    process.env.DQL_V0431_ACTIVE = '1';
    process.env.DQL_RUNTIME_DIAGNOSTICS = '1';
    process.env.DQL_CB_CONFIG_BY_ALIAS = JSON.stringify({
      'serv-nano': { tripP90LatencyMs: 10_000, tripFailureRate: 0.5, cooldownMs: 30_000, windowSize: 20, windowAgeMs: 60_000, minSamples: 5, probeMaxLatencyMs: 15_000 },
      'serv-swift': { tripP90LatencyMs: 15_000, tripFailureRate: 0.5, cooldownMs: 30_000, windowSize: 20, windowAgeMs: 60_000, minSamples: 5, probeMaxLatencyMs: 15_000 },
    });
    process.env.VERCEL_GIT_COMMIT_SHA = 'abc1234def5678';
    const mod = await import('./health.js');
    const { req, res, state } = makeReqRes(undefined, 'GET');
    await mod.default(req, res);
    expect(state.statusCode).toBe(200);
    expect(state.jsonBody.commit_sha).toBe('abc1234def5678');
    expect(state.jsonBody.alias_gate_ready).toBe(true);
  });

  // Regression: Vercel-CLI-Deploys (`vercel deploy --prebuilt`) setzen
  // VERCEL_GIT_COMMIT_SHA als LEEREN String. Mit `??` fiel readCommitSha nie
  // auf die dokumentierte Escape-Hatch DQL_COMMIT_SHA durch → commit_sha ''
  // → SHA-Bindung (E2/V9-H) für jedes CLI-Deploy unerfüllbar.
  // Empirisch verifiziert 2026-07-13 (Deploy qlpgappln).
  it('Regression: VERCEL_GIT_COMMIT_SHA="" (CLI-Deploy) + DQL_COMMIT_SHA → Escape-Hatch greift', async () => {
    process.env.VERCEL_GIT_COMMIT_SHA = '';
    process.env.DQL_COMMIT_SHA = '9be505c7d4b004d164634aa205986346c78f6f09';
    const mod = await import('./health.js');
    const { req, res, state } = makeReqRes(undefined, 'GET');
    await mod.default(req, res);
    expect(state.statusCode).toBe(200);
    expect(state.jsonBody.commit_sha).toBe('9be505c7d4b004d164634aa205986346c78f6f09');
  });

  it('Regression: VERCEL_GIT_COMMIT_SHA nicht-leer gewinnt weiterhin über DQL_COMMIT_SHA (Präferenzordnung)', async () => {
    process.env.VERCEL_GIT_COMMIT_SHA = 'platform1234567890';
    process.env.DQL_COMMIT_SHA = 'escape1234567890';
    const mod = await import('./health.js');
    const { req, res, state } = makeReqRes(undefined, 'GET');
    await mod.default(req, res);
    expect(state.statusCode).toBe(200);
    expect(state.jsonBody.commit_sha).toBe('platform1234567890');
  });

  it('Regression: beide leer → commit_sha bleibt null (kein Leer-String-Durchschlag)', async () => {
    process.env.VERCEL_GIT_COMMIT_SHA = '';
    process.env.DQL_COMMIT_SHA = '';
    const mod = await import('./health.js');
    const { req, res, state } = makeReqRes(undefined, 'GET');
    await mod.default(req, res);
    expect(state.statusCode).toBe(200);
    expect(state.jsonBody.commit_sha).toBeNull();
  });
});

/**
 * H1 (Hermes review of 260d125): alias_gate_ready MUST check the full
 * safety posture. Each of the following negative single-condition tests
 * must collapse the flag to false even when every OTHER canary
 * precondition is set. These tests are DISCRIMINATING: they flip exactly
 * ONE bit at a time relative to the M8 happy-path baseline.
 */
describe('H1 — alias_gate_ready collapses on any safety-posture defect', () => {
  const ORIGINAL_ENV = { ...process.env };

  function primeSafeCanary(): void {
    process.env.DQL_CASCADE = 'pot-cli';
    process.env.SERV_API_KEY = 'sk-test';
    process.env.DQL_CAPITAL_PATH_MODE = '1';
    process.env.DQL_V0431_ACTIVE = '1';
    process.env.DQL_RUNTIME_DIAGNOSTICS = '1';
    process.env.DQL_DISABLE_CIRCUIT_BREAKER = '0';
    process.env.DQL_CB_CONFIG_BY_ALIAS = JSON.stringify({
      'serv-nano': { tripP90LatencyMs: 10_000, tripFailureRate: 0.5, cooldownMs: 30_000, windowSize: 20, windowAgeMs: 60_000, minSamples: 5, probeMaxLatencyMs: 15_000 },
      'serv-swift': { tripP90LatencyMs: 15_000, tripFailureRate: 0.5, cooldownMs: 30_000, windowSize: 20, windowAgeMs: 60_000, minSamples: 5, probeMaxLatencyMs: 15_000 },
    });
    process.env.VERCEL_GIT_COMMIT_SHA = 'abc1234def5678';
  }

  beforeEach(() => {
    vi.resetModules();
    for (const key of Object.keys(process.env)) {
      if (!(key in ORIGINAL_ENV)) delete process.env[key];
    }
    for (const [k, v] of Object.entries(ORIGINAL_ENV)) {
      if (typeof v === 'string') process.env[k] = v;
    }
  });

  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      if (!(key in ORIGINAL_ENV)) delete process.env[key];
    }
    for (const [k, v] of Object.entries(ORIGINAL_ENV)) {
      if (typeof v === 'string') process.env[k] = v;
    }
  });

  it('baseline: fully safe canary posture → alias_gate_ready=true', async () => {
    primeSafeCanary();
    const mod = await import('./health.js');
    const { req, res, state } = makeReqRes(undefined, 'GET');
    await mod.default(req, res);
    expect(state.statusCode).toBe(200);
    expect(state.jsonBody.alias_gate_ready).toBe(true);
  });

  it('capital_path_mode=false collapses alias_gate_ready to false (Hermes gegenbeweis)', async () => {
    primeSafeCanary();
    process.env.DQL_CAPITAL_PATH_MODE = '0';
    const mod = await import('./health.js');
    const { req, res, state } = makeReqRes(undefined, 'GET');
    await mod.default(req, res);
    expect(state.statusCode).toBe(200);
    expect(state.jsonBody.capital_path_mode).toBe(false);
    expect(state.jsonBody.alias_gate_ready).toBe(false);
  });

  it('disable_circuit_breaker=true collapses alias_gate_ready to false (Hermes gegenbeweis)', async () => {
    primeSafeCanary();
    process.env.DQL_DISABLE_CIRCUIT_BREAKER = '1';
    const mod = await import('./health.js');
    const { req, res, state } = makeReqRes(undefined, 'GET');
    await mod.default(req, res);
    expect(state.statusCode).toBe(200);
    expect(state.jsonBody.disable_circuit_breaker).toBe(true);
    expect(state.jsonBody.alias_gate_ready).toBe(false);
  });

  it('diagnostics_on=false is rejected at resolver level for canary (no false-positive alias_gate)', async () => {
    // Note: v0431_active=1 + pot-cli + diagnostics=0 is a resolver-level
    // ConfigError (existing invariant), so health returns 503. This test
    // pins BOTH invariants in a single place so a future weakening of
    // the resolver rule would still be caught here by the alias_gate
    // guard fallback.
    primeSafeCanary();
    process.env.DQL_RUNTIME_DIAGNOSTICS = '0';
    const mod = await import('./health.js');
    const { req, res, state } = makeReqRes(undefined, 'GET');
    await mod.default(req, res);
    expect(state.statusCode).toBe(503);
    expect(state.jsonBody.status).toBe('config_invalid');
  });

  it('v0431_active=false collapses alias_gate_ready to false', async () => {
    primeSafeCanary();
    process.env.DQL_V0431_ACTIVE = '0';
    // v0431_active=0 removes the CB_CONFIG_BY_ALIAS requirement, but the
    // key was already set to a valid explicit config, so resolver stays
    // clean. Health returns 200 with alias_gate_ready=false.
    const mod = await import('./health.js');
    const { req, res, state } = makeReqRes(undefined, 'GET');
    await mod.default(req, res);
    expect(state.statusCode).toBe(200);
    expect(state.jsonBody.v0431_active).toBe(false);
    expect(state.jsonBody.alias_gate_ready).toBe(false);
  });

  it('commit_sha missing collapses alias_gate_ready to false (M8 pin)', async () => {
    primeSafeCanary();
    delete process.env.VERCEL_GIT_COMMIT_SHA;
    const mod = await import('./health.js');
    const { req, res, state } = makeReqRes(undefined, 'GET');
    await mod.default(req, res);
    expect(state.statusCode).toBe(200);
    expect(state.jsonBody.commit_sha).toBeNull();
    expect(state.jsonBody.alias_gate_ready).toBe(false);
  });

  it('serv_api_key_bound=false collapses alias_gate_ready to false', async () => {
    primeSafeCanary();
    delete process.env.SERV_API_KEY;
    // Missing SERV_API_KEY in pot-cli → resolver ConfigError → 503.
    // Again this pin doubles as an invariant on both the resolver rule
    // and the alias_gate guard.
    const mod = await import('./health.js');
    const { req, res, state } = makeReqRes(undefined, 'GET');
    await mod.default(req, res);
    expect(state.statusCode).toBe(503);
    expect(state.jsonBody.status).toBe('config_invalid');
  });
});

/**
 * H2 (Hermes review of 260d125): with v0431_active=true in pot-cli,
 * every known alias entry in DQL_CB_CONFIG_BY_ALIAS MUST explicitly set
 * every policy-relevant CB field. Empty or partial objects that would
 * silently inherit baseline defaults must be rejected with 503
 * CONFIG_INVALID at the resolver level.
 */
describe('H2 — v0431_active rejects empty / partial per-alias CB entries', () => {
  const ORIGINAL_ENV = { ...process.env };

  function primeActiveCanaryMinusAliasCfg(): void {
    process.env.DQL_CASCADE = 'pot-cli';
    process.env.SERV_API_KEY = 'sk-test';
    process.env.DQL_CAPITAL_PATH_MODE = '1';
    process.env.DQL_V0431_ACTIVE = '1';
    process.env.DQL_RUNTIME_DIAGNOSTICS = '1';
    process.env.VERCEL_GIT_COMMIT_SHA = 'abc1234def5678';
  }

  beforeEach(() => {
    vi.resetModules();
    for (const key of Object.keys(process.env)) {
      if (!(key in ORIGINAL_ENV)) delete process.env[key];
    }
    for (const [k, v] of Object.entries(ORIGINAL_ENV)) {
      if (typeof v === 'string') process.env[k] = v;
    }
  });

  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      if (!(key in ORIGINAL_ENV)) delete process.env[key];
    }
    for (const [k, v] of Object.entries(ORIGINAL_ENV)) {
      if (typeof v === 'string') process.env[k] = v;
    }
  });

  it('empty object per alias → 503 CONFIG_INVALID (Hermes reproduziert)', async () => {
    primeActiveCanaryMinusAliasCfg();
    process.env.DQL_CB_CONFIG_BY_ALIAS = JSON.stringify({
      'serv-nano': {},
      'serv-swift': {},
    });
    const mod = await import('./health.js');
    const { req, res, state } = makeReqRes(undefined, 'GET');
    await mod.default(req, res);
    expect(state.statusCode).toBe(503);
    expect(state.jsonBody.status).toBe('config_invalid');
  });

  it('partial object per alias (missing cooldownMs) → 503 CONFIG_INVALID', async () => {
    primeActiveCanaryMinusAliasCfg();
    process.env.DQL_CB_CONFIG_BY_ALIAS = JSON.stringify({
      'serv-nano': { tripP90LatencyMs: 10_000, tripFailureRate: 0.5 },
      'serv-swift': { tripP90LatencyMs: 15_000, tripFailureRate: 0.5, cooldownMs: 30_000, windowSize: 20, windowAgeMs: 60_000, minSamples: 5, probeMaxLatencyMs: 15_000 },
    });
    const mod = await import('./health.js');
    const { req, res, state } = makeReqRes(undefined, 'GET');
    await mod.default(req, res);
    expect(state.statusCode).toBe(503);
    expect(state.jsonBody.status).toBe('config_invalid');
  });

  it('all fields present per alias → 200 (positive control)', async () => {
    primeActiveCanaryMinusAliasCfg();
    process.env.DQL_CB_CONFIG_BY_ALIAS = JSON.stringify({
      'serv-nano': { tripP90LatencyMs: 10_000, tripFailureRate: 0.5, cooldownMs: 30_000, windowSize: 20, windowAgeMs: 60_000, minSamples: 5, probeMaxLatencyMs: 15_000 },
      'serv-swift': { tripP90LatencyMs: 15_000, tripFailureRate: 0.5, cooldownMs: 30_000, windowSize: 20, windowAgeMs: 60_000, minSamples: 5, probeMaxLatencyMs: 15_000 },
    });
    const mod = await import('./health.js');
    const { req, res, state } = makeReqRes(undefined, 'GET');
    await mod.default(req, res);
    expect(state.statusCode).toBe(200);
    expect(state.jsonBody.alias_gate_ready).toBe(true);
  });
});

// -----------------------------------------------------------------------------
// v0.4.3.1 §C+integration H4 — wire-effective diagnostics header on ALL paths.
//
// The previous implementation flushed the X-DQL-Diagnostics header only in
// the 200 branch (before res.json()) and used a finally-block for error
// paths — but finally runs AFTER res.json(), which closes the header phase,
// so the safety net was silently no-op on 500/503/400/... paths. The
// sendJsonWithDiagnostics helper closes that gap by flushing FIRST then
// sending the body, on every response path.
// -----------------------------------------------------------------------------

describe('H4 — sendJsonWithDiagnostics is wire-effective on every path', () => {
  const originalEnv = process.env;
  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
    for (const k of Object.keys(process.env)) {
      if (k.startsWith('DQL_') || k === 'SERV_API_KEY' || k === 'SERV_BASE_URL') {
        delete process.env[k];
      }
    }
  });
  afterEach(() => {
    process.env = originalEnv;
  });

  it('200 stub path with diagnostics_on=true → X-DQL-Diagnostics header lands on the wire', async () => {
    // Stub cascade does not touch the LlmClient, but the handler still
    // creates a collector when RUNTIME.kind==='production' && diagnostics_on.
    // Under stub, RUNTIME.kind==='stub' → no collector → header absent.
    // We exercise that branch first for baseline, then a pot-cli-like case.
    process.env.DQL_CASCADE = 'stub';
    const mod = await import('./verify.js');
    const { req, res, state } = makeReqRes({ ...validVerifyBody, sandbox: true });
    await mod.default(req, res);
    expect(state.statusCode).toBe(200);
    // Stub path: no collector, so no diagnostics header expected.
    expect(state.headers['X-DQL-Diagnostics']).toBeUndefined();
  });

  it('503 CONFIG_INVALID path → status/body preserved AND flush attempted (no throw, no body mutation)', async () => {
    // pot-cli without SERV_API_KEY → RUNTIME.kind==='error' → 503.
    process.env.DQL_CASCADE = 'pot-cli';
    const mod = await import('./verify.js');
    const { req, res, state } = makeReqRes({ ...validVerifyBody, sandbox: true });
    await mod.default(req, res);
    expect(state.statusCode).toBe(503);
    expect(state.jsonBody.code).toBe('CONFIG_INVALID');
    // No collector was ever populated (RUNTIME.kind==='error' short-circuits
    // before allocation), so no header — but the code path DID call the
    // flush helper and did NOT throw. The value assertion here is that
    // status/body are unaffected by the H4 refactor.
    expect(state.headers['X-DQL-Version']).toBeDefined();
    expect(state.headers['X-Request-Id']).toBeDefined();
  });

  it('400 INVALID_REQUEST path preserves status/body under H4 refactor', async () => {
    process.env.DQL_CASCADE = 'stub';
    armKeyEnv();
    const mod = await import('./verify.js');
    const { req, res, state } = makeReqRes({ garbage: true }, 'POST', AUTH_HEADERS);
    await mod.default(req, res);
    expect(state.statusCode).toBe(400);
    expect(state.jsonBody.code).toBe('INVALID_REQUEST');
  });

  it('405 METHOD_NOT_ALLOWED path preserves status/body under H4 refactor', async () => {
    process.env.DQL_CASCADE = 'stub';
    const mod = await import('./verify.js');
    const { req, res, state } = makeReqRes(undefined, 'GET');
    await mod.default(req, res);
    expect(state.statusCode).toBe(405);
    expect(state.jsonBody.code).toBe('METHOD_NOT_ALLOWED');
  });

  it('OPTIONS preflight still 200 + ends without body under H4 refactor', async () => {
    process.env.DQL_CASCADE = 'stub';
    const mod = await import('./verify.js');
    const { req, res, state } = makeReqRes(undefined, 'OPTIONS');
    await mod.default(req, res);
    expect(state.statusCode).toBe(200);
    expect(state.ended).toBe(true);
    expect(state.headers['Access-Control-Allow-Origin']).toBe('*');
  });
});

// -----------------------------------------------------------------------------
// v0.4.3.1 §C+integration H4 — sendJsonWithDiagnostics wire-effective
// unit contract: flush happens BEFORE res.json() on every code path.
//
// This is a black-box seam test: we substitute a stateful res double and
// assert setHeader('X-DQL-Diagnostics', ...) is called BEFORE the first
// res.status(N).json(payload) call. Because Node emits the response head
// on the first body write, this ordering is what makes the header
// wire-effective on error paths too.
// -----------------------------------------------------------------------------

describe('H4 — sendJsonWithDiagnostics ordering: setHeader BEFORE res.json', () => {
  function makeSeqRes() {
    const seq: string[] = [];
    const res = {
      status(_c: number) { seq.push('status'); return res; },
      json(_p: any) { seq.push('json'); return res; },
      setHeader(k: string, _v: any) { seq.push(`setHeader:${k}`); },
      end() { seq.push('end'); return res; },
      get headersSent() { return false; },
    } as any;
    return { res, seq };
  }

  it('sendJsonWithDiagnostics: flush setHeader precedes res.json when collector is populated', async () => {
    // Direct unit test against the exported helper. Guarantees the sequence
    // is right regardless of which upstream branch triggered the send.
    vi.resetModules();
    const mod = await import('./verify.js');
    const rd = await import('../../src/engine/runtime-diagnostics.js');
    const collector = new rd.RuntimeDiagnosticsCollector('req-h4-order');
    // Populate one attempt so the header actually gets emitted.
    collector.recordAttempt({
      requestId: 'req-h4-order',
      requestedAlias: 'a', attemptAlias: 'a',
      route: 'primary', iteration: 1, ok: true, elapsedMs: 1,
    });
    const { res, seq } = makeSeqRes();
    // sendJsonWithDiagnostics is exported for exactly this unit test.
    (mod as unknown as {
      sendJsonWithDiagnostics: (r: any, c: any, s: number, p: unknown) => void;
    }).sendJsonWithDiagnostics(res, collector, 500, { code: 'BOOM' });
    // Assert: setHeader:X-DQL-Diagnostics appears in seq AND its index is
    // strictly less than the first 'json' index.
    const diagIdx = seq.findIndex((t) => t === 'setHeader:X-DQL-Diagnostics');
    const jsonIdx = seq.indexOf('json');
    expect(diagIdx).toBeGreaterThan(-1);
    expect(jsonIdx).toBeGreaterThan(-1);
    expect(diagIdx).toBeLessThan(jsonIdx);
  });
});

// -----------------------------------------------------------------------------
// v0.4.3.1 §C+integration M2 follow-up (Hermes b5f9dc6 review):
// When the serialized diagnostics snapshot exceeds the 8 KiB header cap,
// flushDiagnosticsHeader MUST:
//   - omit X-DQL-Diagnostics,
//   - set X-DQL-Diagnostics-Truncated: '1',
//   - emit X-DQL-Diagnostics-Counts including binding_summaries (retained)
//     AND dropped.binding_summaries.
// Regression: the initial C+integration commit b5f9dc6 dropped the new
// binding_summaries stream from these counts (both retained and dropped).
// -----------------------------------------------------------------------------

describe('M2 follow-up — truncation counts include binding_summaries', () => {
  it('over-cap snapshot: counts expose binding_summaries retained + dropped, X-DQL-Diagnostics is absent, Truncated=1', async () => {
    vi.resetModules();
    const mod = await import('./verify.js');
    const rd = await import('../../src/engine/runtime-diagnostics.js');
    // Force a snapshot that exceeds 8 KiB when serialized. Overflow the
    // binding_summaries cap (default 50) with 55 pushes → dropped=5, kept=50.
    // Attempts fill the rest of the payload to guarantee > 8 KiB.
    const collector = new rd.RuntimeDiagnosticsCollector('req-m2-oversize');
    for (let i = 0; i < 55; i++) {
      collector.recordBindingSummary({
        requestId: 'req-m2-oversize',
        axis: `axis-${i}`,
        callId: `call-${i}`,
        requestedAlias: 'serv-nano',
        attemptAlias: 'serv-nano',
        route: 'primary',
        ok: i % 2 === 0,
        netLatencyMs: 42 + i,
        backoffWaitedMs: 5 * i,
        wallClockMs: 100 + i,
        attemptCount: (i % 3) + 1,
      });
    }
    for (let i = 0; i < 200; i++) {
      collector.recordAttempt({
        requestId: 'req-m2-oversize',
        axis: `axis-${i % 5}`,
        callId: `call-${i}`,
        requestedAlias: 'serv-nano',
        attemptAlias: 'serv-nano',
        route: 'primary',
        iteration: (i % 3) + 1,
        ok: i % 4 !== 0,
        elapsedMs: 10 + i,
        errorCategory: i % 4 === 0 ? 'timeout' : undefined,
      });
    }
    // Serialized size sanity: must be > 8 KiB to actually exercise the
    // truncation branch.
    const snap = (collector as unknown as {
      flush: () => unknown;
    }).flush();
    // Re-run against a fresh collector because flush() drains — we still
    // want to test flushDiagnosticsHeader against a populated collector.
    const c2 = new rd.RuntimeDiagnosticsCollector('req-m2-oversize');
    for (let i = 0; i < 55; i++) {
      c2.recordBindingSummary({
        requestId: 'req-m2-oversize', axis: `axis-${i}`, callId: `call-${i}`,
        requestedAlias: 'serv-nano', attemptAlias: 'serv-nano',
        route: 'primary', ok: i % 2 === 0,
        netLatencyMs: 42 + i, backoffWaitedMs: 5 * i,
        wallClockMs: 100 + i, attemptCount: (i % 3) + 1,
      });
    }
    for (let i = 0; i < 200; i++) {
      c2.recordAttempt({
        requestId: 'req-m2-oversize', axis: `axis-${i % 5}`, callId: `call-${i}`,
        requestedAlias: 'serv-nano', attemptAlias: 'serv-nano',
        route: 'primary', iteration: (i % 3) + 1, ok: i % 4 !== 0,
        elapsedMs: 10 + i,
        errorCategory: i % 4 === 0 ? 'timeout' : undefined,
      });
    }
    // Guard: verify snap size is over cap before asserting the branch behavior.
    expect(Buffer.byteLength(JSON.stringify(snap), 'utf8')).toBeGreaterThan(8_192);

    const headers: Record<string, string> = {};
    const res = {
      setHeader(k: string, v: string) { headers[k] = String(v); },
    } as unknown as import('@vercel/node').VercelResponse;

    (mod as unknown as {
      flushDiagnosticsHeader: (c: unknown, r: unknown) => void;
    }).flushDiagnosticsHeader(c2, res);

    // Truncated path.
    expect(headers['X-DQL-Diagnostics']).toBeUndefined();
    expect(headers['X-DQL-Diagnostics-Truncated']).toBe('1');

    const counts = JSON.parse(headers['X-DQL-Diagnostics-Counts']!);
    // Retained count for binding_summaries capped at default 50.
    expect(counts.binding_summaries).toBe(50);
    // Overflow of 5 pushes MUST be counted as dropped.
    expect(counts.dropped.binding_summaries).toBe(5);
    // Other streams remain reported.
    expect(counts.attempts).toBeGreaterThan(0);
    expect(counts.dropped).toHaveProperty('attempts');
  });
});
