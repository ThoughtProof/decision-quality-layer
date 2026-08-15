import { describe, expect, it } from 'vitest';
import { verifyPayloadDigest } from './verify-payload.js';

const base = {
  mandate: 'Book a refundable fare',
  proposed_action: 'Book the refundable fare as specified',
  reasoning: 'Matches the mandate and stays reversible',
  axes: ['intent', 'scope', 'risk', 'consistency', 'reversibility'] as const,
};

describe('verifyPayloadDigest', () => {
  it('is stable for the same request', () => {
    expect(verifyPayloadDigest(base)).toBe(verifyPayloadDigest({ ...base }));
  });

  it('treats omitted gate_mode as shadow', () => {
    expect(verifyPayloadDigest(base)).toBe(verifyPayloadDigest({ ...base, gate_mode: 'shadow' }));
    expect(verifyPayloadDigest(base)).not.toBe(verifyPayloadDigest({ ...base, gate_mode: 'enforce' }));
  });

  it('includes context', () => {
    expect(verifyPayloadDigest({ ...base, context: 'prior turn' })).not.toBe(verifyPayloadDigest(base));
  });

  it('includes structured_context with canonical key order', () => {
    const a = verifyPayloadDigest({
      ...base,
      structured_context: { proposed: { amount: 50 }, granted: { max_amount: 100 } },
    });
    const b = verifyPayloadDigest({
      ...base,
      structured_context: { granted: { max_amount: 100 }, proposed: { amount: 50 } },
    });
    const c = verifyPayloadDigest({
      ...base,
      structured_context: { granted: { max_amount: 99 }, proposed: { amount: 50 } },
    });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it('changes when mandate / axes / sandbox change', () => {
    expect(verifyPayloadDigest({ ...base, mandate: 'other' })).not.toBe(verifyPayloadDigest(base));
    expect(verifyPayloadDigest({ ...base, sandbox: true })).not.toBe(verifyPayloadDigest(base));
    expect(verifyPayloadDigest({ ...base, axes: ['intent'] })).not.toBe(verifyPayloadDigest(base));
  });
});
