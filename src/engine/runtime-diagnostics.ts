/**
 * RuntimeDiagnosticsCollector — request-scoped, bounded structured buffer for
 * CircuitBreaker domain events emitted during a single `runVerification()`
 * pass.
 *
 * v0.4.3.1 §C+integration (Hermes-approved design v4).
 *
 * Contract:
 *   - One collector instance per handler request. Threaded through
 *     `CallContext.collector`.
 *   - The client pushes CircuitBreaker events (transitions, stale results,
 *     invalid outcomes) and per-attempt attribution rows into the collector.
 *   - Bounded independently per stream — a flood of stale_result events
 *     cannot starve transition capacity. Every drop increments a per-stream
 *     `dropped_*` counter so the operator sees the truncation.
 *   - Handler flushes in `finally` and attaches the snapshot to the
 *     response's diagnostics slot. The flush snapshot is a POJO — no
 *     references to internal buffers escape.
 *   - Not exposed to production callers via /dql/verify unless
 *     `DQL_RUNTIME_DIAGNOSTICS=1`. The resolver already enforces this on
 *     the v0431_active canary path.
 *
 * Not a place for arbitrary telemetry. Only CB domain events + per-attempt
 * routing attribution rows are recorded here.
 */

import type {
  CircuitTransitionEvent,
  CircuitStaleResultEvent,
  CircuitInvalidOutcomeEvent,
  CircuitDomainEvent,
} from './circuit-breaker.js';

/**
 * Per-attempt attribution record. One row per PROVIDER FETCH attempted
 * during a call (regardless of whether it succeeded, failed, or ended up
 * being served as the response). Downstream reporting uses these to
 * distinguish "no fetch happened, circuit rejected" from "fetch happened
 * and failed" (Hermes attempt-attribution invariant).
 *
 * Fields kept intentionally flat — no nested objects. All numeric fields
 * are integers or NaN-safe floats. `attemptAlias` is the alias that ACTUALLY
 * served this attempt (which may differ from the requested `requestedAlias`
 * when the routing decided to fetch the fallback).
 */
export interface AttemptAttribution {
  /** Handler-owned request id (X-Request-Id). */
  requestId: string;
  /** Populated when the parent CallContext has an axis fork. */
  axis?: string;
  /** Populated when the parent CallContext has a per-axis callId. */
  callId?: string;
  /** Which alias the CASCADE asked for. */
  requestedAlias: string;
  /** Which alias the CLIENT actually fetched against. May differ on fallback. */
  attemptAlias: string;
  /** Which route classification this fetch used. */
  route: 'primary' | 'fallback';
  /** True if this fetch attempt returned a usable LlmCallOutput; false on error. */
  ok: boolean;
  /** Network latency in ms (netLatencyMs — excludes backoff waits). */
  netLatencyMs: number;
  /** Sum of backoff sleeps between retry attempts for this fetch. */
  backoffWaitedMs: number;
  /** attemptCount reported by callWithRetry (>=1). */
  attemptCount: number;
}

/**
 * Bounded ring-buffer stream with a per-stream drop counter. Order is
 * insertion order; overflow drops the OLDEST record to keep the most
 * recent state visible.
 */
class BoundedStream<T> {
  private readonly buf: T[] = [];
  private droppedCount = 0;
  constructor(private readonly cap: number) {}
  push(item: T): void {
    if (this.cap <= 0) {
      this.droppedCount++;
      return;
    }
    if (this.buf.length >= this.cap) {
      // Drop oldest to preserve most-recent-window visibility.
      this.buf.shift();
      this.droppedCount++;
    }
    this.buf.push(item);
  }
  snapshot(): { items: readonly T[]; dropped: number } {
    // Return a defensive shallow copy — snapshot must be a stable POJO.
    return { items: [...this.buf], dropped: this.droppedCount };
  }
}

/**
 * Per-stream caps. Chosen so a single misbehaving alias cannot flood one
 * stream and starve another. Total ceiling ~= 300 events per request; each
 * event is a small POJO so the memory bound stays sub-KB even at full cap.
 */
export interface DiagnosticsCaps {
  /** Max CB state transitions per request. */
  maxTransitions: number;
  /** Max stale_result events per request. */
  maxStaleResults: number;
  /** Max invalid_outcome events per request. */
  maxInvalidOutcomes: number;
  /** Max attempt-attribution rows per request. */
  maxAttempts: number;
}

export const DEFAULT_DIAGNOSTICS_CAPS: DiagnosticsCaps = Object.freeze({
  maxTransitions: 200,
  maxStaleResults: 50,
  maxInvalidOutcomes: 50,
  maxAttempts: 100,
});

/**
 * Immutable snapshot returned by `flush()`. All fields are plain values —
 * no references to internal buffers.
 */
export interface DiagnosticsSnapshot {
  requestId: string;
  transitions: {
    items: readonly CircuitTransitionEvent[];
    dropped: number;
  };
  stale_results: {
    items: readonly CircuitStaleResultEvent[];
    dropped: number;
  };
  invalid_outcomes: {
    items: readonly CircuitInvalidOutcomeEvent[];
    dropped: number;
  };
  attempts: {
    items: readonly AttemptAttribution[];
    dropped: number;
  };
}

export class RuntimeDiagnosticsCollector {
  private readonly transitions: BoundedStream<CircuitTransitionEvent>;
  private readonly staleResults: BoundedStream<CircuitStaleResultEvent>;
  private readonly invalidOutcomes: BoundedStream<CircuitInvalidOutcomeEvent>;
  private readonly attempts: BoundedStream<AttemptAttribution>;

  constructor(
    public readonly requestId: string,
    caps: DiagnosticsCaps = DEFAULT_DIAGNOSTICS_CAPS,
  ) {
    this.transitions = new BoundedStream(caps.maxTransitions);
    this.staleResults = new BoundedStream(caps.maxStaleResults);
    this.invalidOutcomes = new BoundedStream(caps.maxInvalidOutcomes);
    this.attempts = new BoundedStream(caps.maxAttempts);
  }

  /**
   * Route CircuitBreaker domain events into their respective bounded
   * streams. The events array comes from CircuitAdmission.events or
   * CircuitMutationResult.events; both are readonly.
   *
   * The collector must NEVER throw from this method. Any internal error
   * MUST be swallowed silently — the client's outer defensive catch relies
   * on the ability to push events without escalating the caller's failure.
   */
  recordEvents(events: readonly CircuitDomainEvent[]): void {
    try {
      for (const e of events) {
        switch (e.kind) {
          case 'closed_to_open':
          case 'open_to_half_open':
          case 'half_open_to_open':
          case 'half_open_to_closed':
            this.transitions.push(e);
            break;
          case 'stale_result':
            this.staleResults.push(e);
            break;
          case 'invalid_outcome':
            this.invalidOutcomes.push(e);
            break;
          default: {
            // Exhaustiveness check. If a new event kind is added upstream
            // and this switch is not updated, TypeScript flags it here.
            const _exhaustive: never = e;
            void _exhaustive;
          }
        }
      }
    } catch {
      // Diagnostics MUST NOT poison the caller. See K5 defensive-path
      // contract in llm-client.ts.
    }
  }

  /**
   * Record a per-attempt attribution row. Called by the LLM client for
   * EVERY provider fetch attempt — primary success, primary failure,
   * fallback success, fallback failure. Not called for admission-only
   * rejections (those correspond to `attemptedRoutes=[]` on
   * CircuitAllOpenError).
   */
  recordAttempt(row: AttemptAttribution): void {
    try {
      this.attempts.push(row);
    } catch {
      // Never throw from diagnostics — see recordEvents note.
    }
  }

  /**
   * Return an immutable snapshot of all streams. Callers are expected to
   * treat the snapshot as read-only; the collector may still receive more
   * events after `flush()` (though in practice the handler flushes exactly
   * once in `finally`).
   */
  flush(): DiagnosticsSnapshot {
    return {
      requestId: this.requestId,
      transitions: this.transitions.snapshot(),
      stale_results: this.staleResults.snapshot(),
      invalid_outcomes: this.invalidOutcomes.snapshot(),
      attempts: this.attempts.snapshot(),
    };
  }
}
