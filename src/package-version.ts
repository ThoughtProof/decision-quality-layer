/**
 * Package/artifact version — single source of truth from package.json.
 *
 * Semantics (P0 #3, Raul 2026-08-05: keep 0.2.0):
 *   PACKAGE_VERSION / health.version  = npm/package **artifact** version
 *   CONFIG_SCHEMA_VERSION             = runtime **behavior/schema** version
 *
 * Never cite `version` for feature/behavior claims.
 * Never cite `config_schema_version` as the package version.
 */
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

function readPackageVersion(): string {
  // Prefer createRequire (Node + most bundlers). Fall back to path walk for
  // environments where require(package.json) is stripped.
  try {
    const require = createRequire(import.meta.url);
    const pkg = require('../package.json') as { version: string };
    if (typeof pkg.version === 'string' && pkg.version.length > 0) return pkg.version;
  } catch {
    /* fall through */
  }
  const here = dirname(fileURLToPath(import.meta.url));
  const pkgPath = join(here, '..', 'package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version: string };
  return pkg.version;
}

/** Artifact / npm package version (e.g. "0.2.0"). Not the runtime schema. */
export const PACKAGE_VERSION: string = readPackageVersion();
