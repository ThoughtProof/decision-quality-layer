/**
 * Canary-Kalibrierung §C+integration Schritt 3 — lokaler Dry-Run (NON-PRODUCT).
 *
 * Zweck: beweisen, dass das repo-getrackte, nicht-geheime Artefakt
 * `config/canary/v0431-cb-config.json` gegen den ECHTEN Resolver
 * (`resolveProductionConfig`) und den ECHTEN Health-Handler (`api/dql/health`)
 * eine gültige Canary-Config ergibt — VOR jedem Deploy. Kein Produktcode wird
 * für diesen Test hinzugefügt; es werden ausschließlich vorhandene Contract-
 * Funktionen aufgerufen.
 *
 * Beweisziele:
 *   1. Artefakt trägt exakt die zwei Aliases und alle 7 live-konsumierten
 *      CB-Felder mit den konservativen §7-Drill-„Full“-Werten.
 *   2. Das Artefakt ist verbatim als DQL_CB_CONFIG_BY_ALIAS nutzbar: der
 *      Resolver akzeptiert es und alle 7 Felder überleben je Alias.
 *   3. computeConfigHash ist deterministisch (stabil + key-order-invariant).
 *   4. Canary-AKTIV ohne DQL_CB_CONFIG_BY_ALIAS wird abgelehnt (Pflicht-Gate).
 *   5. Die Voraussetzungen liefern im ECHTEN Health-Handler
 *      alias_gate_ready === true und status === 'ok'.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  resolveProductionConfig,
  computeConfigHash,
  KNOWN_ALIASES,
} from './production-config.js';

const ARTIFACT_URL = new URL(
  '../../config/canary/v0431-cb-config.json',
  import.meta.url,
);
const ARTIFACT_RAW = readFileSync(fileURLToPath(ARTIFACT_URL), 'utf8');

interface CbEntry {
  tripP90LatencyMs: number;
  tripFailureRate: number;
  cooldownMs: number;
  windowSize: number;
  windowAgeMs: number;
  minSamples: number;
  probeMaxLatencyMs: number;
}

const ARTIFACT = JSON.parse(ARTIFACT_RAW) as Record<string, CbEntry>;

const CB_FIELDS = [
  'tripP90LatencyMs',
  'tripFailureRate',
  'cooldownMs',
  'windowSize',
  'windowAgeMs',
  'minSamples',
  'probeMaxLatencyMs',
] as const satisfies readonly (keyof CbEntry)[];

/** Narrow away `undefined` from record indexing (noUncheckedIndexedAccess). */
function must<T>(value: T | undefined, msg: string): T {
  if (value === undefined) throw new Error(msg);
  return value;
}

/**
 * Complete non-secret canary env. The dummy key is a local test literal
 * ONLY — never a real secret and never a drill marker. It exists solely so
 * the resolver's `serv_api_key_bound` presence check passes in-process.
 */
function canaryEnv(
  overrides: Record<string, string | undefined> = {},
): NodeJS.ProcessEnv {
  const base: Record<string, string | undefined> = {
    DQL_CASCADE: 'pot-cli',
    DQL_V0431_ACTIVE: '1',
    DQL_CAPITAL_PATH_MODE: '1',
    DQL_RUNTIME_DIAGNOSTICS: '1',
    SERV_API_KEY: 'dummy-local-key-not-a-secret',
    DQL_CB_CONFIG_BY_ALIAS: ARTIFACT_RAW,
    DQL_COMMIT_SHA: '0fab28c5421f42a67bbc12f635eaf2f61700a510',
    ...overrides,
  };
  return base as unknown as NodeJS.ProcessEnv;
}

describe('Canary artifact — shape (exactly 2 aliases, 7 live CB fields)', () => {
  it('has exactly the two known aliases', () => {
    expect(Object.keys(ARTIFACT).sort()).toEqual([...KNOWN_ALIASES].sort());
  });

  it('each alias sets all 7 live-consumed CB fields as finite numbers', () => {
    for (const alias of KNOWN_ALIASES) {
      const entry = must(ARTIFACT[alias], `artifact missing alias: ${alias}`);
      expect(Object.keys(entry).sort()).toEqual([...CB_FIELDS].sort());
      for (const f of CB_FIELDS) {
        expect(Number.isFinite(entry[f])).toBe(true);
      }
    }
  });

  it('pins the conservative §7-drill "full" values', () => {
    expect(ARTIFACT['serv-nano']).toEqual({
      tripP90LatencyMs: 10000,
      tripFailureRate: 0.5,
      cooldownMs: 30000,
      windowSize: 20,
      windowAgeMs: 60000,
      minSamples: 5,
      probeMaxLatencyMs: 15000,
    });
    expect(ARTIFACT['serv-swift']).toEqual({
      tripP90LatencyMs: 15000,
      tripFailureRate: 0.5,
      cooldownMs: 30000,
      windowSize: 20,
      windowAgeMs: 60000,
      minSamples: 5,
      probeMaxLatencyMs: 15000,
    });
  });
});

describe('Canary artifact — resolver acceptance (live-consumed contract)', () => {
  it('resolves as a valid pot-cli canary config; all 7 fields survive per alias', () => {
    const config = resolveProductionConfig(canaryEnv(), {
      requiredMode: 'pot-cli',
    });
    expect(config.runtime_mode).toBe('pot-cli');
    expect(config.v0431_active).toBe(true);
    expect(config.capital_path_mode).toBe(true);
    expect(config.disable_circuit_breaker).toBe(false);
    expect(config.diagnostics_on).toBe(true);
    expect(config.serv_api_key_bound).toBe(true);
    for (const alias of KNOWN_ALIASES) {
      const resolved = must(
        config.circuit_breaker_config_by_alias[alias],
        `resolved config missing alias: ${alias}`,
      );
      const expected = must(ARTIFACT[alias], `artifact missing alias: ${alias}`);
      for (const f of CB_FIELDS) {
        expect(resolved[f]).toBe(expected[f]);
      }
    }
  });

  it('canary ACTIVE without DQL_CB_CONFIG_BY_ALIAS is rejected (mandatory gate)', () => {
    expect(() =>
      resolveProductionConfig(canaryEnv({ DQL_CB_CONFIG_BY_ALIAS: undefined }), {
        requiredMode: 'pot-cli',
      }),
    ).toThrowError(/DQL_CB_CONFIG_BY_ALIAS/);
  });
});

describe('Canary artifact — deterministic config_hash', () => {
  it('is stable across repeated resolution', () => {
    const a = computeConfigHash(
      resolveProductionConfig(canaryEnv(), { requiredMode: 'pot-cli' }),
    );
    const b = computeConfigHash(
      resolveProductionConfig(canaryEnv(), { requiredMode: 'pot-cli' }),
    );
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is invariant to key order inside the artifact JSON', () => {
    const canonical = computeConfigHash(
      resolveProductionConfig(canaryEnv(), { requiredMode: 'pot-cli' }),
    );
    // Rebuild the same aliases with reversed key insertion order.
    const shuffled: Record<string, Record<string, number>> = {};
    for (const alias of [...KNOWN_ALIASES].reverse()) {
      const entry = must(ARTIFACT[alias], `artifact missing alias: ${alias}`);
      const rev: Record<string, number> = {};
      for (const f of [...CB_FIELDS].reverse()) rev[f] = entry[f];
      shuffled[alias] = rev;
    }
    const shuffledHash = computeConfigHash(
      resolveProductionConfig(
        canaryEnv({ DQL_CB_CONFIG_BY_ALIAS: JSON.stringify(shuffled) }),
        { requiredMode: 'pot-cli' },
      ),
    );
    expect(shuffledHash).toBe(canonical);
  });
});

describe('Canary artifact — alias_gate_ready via the REAL health handler', () => {
  // health.ts computes alias_gate_ready as a 7-way conjunction inside the
  // handler. We do NOT re-implement it in product code for docs; instead we
  // invoke the actual handler and additionally cross-check the equivalent
  // explicit conjunction so the doc claim is machine-verified.
  const originalEnv = process.env;
  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
    for (const k of Object.keys(process.env)) {
      if (k.startsWith('DQL_') || k === 'SERV_API_KEY' || k === 'SERV_BASE_URL' || k === 'VERCEL_GIT_COMMIT_SHA') {
        delete process.env[k];
      }
    }
  });
  afterEach(() => {
    process.env = originalEnv;
  });

  function makeRes() {
    const state: { statusCode: number; jsonBody?: any; headers: Record<string, string> } = {
      statusCode: 200,
      jsonBody: undefined,
      headers: {},
    };
    const res = {
      status(code: number) {
        state.statusCode = code;
        return res;
      },
      json(payload: any) {
        state.jsonBody = payload;
        return res;
      },
      setHeader(k: string, v: string) {
        state.headers[k] = v;
      },
      end() {
        return res;
      },
    } as any;
    return { res, state };
  }

  it('yields status=ok and alias_gate_ready=true for the canary prerequisites', async () => {
    for (const [k, v] of Object.entries(canaryEnv())) {
      if (v !== undefined) process.env[k] = v;
    }
    const mod = await import('../../api/dql/health.js');
    const { res, state } = makeRes();
    mod.default({ method: 'GET' } as any, res);
    expect(state.statusCode).toBe(200);
    expect(state.jsonBody.status).toBe('ok');
    expect(state.jsonBody.alias_gate_ready).toBe(true);
    expect(state.jsonBody.active_cascade).toBe('pot-cli');
    expect(typeof state.jsonBody.config_hash).toBe('string');

    // Explicit conjunction (mirrors health.ts) — cross-check the doc claim.
    const c = resolveProductionConfig(process.env, { requiredMode: 'pot-cli' });
    const commitSha = process.env.VERCEL_GIT_COMMIT_SHA || process.env.DQL_COMMIT_SHA || '';
    const explicit =
      c.runtime_mode === 'pot-cli' &&
      c.v0431_active &&
      c.capital_path_mode &&
      !c.disable_circuit_breaker &&
      c.diagnostics_on &&
      commitSha.length > 0 &&
      c.serv_api_key_bound;
    expect(explicit).toBe(true);
  });
});
