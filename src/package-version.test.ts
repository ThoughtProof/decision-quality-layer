/**
 * P0 #3 — version semantics: package artifact version must stay in lockstep
 * with package.json, and stay distinct from the runtime schema version.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PACKAGE_VERSION } from './package-version.js';
import { CONFIG_SCHEMA_VERSION } from './engine/production-config.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
  version: string;
};

describe('version semantics (P0 #3)', () => {
  it('PACKAGE_VERSION equals package.json version (health==package)', () => {
    expect(PACKAGE_VERSION).toBe(pkg.version);
    expect(PACKAGE_VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('config_schema_version is distinct from package artifact version', () => {
    // Orthogonal axes: never treat them as interchangeable.
    expect(CONFIG_SCHEMA_VERSION).not.toBe(PACKAGE_VERSION);
    expect(CONFIG_SCHEMA_VERSION).toMatch(/^0\.4\.3\./);
  });

  it('api handlers import PACKAGE_VERSION rather than hardcoding 0.x.y', () => {
    // Guard against re-introducing a second hardcoded constant that drifts.
    for (const rel of [
      'api/dql/health.ts',
      'api/dql/verify.ts',
      'api/dql/structural-metrics.ts',
    ]) {
      const src = readFileSync(join(root, rel), 'utf8');
      expect(src, rel).toMatch(/PACKAGE_VERSION/);
      expect(src, rel).not.toMatch(/const VERSION = ['"]0\.\d+\.\d+['"]/);
    }
  });
});
