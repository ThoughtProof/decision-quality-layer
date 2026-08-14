/**
 * CDP Bearer JWT (EdDSA) — ported from thoughtproof-sentinel (zero deps).
 * Used only when DQL_X402_ENABLED + X402_CDP_KEY_* are set.
 */
import { createPrivateKey, sign as cryptoSign, randomBytes } from 'node:crypto';

const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

function b64url(buf: Buffer): string {
  return buf.toString('base64url');
}

function b64urlJson(obj: unknown): string {
  return b64url(Buffer.from(JSON.stringify(obj)));
}

function decodeSecret(secretB64: string): Buffer {
  const raw = Buffer.from(secretB64, 'base64');
  if (raw.length !== 64) {
    throw new Error(`CDP key secret must decode to 64 bytes, got ${raw.length}`);
  }
  return raw;
}

export function generateCdpJwt(
  keyId: string,
  secretB64: string,
  method: string,
  host: string,
  path: string,
): string {
  const raw = decodeSecret(secretB64);
  const seed = raw.subarray(0, 32);
  const pkcs8 = Buffer.concat([PKCS8_ED25519_PREFIX, seed]);
  const key = createPrivateKey({ key: pkcs8, format: 'der', type: 'pkcs8' });

  const now = Math.floor(Date.now() / 1000);
  const header = {
    alg: 'EdDSA',
    kid: keyId,
    typ: 'JWT',
    nonce: randomBytes(16).toString('hex'),
  };
  const payload = {
    sub: keyId,
    iss: 'cdp',
    nbf: now,
    exp: now + 120,
    uri: `${method.toUpperCase()} ${host}${path}`,
  };

  const unsigned = `${b64urlJson(header)}.${b64urlJson(payload)}`;
  const signature = cryptoSign(null, Buffer.from(unsigned), key);
  return `${unsigned}.${b64url(signature)}`;
}

export function hasCdpCredentials(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.X402_CDP_KEY_ID?.trim() && env.X402_CDP_KEY_SECRET?.trim());
}
