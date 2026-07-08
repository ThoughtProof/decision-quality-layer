/**
 * Sandbox cascade — deterministic mock output, free of charge.
 *
 * Purpose: let developers integrate against the DQL API contract without
 * running the real cascade (which incurs model cost and latency).
 *
 * The mock returns a plausible-shaped verdict per axis. The verdicts are
 * derived from a stable hash of (mandate + axis) so the same input always
 * returns the same output — good for snapshot tests on the client side.
 *
 * Do NOT use this for evaluation, benchmarking, or anything that should
 * reflect real model behavior. It exists purely as an integration harness.
 */

import type { Cascade, CascadeInput, CascadeOutput } from './cascade.js';
import type { AxisResult, AxisVerdict } from '../types.js';

const VERDICTS: AxisVerdict[] = ['PASS', 'UNCERTAIN', 'FAIL'];

export class SandboxCascade implements Cascade {
  async run(input: CascadeInput): Promise<CascadeOutput> {
    // Stable pseudo-random from the prompt content so identical inputs give
    // identical outputs. Not cryptographic — just deterministic.
    const seed = hash32(input.axis + '::' + input.prompt.user.slice(0, 200));
    const verdict = VERDICTS[seed % VERDICTS.length]!;
    const confidence = 0.6 + ((seed >>> 8) % 40) / 100; // 0.60–0.99

    const result: AxisResult = {
      axis: input.axis,
      verdict,
      confidence: Math.round(confidence * 100) / 100,
      reasoning: `[sandbox] Deterministic mock for axis "${input.axis}". Wire a real cascade before evaluating quality.`,
      objection: verdict === 'PASS' ? '' : `[sandbox] Mock objection for axis "${input.axis}".`,
    };

    return { result, modelsUsed: ['sandbox'] };
  }
}

function hash32(s: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}
