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
