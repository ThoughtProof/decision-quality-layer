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
function makeReqRes(body?: unknown, method = 'POST') {
  const req = {
    method,
    headers: { 'content-type': 'application/json' },
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
    const mod = await import('./verify.js');
    const { req, res, state } = makeReqRes({ ...validVerifyBody, sandbox: false });
    await mod.default(req, res);
    expect(state.statusCode).toBe(503);
    expect(state.jsonBody.code).toBe('CONFIG_INVALID');
  });

  it('DQL_CASCADE=mystery (unknown) → 503 CONFIG_INVALID (parseRuntimeMode throws)', async () => {
    process.env.DQL_CASCADE = 'mystery';
    const mod = await import('./verify.js');
    const { req, res, state } = makeReqRes({ ...validVerifyBody, sandbox: false });
    await mod.default(req, res);
    expect(state.statusCode).toBe(503);
    expect(state.jsonBody.code).toBe('CONFIG_INVALID');
  });

  it('DQL_CASCADE=stub + invalid body → 400 INVALID_REQUEST', async () => {
    const mod = await import('./verify.js');
    const { req, res, state } = makeReqRes({}, 'POST');
    await mod.default(req, res);
    expect(state.statusCode).toBe(400);
    expect(state.jsonBody.code).toBe('INVALID_REQUEST');
  });

  it('DQL_CASCADE=stub + valid body + sandbox=false → 200 UNCERTAIN (stub cascade)', async () => {
    const mod = await import('./verify.js');
    const { req, res, state } = makeReqRes({ ...validVerifyBody, sandbox: false });
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
      'serv-nano': { tripP90LatencyMs: 10_000, tripFailureRate: 0.5, cooldownMs: 30_000 },
      'serv-swift': { tripP90LatencyMs: 15_000, tripFailureRate: 0.5, cooldownMs: 30_000 },
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
      'serv-nano': { tripP90LatencyMs: 10_000, tripFailureRate: 0.5, cooldownMs: 30_000 },
      'serv-swift': { tripP90LatencyMs: 15_000, tripFailureRate: 0.5, cooldownMs: 30_000 },
    });
    process.env.VERCEL_GIT_COMMIT_SHA = 'abc1234def5678';
    const mod = await import('./health.js');
    const { req, res, state } = makeReqRes(undefined, 'GET');
    await mod.default(req, res);
    expect(state.statusCode).toBe(200);
    expect(state.jsonBody.commit_sha).toBe('abc1234def5678');
    expect(state.jsonBody.alias_gate_ready).toBe(true);
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
      'serv-nano': { tripP90LatencyMs: 10_000, tripFailureRate: 0.5, cooldownMs: 30_000 },
      'serv-swift': { tripP90LatencyMs: 15_000, tripFailureRate: 0.5, cooldownMs: 30_000 },
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
      'serv-swift': { tripP90LatencyMs: 15_000, tripFailureRate: 0.5, cooldownMs: 30_000 },
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
      'serv-nano': { tripP90LatencyMs: 10_000, tripFailureRate: 0.5, cooldownMs: 30_000 },
      'serv-swift': { tripP90LatencyMs: 15_000, tripFailureRate: 0.5, cooldownMs: 30_000 },
    });
    const mod = await import('./health.js');
    const { req, res, state } = makeReqRes(undefined, 'GET');
    await mod.default(req, res);
    expect(state.statusCode).toBe(200);
    expect(state.jsonBody.alias_gate_ready).toBe(true);
  });
});
