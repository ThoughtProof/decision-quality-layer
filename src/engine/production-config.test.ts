/**
 * PR #12 v0.4.3.1 hardening: resolveProductionConfig, parseRuntimeMode,
 * normaliseServBaseUrl, computeConfigHash (recursive) — full test matrix.
 *
 * Addresses Hermes Review blockers:
 *   B3  URL validator (creds/query/fragment → error), endpoint_id redaction
 *   B4  Strict bool (invalid literal → error, no silent false)
 *   B5  parseRuntimeMode (unknown → error, no silent downgrade)
 *   B6  Full v0.4.3.1 schema + Canary rule (active + live → diagnostics ON)
 *   B7  Recursive canonicalisation (nested key-order irrelevant)
 *   M8  Error code CONFIG_INVALID
 */

import { describe, it, expect } from 'vitest';
import {
  resolveProductionConfig,
  computeConfigHash,
  parseRuntimeMode,
  parseBool,
  normaliseServBaseUrl,
  endpointIdFor,
  canonicaliseJson,
  ProductionConfigError,
  CONFIG_SCHEMA_VERSION,
} from './production-config.js';

const cast = (o: Record<string, string | undefined>): NodeJS.ProcessEnv =>
  o as unknown as NodeJS.ProcessEnv;

const potCliMinimum = () =>
  cast({ SERV_API_KEY: 'sk-test', DQL_CAPITAL_PATH_MODE: '0' });

// ---------------------------------------------------------------------------
// B5 — parseRuntimeMode
// ---------------------------------------------------------------------------
describe('B5 — parseRuntimeMode', () => {
  it('unset → stub (documented default)', () => {
    expect(parseRuntimeMode(undefined)).toBe('stub');
    expect(parseRuntimeMode('')).toBe('stub');
  });
  it('canonical values honored', () => {
    expect(parseRuntimeMode('stub')).toBe('stub');
    expect(parseRuntimeMode('pot-cli')).toBe('pot-cli');
    expect(parseRuntimeMode('potcli')).toBe('pot-cli');
    expect(parseRuntimeMode('live')).toBe('pot-cli');
    expect(parseRuntimeMode('POT-CLI')).toBe('pot-cli'); // case-insensitive
  });
  it('unknown value throws ConfigError with code CONFIG_INVALID', () => {
    let caught: unknown = null;
    try {
      parseRuntimeMode('pot-clii');
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ProductionConfigError);
    const err = caught as ProductionConfigError;
    expect(err.code).toBe('CONFIG_INVALID');
    expect(err.reasons[0]).toContain('DQL_CASCADE');
  });
});

// ---------------------------------------------------------------------------
// B4 — Strict bool
// ---------------------------------------------------------------------------
describe('B4 — Strict boolean parsing', () => {
  it('parseBool returns "invalid" for set-but-unknown literal', () => {
    expect(parseBool('tru')).toBe('invalid');
    expect(parseBool('maybe')).toBe('invalid');
  });
  it('invalid DQL_RUNTIME_DIAGNOSTICS literal → ConfigError (not silent OFF)', () => {
    const env = cast({
      SERV_API_KEY: 'sk-test',
      DQL_CAPITAL_PATH_MODE: '0',
      DQL_RUNTIME_DIAGNOSTICS: 'tru',
    });
    let caught: unknown = null;
    try {
      resolveProductionConfig(env, { requiredMode: 'pot-cli' });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ProductionConfigError);
    expect((caught as ProductionConfigError).reasons.some((r) =>
      r.includes('DQL_RUNTIME_DIAGNOSTICS'),
    )).toBe(true);
  });
  it('invalid DQL_CONFIRM_FAIL literal → ConfigError', () => {
    const env = cast({
      SERV_API_KEY: 'sk-test',
      DQL_CAPITAL_PATH_MODE: '0',
      DQL_CONFIRM_FAIL: 'nope',
    });
    expect(() =>
      resolveProductionConfig(env, { requiredMode: 'pot-cli' }),
    ).toThrow(ProductionConfigError);
  });
});

// ---------------------------------------------------------------------------
// B3 — SERV_BASE_URL validator
// ---------------------------------------------------------------------------
describe('B3 — SERV_BASE_URL validation + endpoint_id redaction', () => {
  it('accepts a plain https URL and strips trailing slash', () => {
    const reasons: string[] = [];
    const out = normaliseServBaseUrl('https://api.example.com/v1/', 'pot-cli', reasons);
    expect(out).toBe('https://api.example.com/v1');
    expect(reasons).toEqual([]);
  });
  it('rejects userinfo (credential-laden URL)', () => {
    const reasons: string[] = [];
    const out = normaliseServBaseUrl(
      'https://user:pw@api.example.com/v1',
      'pot-cli',
      reasons,
    );
    expect(out).toBeNull();
    expect(reasons[0]).toContain('userinfo');
  });
  it('rejects querystring', () => {
    const reasons: string[] = [];
    const out = normaliseServBaseUrl(
      'https://api.example.com/v1?token=x',
      'pot-cli',
      reasons,
    );
    expect(out).toBeNull();
    expect(reasons[0]).toContain('query');
  });
  it('rejects fragment', () => {
    const reasons: string[] = [];
    const out = normaliseServBaseUrl(
      'https://api.example.com/v1#s',
      'pot-cli',
      reasons,
    );
    expect(out).toBeNull();
    expect(reasons[0]).toContain('fragment');
  });
  it('rejects non-https in pot-cli mode', () => {
    const reasons: string[] = [];
    const out = normaliseServBaseUrl('http://api.example.com/v1', 'pot-cli', reasons);
    expect(out).toBeNull();
    expect(reasons[0]).toContain('https');
  });
  it('permits http://localhost only in stub mode', () => {
    const r1: string[] = [];
    expect(normaliseServBaseUrl('http://localhost:8080/v1', 'stub', r1)).toBe(
      'http://localhost:8080/v1',
    );
    expect(r1).toEqual([]);
    const r2: string[] = [];
    expect(normaliseServBaseUrl('http://localhost:8080/v1', 'pot-cli', r2)).toBeNull();
  });
  it('endpointIdFor: default → openserv-default, custom → custom, null → unset', () => {
    expect(endpointIdFor('https://inference-api.openserv.ai/v1')).toBe(
      'openserv-default',
    );
    expect(endpointIdFor('https://api.example.com/v1')).toBe('custom');
    expect(endpointIdFor(null)).toBe('unset');
  });
  it('resolveProductionConfig surfaces URL errors as ConfigError with reasons', () => {
    const env = cast({
      SERV_API_KEY: 'sk-test',
      DQL_CAPITAL_PATH_MODE: '0',
      SERV_BASE_URL: 'https://user:pw@api.example.com/v1',
    });
    let caught: unknown = null;
    try {
      resolveProductionConfig(env, { requiredMode: 'pot-cli' });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ProductionConfigError);
    expect((caught as ProductionConfigError).reasons.some((r) =>
      r.includes('userinfo'),
    )).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// B6 — Full schema + canary rule
// ---------------------------------------------------------------------------
describe('B6 — Full v0.4.3.1 schema', () => {
  it('resolves all required fields with defaults', () => {
    const c = resolveProductionConfig(potCliMinimum(), { requiredMode: 'pot-cli' });
    expect(c.runtime_mode).toBe('pot-cli');
    expect(c.v0431_active).toBe(false);
    expect(c.capital_path_mode).toBe(false);
    expect(c.disable_circuit_breaker).toBe(false);
    expect(c.serv_base_url).toBe('https://inference-api.openserv.ai/v1');
    expect(c.serv_api_key_bound).toBe(true);
    expect(c.confirm_fail).toBe(false);
    expect(c.diagnostics_on).toBe(false);
    expect(c.required_healthy_alias_fraction).toBe(0.5);
    // per-alias present for both known aliases
    expect(c.circuit_breaker_config_by_alias['serv-nano'].tripP90LatencyMs).toBeGreaterThan(0);
    expect(c.circuit_breaker_config_by_alias['serv-swift'].tripP90LatencyMs).toBeGreaterThan(0);
    expect(c.product_latency_ceiling_by_alias['serv-nano'].p90CeilingMs).toBeGreaterThan(0);
  });

  it('canary rule: v0431_active + pot-cli + diagnostics_on=false → ConfigError', () => {
    const env = cast({
      SERV_API_KEY: 'sk-test',
      DQL_CAPITAL_PATH_MODE: '1',
      DQL_V0431_ACTIVE: '1',
      DQL_RUNTIME_DIAGNOSTICS: '0',
    });
    let caught: unknown = null;
    try {
      resolveProductionConfig(env, { requiredMode: 'pot-cli' });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ProductionConfigError);
    expect((caught as ProductionConfigError).reasons.some((r) =>
      r.includes('DQL_V0431_ACTIVE') && r.includes('DQL_RUNTIME_DIAGNOSTICS'),
    )).toBe(true);
  });

  it('canary rule: v0431_active + pot-cli + diagnostics ON + explicit per-alias CB → resolves', () => {
    const env = cast({
      SERV_API_KEY: 'sk-test',
      DQL_CAPITAL_PATH_MODE: '1',
      DQL_V0431_ACTIVE: '1',
      DQL_RUNTIME_DIAGNOSTICS: '1',
      DQL_CB_CONFIG_BY_ALIAS: JSON.stringify({
        'serv-nano': { tripP90LatencyMs: 10_000, tripFailureRate: 0.5, cooldownMs: 30_000, windowSize: 20, windowAgeMs: 60_000, minSamples: 5, probeMaxLatencyMs: 15_000 },
        'serv-swift': { tripP90LatencyMs: 15_000, tripFailureRate: 0.5, cooldownMs: 30_000, windowSize: 20, windowAgeMs: 60_000, minSamples: 5, probeMaxLatencyMs: 15_000 },
      }),
    });
    const c = resolveProductionConfig(env, { requiredMode: 'pot-cli' });
    expect(c.v0431_active).toBe(true);
    expect(c.diagnostics_on).toBe(true);
  });

  it('canary rule: v0431_active + stub is permitted without diagnostics', () => {
    const env = cast({
      DQL_V0431_ACTIVE: '1',
      DQL_RUNTIME_DIAGNOSTICS: '0',
    });
    const c = resolveProductionConfig(env, { requiredMode: 'stub' });
    expect(c.v0431_active).toBe(true);
    expect(c.diagnostics_on).toBe(false);
  });

  it('per-alias overrides via DQL_CB_CONFIG_BY_ALIAS respected; unknown alias → error', () => {
    const env = cast({
      SERV_API_KEY: 'sk-test',
      DQL_CAPITAL_PATH_MODE: '0',
      DQL_CB_CONFIG_BY_ALIAS: JSON.stringify({
        'serv-nano': { tripP90LatencyMs: 9999 },
      }),
    });
    const c = resolveProductionConfig(env, { requiredMode: 'pot-cli' });
    expect(c.circuit_breaker_config_by_alias['serv-nano'].tripP90LatencyMs).toBe(9999);
    // swift kept default
    expect(c.circuit_breaker_config_by_alias['serv-swift'].tripP90LatencyMs).toBeGreaterThan(0);

    const badEnv = cast({
      SERV_API_KEY: 'sk-test',
      DQL_CAPITAL_PATH_MODE: '0',
      DQL_CB_CONFIG_BY_ALIAS: JSON.stringify({ 'serv-mystery': { tripP90LatencyMs: 100 } }),
    });
    expect(() => resolveProductionConfig(badEnv, { requiredMode: 'pot-cli' })).toThrow(
      ProductionConfigError,
    );
  });

  it('required_healthy_alias_fraction out-of-range → error (new name)', () => {
    const env = cast({
      SERV_API_KEY: 'sk-test',
      DQL_CAPITAL_PATH_MODE: '0',
      DQL_REQUIRED_HEALTHY_ALIAS_FRACTION: '1.5',
    });
    expect(() => resolveProductionConfig(env, { requiredMode: 'pot-cli' })).toThrow(
      ProductionConfigError,
    );
  });

  it('legacy required_healthy_headroom env still accepted for one release', () => {
    const env = cast({
      SERV_API_KEY: 'sk-test',
      DQL_CAPITAL_PATH_MODE: '0',
      DQL_REQUIRED_HEALTHY_HEADROOM: '0.7',
    });
    const c = resolveProductionConfig(env, { requiredMode: 'pot-cli' });
    expect(c.required_healthy_alias_fraction).toBe(0.7);
  });

  it('setting both new + legacy fraction env vars → error', () => {
    const env = cast({
      SERV_API_KEY: 'sk-test',
      DQL_CAPITAL_PATH_MODE: '0',
      DQL_REQUIRED_HEALTHY_ALIAS_FRACTION: '0.6',
      DQL_REQUIRED_HEALTHY_HEADROOM: '0.7',
    });
    let caught: unknown = null;
    try {
      resolveProductionConfig(env, { requiredMode: 'pot-cli' });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ProductionConfigError);
    expect((caught as ProductionConfigError).reasons.some((r) =>
      r.includes('both set'),
    )).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// B4 (Hermes 2026-07-11) — per-alias numeric bounds + unknown-key rejection
// ---------------------------------------------------------------------------
describe('B4 — per-alias config bounds', () => {
  function withCb(cb: Record<string, unknown>): NodeJS.ProcessEnv {
    return cast({
      SERV_API_KEY: 'sk-test',
      DQL_CAPITAL_PATH_MODE: '0',
      DQL_CB_CONFIG_BY_ALIAS: JSON.stringify(cb),
    });
  }

  it('rejects tripP90LatencyMs ≤ 0', () => {
    expect(() =>
      resolveProductionConfig(withCb({ 'serv-nano': { tripP90LatencyMs: 0 } }), {
        requiredMode: 'pot-cli',
      }),
    ).toThrow(ProductionConfigError);
    expect(() =>
      resolveProductionConfig(withCb({ 'serv-nano': { tripP90LatencyMs: -100 } }), {
        requiredMode: 'pot-cli',
      }),
    ).toThrow(ProductionConfigError);
  });

  it('rejects tripFailureRate outside [0,1]', () => {
    expect(() =>
      resolveProductionConfig(withCb({ 'serv-nano': { tripFailureRate: 7 } }), {
        requiredMode: 'pot-cli',
      }),
    ).toThrow(ProductionConfigError);
    expect(() =>
      resolveProductionConfig(withCb({ 'serv-nano': { tripFailureRate: -0.1 } }), {
        requiredMode: 'pot-cli',
      }),
    ).toThrow(ProductionConfigError);
  });

  it('rejects negative cooldownMs', () => {
    expect(() =>
      resolveProductionConfig(withCb({ 'serv-nano': { cooldownMs: -1 } }), {
        requiredMode: 'pot-cli',
      }),
    ).toThrow(ProductionConfigError);
  });

  it('rejects unknown keys inside a per-alias CB object (no silent default)', () => {
    expect(() =>
      resolveProductionConfig(
        withCb({ 'serv-nano': { tripP90LatencyMs: 5_000, mystery: 42 } }),
        { requiredMode: 'pot-cli' },
      ),
    ).toThrow(ProductionConfigError);
  });

  it('rejects p90CeilingMs ≤ 0 in latency-ceiling override', () => {
    const env = cast({
      SERV_API_KEY: 'sk-test',
      DQL_CAPITAL_PATH_MODE: '0',
      DQL_LATENCY_CEILING_BY_ALIAS: JSON.stringify({
        'serv-nano': { p90CeilingMs: 0 },
      }),
    });
    expect(() => resolveProductionConfig(env, { requiredMode: 'pot-cli' })).toThrow(
      ProductionConfigError,
    );
  });

  it('rejects unknown keys inside a per-alias latency-ceiling object', () => {
    const env = cast({
      SERV_API_KEY: 'sk-test',
      DQL_CAPITAL_PATH_MODE: '0',
      DQL_LATENCY_CEILING_BY_ALIAS: JSON.stringify({
        'serv-nano': { p90CeilingMs: 10_000, mystery: 1 },
      }),
    });
    expect(() => resolveProductionConfig(env, { requiredMode: 'pot-cli' })).toThrow(
      ProductionConfigError,
    );
  });
});

// ---------------------------------------------------------------------------
// B2 (Hermes 2026-07-11) — v0431_active shadow-mode invariant
// ---------------------------------------------------------------------------
describe('B2 — v0431_active requires explicit per-alias CB config', () => {
  it('v0431_active=true without DQL_CB_CONFIG_BY_ALIAS → ConfigError', () => {
    const env = cast({
      SERV_API_KEY: 'sk-test',
      DQL_CAPITAL_PATH_MODE: '1',
      DQL_V0431_ACTIVE: '1',
      DQL_RUNTIME_DIAGNOSTICS: '1',
    });
    let caught: unknown = null;
    try {
      resolveProductionConfig(env, { requiredMode: 'pot-cli' });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ProductionConfigError);
    expect((caught as ProductionConfigError).reasons.some((r) =>
      r.includes('DQL_CB_CONFIG_BY_ALIAS') && r.includes('every known alias'),
    )).toBe(true);
  });

  it('v0431_active=true with only one alias entry → ConfigError', () => {
    const env = cast({
      SERV_API_KEY: 'sk-test',
      DQL_CAPITAL_PATH_MODE: '1',
      DQL_V0431_ACTIVE: '1',
      DQL_RUNTIME_DIAGNOSTICS: '1',
      DQL_CB_CONFIG_BY_ALIAS: JSON.stringify({
        'serv-nano': { tripP90LatencyMs: 10_000, tripFailureRate: 0.5, cooldownMs: 30_000, windowSize: 20, windowAgeMs: 60_000, minSamples: 5, probeMaxLatencyMs: 15_000 },
      }),
    });
    let caught: unknown = null;
    try {
      resolveProductionConfig(env, { requiredMode: 'pot-cli' });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ProductionConfigError);
    expect((caught as ProductionConfigError).reasons.some((r) =>
      r.includes('serv-swift'),
    )).toBe(true);
  });

  it('v0431_active=true with entries for all known aliases → resolves', () => {
    const env = cast({
      SERV_API_KEY: 'sk-test',
      DQL_CAPITAL_PATH_MODE: '1',
      DQL_V0431_ACTIVE: '1',
      DQL_RUNTIME_DIAGNOSTICS: '1',
      DQL_CB_CONFIG_BY_ALIAS: JSON.stringify({
        'serv-nano': { tripP90LatencyMs: 10_000, tripFailureRate: 0.5, cooldownMs: 30_000, windowSize: 20, windowAgeMs: 60_000, minSamples: 5, probeMaxLatencyMs: 15_000 },
        'serv-swift': { tripP90LatencyMs: 15_000, tripFailureRate: 0.5, cooldownMs: 30_000, windowSize: 20, windowAgeMs: 60_000, minSamples: 5, probeMaxLatencyMs: 15_000 },
      }),
    });
    const c = resolveProductionConfig(env, { requiredMode: 'pot-cli' });
    expect(c.v0431_active).toBe(true);
    expect(c.circuit_breaker_config_by_alias['serv-nano'].tripP90LatencyMs).toBe(10_000);
  });

  it('v0431_active=false: baseline defaults for BOTH aliases are the SAME (15s)', () => {
    const c = resolveProductionConfig(potCliMinimum(), { requiredMode: 'pot-cli' });
    expect(c.v0431_active).toBe(false);
    expect(c.circuit_breaker_config_by_alias['serv-nano'].tripP90LatencyMs).toBe(15_000);
    expect(c.circuit_breaker_config_by_alias['serv-swift'].tripP90LatencyMs).toBe(15_000);
  });
});

// ---------------------------------------------------------------------------
// Pot-cli / stub explicit-required behaviour
// ---------------------------------------------------------------------------
describe('resolveProductionConfig — mode contracts', () => {
  it('pot-cli: missing CPM → ConfigError CONFIG_INVALID', () => {
    let caught: unknown = null;
    try {
      resolveProductionConfig(
        cast({ SERV_API_KEY: 'sk' }),
        { requiredMode: 'pot-cli' },
      );
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ProductionConfigError);
    expect((caught as ProductionConfigError).code).toBe('CONFIG_INVALID');
    expect((caught as ProductionConfigError).reasons.some((r) =>
      r.includes('DQL_CAPITAL_PATH_MODE'),
    )).toBe(true);
  });

  it('pot-cli: missing SERV_API_KEY → ConfigError', () => {
    expect(() =>
      resolveProductionConfig(
        cast({ DQL_CAPITAL_PATH_MODE: '1' }),
        { requiredMode: 'pot-cli' },
      ),
    ).toThrow(ProductionConfigError);
  });

  it('pot-cli: accumulates ALL missing reasons in a single error (not first-fail)', () => {
    let caught: unknown = null;
    try {
      resolveProductionConfig(cast({}), { requiredMode: 'pot-cli' });
    } catch (e) {
      caught = e;
    }
    const joined = (caught as ProductionConfigError).reasons.join(' | ');
    expect(joined).toContain('DQL_CAPITAL_PATH_MODE');
    expect(joined).toContain('SERV_API_KEY');
  });

  it('stub: empty env OK, defaults populated', () => {
    const c = resolveProductionConfig(cast({}), { requiredMode: 'stub' });
    expect(c.runtime_mode).toBe('stub');
    expect(c.capital_path_mode).toBe(false);
    expect(c.serv_base_url).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// B7 — Recursive canonicalisation + hash
// ---------------------------------------------------------------------------
describe('B7 — computeConfigHash + canonicaliseJson', () => {
  it('canonicaliseJson: nested key order irrelevant', () => {
    const a = { z: 1, a: { y: 2, b: [1, 2, 3] } };
    const b = { a: { b: [1, 2, 3], y: 2 }, z: 1 };
    expect(canonicaliseJson(a)).toBe(canonicaliseJson(b));
  });

  it('canonicaliseJson: array order IS preserved', () => {
    expect(canonicaliseJson([1, 2, 3])).not.toBe(canonicaliseJson([3, 2, 1]));
  });

  it('same env → identical hash across two resolutions', () => {
    const env = potCliMinimum();
    const h1 = computeConfigHash(resolveProductionConfig(env, { requiredMode: 'pot-cli' }));
    const h2 = computeConfigHash(resolveProductionConfig(env, { requiredMode: 'pot-cli' }));
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
  });

  it('changing CPM changes the hash', () => {
    const on = cast({ SERV_API_KEY: 'sk', DQL_CAPITAL_PATH_MODE: '1' });
    const off = cast({ SERV_API_KEY: 'sk', DQL_CAPITAL_PATH_MODE: '0' });
    expect(
      computeConfigHash(resolveProductionConfig(on, { requiredMode: 'pot-cli' })),
    ).not.toBe(
      computeConfigHash(resolveProductionConfig(off, { requiredMode: 'pot-cli' })),
    );
  });

  it('rotating SERV_API_KEY VALUE (same bound state) → hash unchanged (secret isolation)', () => {
    const a = cast({ SERV_API_KEY: 'old', DQL_CAPITAL_PATH_MODE: '1' });
    const b = cast({ SERV_API_KEY: 'new-different', DQL_CAPITAL_PATH_MODE: '1' });
    expect(
      computeConfigHash(resolveProductionConfig(a, { requiredMode: 'pot-cli' })),
    ).toBe(
      computeConfigHash(resolveProductionConfig(b, { requiredMode: 'pot-cli' })),
    );
  });

  it('changing a NESTED alias CB knob changes the hash', () => {
    const a = cast({
      SERV_API_KEY: 'sk',
      DQL_CAPITAL_PATH_MODE: '0',
      DQL_CB_CONFIG_BY_ALIAS: JSON.stringify({ 'serv-nano': { tripP90LatencyMs: 5000 } }),
    });
    const b = cast({
      SERV_API_KEY: 'sk',
      DQL_CAPITAL_PATH_MODE: '0',
      DQL_CB_CONFIG_BY_ALIAS: JSON.stringify({ 'serv-nano': { tripP90LatencyMs: 6000 } }),
    });
    expect(
      computeConfigHash(resolveProductionConfig(a, { requiredMode: 'pot-cli' })),
    ).not.toBe(
      computeConfigHash(resolveProductionConfig(b, { requiredMode: 'pot-cli' })),
    );
  });

  it('nested alias key order irrelevant (same knobs, different alias JSON key order → same hash)', () => {
    const a = cast({
      SERV_API_KEY: 'sk',
      DQL_CAPITAL_PATH_MODE: '0',
      DQL_CB_CONFIG_BY_ALIAS: JSON.stringify({
        'serv-nano': { tripP90LatencyMs: 5000 },
        'serv-swift': { tripP90LatencyMs: 12000 },
      }),
    });
    const b = cast({
      SERV_API_KEY: 'sk',
      DQL_CAPITAL_PATH_MODE: '0',
      DQL_CB_CONFIG_BY_ALIAS: JSON.stringify({
        'serv-swift': { tripP90LatencyMs: 12000 },
        'serv-nano': { tripP90LatencyMs: 5000 },
      }),
    });
    expect(
      computeConfigHash(resolveProductionConfig(a, { requiredMode: 'pot-cli' })),
    ).toBe(
      computeConfigHash(resolveProductionConfig(b, { requiredMode: 'pot-cli' })),
    );
  });

  it('SERV_BASE_URL change changes the hash (normalised value participates)', () => {
    const a = cast({
      SERV_API_KEY: 'sk',
      DQL_CAPITAL_PATH_MODE: '0',
      SERV_BASE_URL: 'https://a.example/v1',
    });
    const b = cast({
      SERV_API_KEY: 'sk',
      DQL_CAPITAL_PATH_MODE: '0',
      SERV_BASE_URL: 'https://b.example/v1',
    });
    expect(
      computeConfigHash(resolveProductionConfig(a, { requiredMode: 'pot-cli' })),
    ).not.toBe(
      computeConfigHash(resolveProductionConfig(b, { requiredMode: 'pot-cli' })),
    );
  });

  it('trailing slash on SERV_BASE_URL is normalised → hash equal to no-slash form', () => {
    const a = cast({
      SERV_API_KEY: 'sk',
      DQL_CAPITAL_PATH_MODE: '0',
      SERV_BASE_URL: 'https://a.example/v1/',
    });
    const b = cast({
      SERV_API_KEY: 'sk',
      DQL_CAPITAL_PATH_MODE: '0',
      SERV_BASE_URL: 'https://a.example/v1',
    });
    expect(
      computeConfigHash(resolveProductionConfig(a, { requiredMode: 'pot-cli' })),
    ).toBe(
      computeConfigHash(resolveProductionConfig(b, { requiredMode: 'pot-cli' })),
    );
  });

  it('schema version constant is exported and matches expected form', () => {
    expect(CONFIG_SCHEMA_VERSION).toMatch(/^0\.4\.3\.1/);
  });
});
