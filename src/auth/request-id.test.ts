import { describe, expect, it } from 'vitest';
import {
  generateVerifyRequestId,
  isValidVerifyRequestId,
  resolveVerifyRequestId,
} from './request-id.js';

describe('resolveVerifyRequestId', () => {
  it('prefers a valid Idempotency-Key over X-Request-Id', () => {
    const r = resolveVerifyRequestId({
      'Idempotency-Key': 'client-retry-key-01',
      'x-request-id': 'other-request-id-99',
    });
    expect(r).toEqual({ kind: 'ok', id: 'client-retry-key-01', source: 'idempotency-key' });
  });

  it('uses a validated X-Request-Id when Idempotency-Key is absent', () => {
    const r = resolveVerifyRequestId({ 'X-Request-Id': 'req-abc-123456' });
    expect(r).toEqual({ kind: 'ok', id: 'req-abc-123456', source: 'x-request-id' });
  });

  it('rejects Idempotency-Key that looks like a secret', () => {
    expect(resolveVerifyRequestId({ 'idempotency-key': 'dqlk_0123456789abcdef' }).kind).toBe(
      'invalid',
    );
    expect(resolveVerifyRequestId({ 'Idempotency-Key': 'dqla_0123456789abcdef' }).kind).toBe(
      'invalid',
    );
    expect(resolveVerifyRequestId({ 'Idempotency-Key': 'short' }).kind).toBe('invalid');
  });

  it('ignores an invalid X-Request-Id and generates a server id', () => {
    const r = resolveVerifyRequestId({ 'x-request-id': 'has spaces and /slash' });
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') {
      expect(r.source).toBe('generated');
      expect(r.id.startsWith('dql_')).toBe(true);
    }
  });

  it('generateVerifyRequestId is valid', () => {
    const id = generateVerifyRequestId();
    expect(isValidVerifyRequestId(id)).toBe(true);
  });
});
