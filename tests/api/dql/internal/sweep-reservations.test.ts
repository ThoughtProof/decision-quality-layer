import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { finalizeCheckoutMint } from '../../../../src/auth/checkout.js';
import { sha256Hex } from '../../../../src/auth/key-hash.js';
import { UpstashKeyStore, createMemoryKv, selfServeOwner } from '../../../../src/auth/key-store.js';
import { DEFAULT_DAILY_CAP } from '../../../../src/auth/keys.js';
import { STARTER_CREDITS } from '../../../../src/auth/packs.js';
import { verifyPayloadDigest } from '../../../../src/auth/verify-payload.js';
import { AXES } from '../../../../src/types.js';

const harness = vi.hoisted(() => ({
  store: null as InstanceType<typeof UpstashKeyStore> | null,
}));

vi.mock('../../../../src/auth/key-store.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../src/auth/key-store.js')>();
  return {
    ...actual,
    createKeyStore: () => harness.store,
  };
});

function makeReqRes(method = 'POST', headers: Record<string, string> = {}) {
  const req = { method, headers } as any;
  const state: { statusCode: number; jsonBody?: any } = { statusCode: 200 };
  const res = {
    status(code: number) {
      state.statusCode = code;
      return res;
    },
    json(payload: any) {
      state.jsonBody = payload;
      return res;
    },
    setHeader() {
      return res;
    },
  } as any;
  return { req, res, state };
}

describe('GET|POST /dql/internal/sweep-reservations', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
    process.env.DQL_CRON_SECRET = 'sweep-test-secret';
    harness.store = new UpstashKeyStore(createMemoryKv());
  });

  afterEach(() => {
    process.env = originalEnv;
    harness.store = null;
  });

  it('is registered as a Hobby-legal once-daily Vercel cron', () => {
    const vercel = JSON.parse(readFileSync(resolve(process.cwd(), 'vercel.json'), 'utf8')) as {
      crons?: { path: string; schedule: string }[];
    };
    expect(vercel.crons).toEqual(
      expect.arrayContaining([
        { path: '/dql/internal/sweep-reservations', schedule: '0 6 * * *' },
      ]),
    );
  });

  it('rejects missing or wrong bearer', async () => {
    const mod = await import('../../../../api/dql/internal/sweep-reservations.js');
    const missing = makeReqRes('POST');
    await mod.default(missing.req, missing.res);
    expect(missing.state.statusCode).toBe(401);
    expect(missing.state.jsonBody.code).toBe('CRON_UNAUTHORIZED');

    const wrong = makeReqRes('POST', { authorization: 'Bearer nope' });
    await mod.default(wrong.req, wrong.res);
    expect(wrong.state.statusCode).toBe(401);
  });

  it('refunds an expired hold without the client retrying that id', async () => {
    const store = harness.store!;
    const minted = await finalizeCheckoutMint({
      sessionId: 'cs_sweep',
      customerId: 'cus_sweep',
      owner: selfServeOwner('cus_sweep'),
      store,
      pack: 'starter',
    });
    expect(minted.kind).toBe('minted');
    if (minted.kind !== 'minted') return;
    const hash = sha256Hex(minted.plaintext);
    const t0 = new Date(Date.now() - 16 * 60 * 1000);
    const held = await store.reserveVerify({
      requestId: 'never-retried-crash-id',
      keyHash: hash,
      payloadDigest: verifyPayloadDigest({
        mandate: 'x',
        proposed_action: 'y',
        reasoning: 'z',
        axes: [...AXES],
        sandbox: false,
      }),
      dailyCap: DEFAULT_DAILY_CAP,
      paygOptIn: false,
      now: t0,
    });
    expect(held.kind).toBe('ok');
    expect(await store.creditBalance(hash)).toBe(STARTER_CREDITS - 1);

    const mod = await import('../../../../api/dql/internal/sweep-reservations.js');
    const { req, res, state } = makeReqRes('POST', {
      authorization: 'Bearer sweep-test-secret',
    });
    await mod.default(req, res);
    expect(state.statusCode).toBe(200);
    expect(state.jsonBody.ok).toBe(true);
    expect(state.jsonBody.refunded).toBe(1);

    expect(await store.creditBalance(hash)).toBe(STARTER_CREDITS);
    expect(await store.usageToday(hash, t0)).toBe(0);
  });

  it('successful empty sweep is 200 with refunded 0', async () => {
    const mod = await import('../../../../api/dql/internal/sweep-reservations.js');
    const { req, res, state } = makeReqRes('POST', {
      authorization: 'Bearer sweep-test-secret',
    });
    await mod.default(req, res);
    expect(state.statusCode).toBe(200);
    expect(state.jsonBody.ok).toBe(true);
    expect(state.jsonBody.refunded).toBe(0);
  });

  it('injected store failure is 503 SWEEP_UNAVAILABLE, not a fake success', async () => {
    harness.store!.recoverExpiredHeldReservations = async () => ({ kind: 'error' });
    const mod = await import('../../../../api/dql/internal/sweep-reservations.js');
    const { req, res, state } = makeReqRes('POST', {
      authorization: 'Bearer sweep-test-secret',
    });
    await mod.default(req, res);
    expect(state.statusCode).toBe(503);
    expect(state.jsonBody.code).toBe('SWEEP_UNAVAILABLE');
    expect(state.jsonBody.ok).not.toBe(true);
    expect(state.statusCode).not.toBe(200);
  });
});

describe('GitHub Actions 15-minute sweep scheduler', () => {
  const workflowPath = resolve(process.cwd(), '.github/workflows/sweep-reservations.yml');
  const scriptPath = resolve(process.cwd(), 'scripts/sweep-reservations.sh');
  const cleanEnv = {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: process.env.HOME ?? '/tmp',
  };

  it('schedules */15 and workflow_dispatch; Vercel cron stays daily', () => {
    const workflow = readFileSync(workflowPath, 'utf8');
    expect(workflow).toMatch(/cron:\s*'?\*\/15 \* \* \* \*'?/);
    expect(workflow).toContain('workflow_dispatch');
    expect(workflow).toContain('scripts/sweep-reservations.sh');
    expect(workflow).not.toMatch(/continue-on-error:\s*true/);

    const vercel = JSON.parse(readFileSync(resolve(process.cwd(), 'vercel.json'), 'utf8')) as {
      crons?: { path: string; schedule: string }[];
    };
    expect(vercel.crons).toEqual(
      expect.arrayContaining([
        { path: '/dql/internal/sweep-reservations', schedule: '0 6 * * *' },
      ]),
    );
    expect(JSON.stringify(vercel.crons)).not.toContain('*/5');
  });

  it('fails closed when secrets are missing', () => {
    expect(() =>
      execFileSync('bash', [scriptPath], { env: cleanEnv, encoding: 'utf8', stdio: 'pipe' }),
    ).toThrow();
    expect(() =>
      execFileSync('bash', [scriptPath], {
        env: { ...cleanEnv, CRON_SECRET: 'tok' },
        encoding: 'utf8',
        stdio: 'pipe',
      }),
    ).toThrow();
    expect(() =>
      execFileSync('bash', [scriptPath], {
        env: { ...cleanEnv, DQL_SWEEP_URL: 'http://127.0.0.1:9/sweep' },
        encoding: 'utf8',
        stdio: 'pipe',
      }),
    ).toThrow();
  });

  it('fails the job on a non-2xx sweep response and succeeds on 200', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dql-sweep-'));
    const fakeCurl = join(dir, 'fake-curl');
    const logFile = join(dir, 'curl-args.log');
    writeFileSync(
      fakeCurl,
      `#!/usr/bin/env bash
set -euo pipefail
echo "$@" >> "${logFile}"
out=""
url=""
prev=""
for a in "$@"; do
  if [ "\${prev}" = "-o" ]; then out="$a"; fi
  url="$a"
  prev="$a"
done
if [ -n "\${out}" ]; then printf '%s' '{"ok":true}' > "\${out}"; fi
case "\${url}" in
  *fail*) printf '%s' '503' ;;
  *) printf '%s' '200' ;;
esac
`,
      { mode: 0o755 },
    );

    expect(() =>
      execFileSync('bash', [scriptPath], {
        env: {
          ...cleanEnv,
          CRON_SECRET: 'sweep-test-secret',
          DQL_SWEEP_URL: 'https://example.test/dql/internal/sweep-reservations/fail',
          DQL_SWEEP_CURL: fakeCurl,
        },
        encoding: 'utf8',
        stdio: 'pipe',
      }),
    ).toThrow();

    execFileSync('bash', [scriptPath], {
      env: {
        ...cleanEnv,
        DQL_CRON_SECRET: 'sweep-test-secret',
        DQL_SWEEP_URL: 'https://example.test/dql/internal/sweep-reservations',
        DQL_SWEEP_CURL: fakeCurl,
      },
      encoding: 'utf8',
      stdio: 'pipe',
    });
    const logged = readFileSync(logFile, 'utf8');
    expect(logged).toContain('Authorization: Bearer sweep-test-secret');
    expect(logged).toContain('-X POST');
  });
});
