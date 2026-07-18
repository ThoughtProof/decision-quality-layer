/**
 * CallContext — per-request context threaded from the handler through the
 * engine, cascade, and LLM client.
 *
 * Design (v0.4.3.1 §C.1 amendment):
 *   - The HANDLER (api/dql/verify.ts) is the ONLY place that generates the
 *     canonical requestId. It sets both `X-Request-Id` and `DqlResponse.id`
 *     from that single source.
 *   - The Engine receives `requestId` and `callContext` on its input; it
 *     never generates a second requestId.
 *   - Per-axis processing may derive a child context with `axis` and
 *     `callId` populated for correlation of transitions and diagnostics
 *     events, but never invents a new requestId.
 *
 * The `collector` slot is added as an OPTIONAL forward-compatible field so
 * later PR #12 sub-commits can wire in RuntimeDiagnosticsCollector without
 * another interface change. It is NOT populated in this commit.
 */

import type { Axis } from '../types.js';
import type { RuntimeDiagnosticsCollector } from './runtime-diagnostics.js';

/**
 * Per-request context propagated from handler → engine → cascade → llm-client.
 *
 * `requestId` is REQUIRED and MUST originate from the handler. `axis` and
 * `callId` are populated by the engine when it forks child contexts for
 * parallel axis processing.
 */
export interface CallContext {
  /**
   * Canonical, handler-owned request id. Same string as `X-Request-Id`
   * response header and `DqlResponse.id`. The engine MUST NOT generate a
   * second id.
   */
  requestId: string;
  /** Populated by the engine when a child context is forked for an axis. */
  axis?: Axis;
  /**
   * Populated by the engine per fork. Used to distinguish parallel calls
   * within the same request (e.g. 5 axes running in parallel).
   */
  callId?: string;
  /**
   * Optional RuntimeDiagnosticsCollector (v0.4.3.1 §C+integration).
   *
   * Populated by the handler when DQL_RUNTIME_DIAGNOSTICS=1 on the
   * v0431_active canary path. The LLM client and downstream components push
   * CircuitBreaker domain events (transitions, stale results, invalid
   * outcomes) and per-attempt attribution rows into it. When absent,
   * downstream MUST behave identically to earlier releases — the collector
   * is a pure observation sink, never a control-flow input.
   */
  collector?: RuntimeDiagnosticsCollector;
  /**
   * Absolute epoch-ms deadline for the whole verification request (W).
   * Set by runVerification when deadline enforcement is enabled.
   */
  deadlineAt?: number;
  /**
   * Shared AbortSignal for the whole verification request.
   * Combined with per-attempt signals in the LLM client.
   */
  requestSignal?: AbortSignal;
  /**
   * Per-provider-call budget in ms (PC). Optional; used with deadlineAt to
   * clamp attempt timeouts and skip exhausted retries.
   */
  providerCallBudgetMs?: number;
}

/**
 * Generate a per-axis callId. Short, non-cryptographic, unique within a
 * single request. Combined with `requestId` and `axis`, it yields a fully
 * qualified correlation key for diagnostics.
 */
export function generateCallId(): string {
  return `c_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}
