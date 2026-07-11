/**
 * PR #12 (v0.4.3.1 §C.2-follow-up + §D): resolveProductionConfig +
 * computeConfigHash — discriminating tests.
 *
 * Contract:
 *   1. In pot-cli mode, DQL_CAPITAL_PATH_MODE and SERV_API_KEY are BOTH
 *      required. Absence throws with a precise reason list. No silent
 *      defaults for safety-relevant knobs.
 *   2. In stub mode, both are optional; capital_path_mode defaults to
 *      false but explicit values are respected.
 *   3. computeConfigHash is deterministic AND canonical:
 *      identical config → identical hash across resolvers.
 *   4. Any change to a hashed field changes the hash.
 *   5. Secrets never enter the hash: rotating SERV_API_KEY VALUE while
 *      the KEY remains bound must NOT change the hash.
 *   6. Diagnostics toggle is a hashed field: changing it MUST change
 *      the hash.
 */

import { describe, it, expect } from 'vitest';
import {
  resolveProductionConfig,
  computeConfigHash,
  ProductionConfigError,
} from './production-config.js';

const cast = (o: Record<string, string | undefined>): NodeJS.ProcessEnv =>
  o as unknown as NodeJS.ProcessEnv;

describe('PR #12 §C.2 — resolveProductionConfig', () => {
  it('pot-cli: missing DQL_CAPITAL_PATH_MODE → throws with precise reason', () => {
    const env = cast({ SERV_API_KEY: 'sk-test' });
    let caught: unknown = null;
    try {
      resolveProductionConfig(env, { requiredMode: 'pot-cli' });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ProductionConfigError);
    const err = caught as ProductionConfigError;
    expect(err.mode).toBe('pot-cli');
    expect(err.reasons.some((r) => r.includes('DQL_CAPITAL_PATH_MODE'))).toBe(true);
  });

  it('pot-cli: missing SERV_API_KEY → throws with precise reason', () => {
    const env = cast({ DQL_CAPITAL_PATH_MODE: '1' });
    let caught: unknown = null;
    try {
      resolveProductionConfig(env, { requiredMode: 'pot-cli' });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ProductionConfigError);
    const err = caught as ProductionConfigError;
    expect(err.reasons.some((r) => r.includes('SERV_API_KEY'))).toBe(true);
  });

  it('pot-cli: invalid DQL_CAPITAL_PATH_MODE literal → throws with precise reason', () => {
    const env = cast({ SERV_API_KEY: 'sk-test', DQL_CAPITAL_PATH_MODE: 'sometimes' });
    let caught: unknown = null;
    try {
      resolveProductionConfig(env, { requiredMode: 'pot-cli' });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ProductionConfigError);
    const err = caught as ProductionConfigError;
    expect(err.reasons.some((r) => r.includes('DQL_CAPITAL_PATH_MODE'))).toBe(true);
  });

  it('pot-cli: both provided → returns config with capital_path_mode=true and key bound', () => {
    const env = cast({
      SERV_API_KEY: 'sk-test',
      DQL_CAPITAL_PATH_MODE: '1',
    });
    const c = resolveProductionConfig(env, { requiredMode: 'pot-cli' });
    expect(c.runtime_mode).toBe('pot-cli');
    expect(c.capital_path_mode).toBe(true);
    expect(c.serv_api_key_bound).toBe(true);
    expect(c.serv_base_url).toBe('https://inference-api.openserv.ai/v1');
    expect(c.confirm_fail).toBe(false);
    expect(c.diagnostics_on).toBe(false);
  });

  it('pot-cli: explicit CPM=false honored (no silent flip)', () => {
    const env = cast({
      SERV_API_KEY: 'sk-test',
      DQL_CAPITAL_PATH_MODE: 'false',
    });
    const c = resolveProductionConfig(env, { requiredMode: 'pot-cli' });
    expect(c.capital_path_mode).toBe(false);
  });

  it('stub: missing SERV_API_KEY is OK, capital_path_mode defaults to false', () => {
    const env = cast({});
    const c = resolveProductionConfig(env, { requiredMode: 'stub' });
    expect(c.runtime_mode).toBe('stub');
    expect(c.capital_path_mode).toBe(false);
    expect(c.serv_api_key_bound).toBe(false);
    expect(c.serv_base_url).toBeNull();
  });

  it('stub: explicit DQL_CAPITAL_PATH_MODE=true honored', () => {
    const env = cast({ DQL_CAPITAL_PATH_MODE: 'true' });
    const c = resolveProductionConfig(env, { requiredMode: 'stub' });
    expect(c.capital_path_mode).toBe(true);
  });

  it('stub: invalid DQL_CAPITAL_PATH_MODE literal still throws (safety-relevant across modes)', () => {
    const env = cast({ DQL_CAPITAL_PATH_MODE: 'kinda' });
    let caught: unknown = null;
    try {
      resolveProductionConfig(env, { requiredMode: 'stub' });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ProductionConfigError);
  });

  it('accumulates all missing keys in a single error (not first-fail)', () => {
    const env = cast({});
    let caught: unknown = null;
    try {
      resolveProductionConfig(env, { requiredMode: 'pot-cli' });
    } catch (e) {
      caught = e;
    }
    const err = caught as ProductionConfigError;
    // Both missing keys must be reported at once.
    const joined = err.reasons.join(' | ');
    expect(joined).toContain('DQL_CAPITAL_PATH_MODE');
    expect(joined).toContain('SERV_API_KEY');
  });
});

describe('PR #12 §D — computeConfigHash canonicalisation', () => {
  it('deterministic: same config → same hash across two resolutions', () => {
    const env = cast({ SERV_API_KEY: 'sk-test', DQL_CAPITAL_PATH_MODE: '1' });
    const h1 = computeConfigHash(resolveProductionConfig(env, { requiredMode: 'pot-cli' }));
    const h2 = computeConfigHash(resolveProductionConfig(env, { requiredMode: 'pot-cli' }));
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
  });

  it('changing capital_path_mode changes the hash', () => {
    const envOn = cast({ SERV_API_KEY: 'sk-test', DQL_CAPITAL_PATH_MODE: '1' });
    const envOff = cast({ SERV_API_KEY: 'sk-test', DQL_CAPITAL_PATH_MODE: '0' });
    const h1 = computeConfigHash(resolveProductionConfig(envOn, { requiredMode: 'pot-cli' }));
    const h2 = computeConfigHash(resolveProductionConfig(envOff, { requiredMode: 'pot-cli' }));
    expect(h1).not.toBe(h2);
  });

  it('SECRET rotation with same key-bound state does NOT change the hash', () => {
    const envA = cast({ SERV_API_KEY: 'sk-old-key', DQL_CAPITAL_PATH_MODE: '1' });
    const envB = cast({ SERV_API_KEY: 'sk-new-key-completely-different', DQL_CAPITAL_PATH_MODE: '1' });
    const h1 = computeConfigHash(resolveProductionConfig(envA, { requiredMode: 'pot-cli' }));
    const h2 = computeConfigHash(resolveProductionConfig(envB, { requiredMode: 'pot-cli' }));
    // Secret VALUE must never enter the hash.
    expect(h1).toBe(h2);
  });

  it('changing SERV_BASE_URL changes the hash (it is part of the runtime fingerprint)', () => {
    const envA = cast({
      SERV_API_KEY: 'sk-test',
      DQL_CAPITAL_PATH_MODE: '1',
      SERV_BASE_URL: 'https://a.example/v1',
    });
    const envB = cast({
      SERV_API_KEY: 'sk-test',
      DQL_CAPITAL_PATH_MODE: '1',
      SERV_BASE_URL: 'https://b.example/v1',
    });
    const h1 = computeConfigHash(resolveProductionConfig(envA, { requiredMode: 'pot-cli' }));
    const h2 = computeConfigHash(resolveProductionConfig(envB, { requiredMode: 'pot-cli' }));
    expect(h1).not.toBe(h2);
  });

  it('changing diagnostics_on changes the hash', () => {
    const envA = cast({
      SERV_API_KEY: 'sk-test',
      DQL_CAPITAL_PATH_MODE: '1',
      DQL_DIAGNOSTICS_ON: '0',
    });
    const envB = cast({
      SERV_API_KEY: 'sk-test',
      DQL_CAPITAL_PATH_MODE: '1',
      DQL_DIAGNOSTICS_ON: '1',
    });
    const h1 = computeConfigHash(resolveProductionConfig(envA, { requiredMode: 'pot-cli' }));
    const h2 = computeConfigHash(resolveProductionConfig(envB, { requiredMode: 'pot-cli' }));
    expect(h1).not.toBe(h2);
  });

  it('object-key order does NOT change the hash (canonical sort)', () => {
    // Two runs across two resolutions with the same env must produce
    // identical hash regardless of how the underlying resolver populates
    // its result object internally.
    const env = cast({ SERV_API_KEY: 'sk-test', DQL_CAPITAL_PATH_MODE: '1' });
    const a = resolveProductionConfig(env, { requiredMode: 'pot-cli' });
    // Manually rebuild an object with keys in a different insertion order.
    const b = {
      serv_base_url: a.serv_base_url,
      runtime_mode: a.runtime_mode,
      diagnostics_on: a.diagnostics_on,
      confirm_fail: a.confirm_fail,
      capital_path_mode: a.capital_path_mode,
      serv_api_key_bound: a.serv_api_key_bound,
    };
    expect(computeConfigHash(a)).toBe(computeConfigHash(b as typeof a));
  });
});
