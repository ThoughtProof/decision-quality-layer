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
 * v0.4.3.1 §C+integration H2: bounded category classes for retry-failure
 * causes. Rows carry a category enum — never raw error text — so
 * diagnostics stay wire-safe (no PII, no unbounded strings).
 */
export type FailureCategory =
  | 'timeout'
  | 'rate_limit'
  | 'network'
  | 'server_5xx'
  | 'client_4xx'
  | 'parse'
  | 'other';

/**
 * Per-fetch attempt-attribution row. One row per ACTUAL PROVIDER FETCH
 * ITERATION (i.e. one row per `singleCall()` iteration inside
 * `callWithRetry()`). Downstream reporting distinguishes "no fetch happened,
 * circuit rejected" from "fetch happened and failed" AND from "fetch
 * retried 3 times before succeeding".
 *
 * Fields kept intentionally flat — no nested objects. `attemptAlias` is
 * the alias that ACTUALLY served this iteration (which may differ from the
 * requested `requestedAlias` when the routing decided to fetch the
 * fallback).
 *
 * Contract: 2 failures + 1 success on a single binding call yields THREE
 * AttemptEvent rows (iteration=1,2,3) PLUS one BindingSummary row (see
 * below). Exhausted 3 failures yields three AttemptEvent rows and one
 * failed BindingSummary.
 */
export interface AttemptEvent {
  /** Handler-owned request id (X-Request-Id). */
  requestId: string;
  /** Populated when the parent CallContext has an axis fork. */
  axis?: string;
  /** Populated when the parent CallContext has a per-axis callId. */
  callId?: string;
  /** Which alias the CASCADE asked for. */
  requestedAlias: string;
  /** Which alias this fetch iteration hit. May differ from requested on fallback. */
  attemptAlias: string;
  /** Which route classification this fetch used. */
  route: 'primary' | 'fallback';
  /** 1-based iteration number within callWithRetry (1..maxAttempts). */
  iteration: number;
  /** True if THIS iteration returned a usable response; false otherwise. */
  ok: boolean;
  /** Wall-clock elapsed for this single iteration in ms. */
  elapsedMs: number;
  /** Bounded failure category. Present when ok=false; absent when ok=true. */
  errorCategory?: FailureCategory;
}

/**
 * Per-binding aggregated summary. One row per PRIMARY-OR-FALLBACK binding
 * call (i.e. one row per completed `callWithRetry()` regardless of how
 * many iterations it took). Complementary to `AttemptEvent`.
 *
 * Contract: A call that primary-fails then fallback-succeeds yields TWO
 * BindingSummary rows (primary+fallback) and N+M AttemptEvent rows.
 */
export interface BindingSummary {
  requestId: string;
  axis?: string;
  callId?: string;
  requestedAlias: string;
  attemptAlias: string;
  route: 'primary' | 'fallback';
  /** True if the binding call as a whole succeeded (last iteration ok). */
  ok: boolean;
  /** Total network latency in ms (wallClock - backoffWaitedMs). */
  netLatencyMs: number;
  /** Sum of backoff sleeps across all retry iterations for this binding. */
  backoffWaitedMs: number;
  /** Total wall-clock for this binding call in ms. */
  wallClockMs: number;
  /** Number of iterations executed (>=1, <=maxAttempts). */
  attemptCount: number;
}

/**
 * Bounded ring-buffer stream with a per-stream drop counter. Order is
 * insertion order; overflow drops the OLDEST record to keep the most
 * recent state visible.
 *
 * v0.4.3.1 §C+integration H3: items are DEEP-FROZEN at push-time, and the
 * returned array is frozen at snapshot-time. A consumer that mutates a
 * flushed record throws in strict mode (or is silently ignored in
 * non-strict), and CAN NEVER retroactively mutate the collector's
 * internal state. Two invariants:
 *   - `Object.isFrozen(snapshot.items[i]) === true` for every item.
 *   - `Object.isFrozen(snapshot.items) === true`, so a consumer cannot
 *     splice/push into the returned array either.
 */
class BoundedStream<T extends object> {
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
    // Freeze at ingest so the caller cannot even mutate the pointer they
    // just pushed. Shallow-freeze is sufficient because AttemptAttribution
    // and CircuitDomainEvent are flat POJOs by contract (no nested mutable
    // objects). A future field that adds nested state MUST update this to
    // structuredClone + deep-freeze.
    this.buf.push(Object.freeze({ ...(item as object) }) as T);
  }
  snapshot(): { items: readonly T[]; dropped: number } {
    // Return a frozen array so `snapshot.items.push(...)` and
    // `snapshot.items[0] = x` both fail. Items are already frozen at push.
    return {
      items: Object.freeze([...this.buf]) as readonly T[],
      dropped: this.droppedCount,
    };
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
  /** Max per-iteration attempt-event rows per request. */
  maxAttempts: number;
  /** Max per-binding summary rows per request. */
  maxBindingSummaries: number;
}

export const DEFAULT_DIAGNOSTICS_CAPS: DiagnosticsCaps = Object.freeze({
  maxTransitions: 200,
  maxStaleResults: 50,
  maxInvalidOutcomes: 50,
  // maxAttempts is per-iteration — with default maxAttempts=3 retries and
  // a typical 5-axis request, worst case is 5 axes * (3+3) primary+fallback
  // iterations ≈ 30. 200 leaves comfortable headroom without ballooning
  // memory (each row is <200 bytes).
  maxAttempts: 200,
  maxBindingSummaries: 50,
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
    items: readonly AttemptEvent[];
    dropped: number;
  };
  binding_summaries: {
    items: readonly BindingSummary[];
    dropped: number;
  };
}

export class RuntimeDiagnosticsCollector {
  private readonly transitions: BoundedStream<CircuitTransitionEvent>;
  private readonly staleResults: BoundedStream<CircuitStaleResultEvent>;
  private readonly invalidOutcomes: BoundedStream<CircuitInvalidOutcomeEvent>;
  private readonly attempts: BoundedStream<AttemptEvent>;
  private readonly bindingSummaries: BoundedStream<BindingSummary>;

  constructor(
    public readonly requestId: string,
    caps: DiagnosticsCaps = DEFAULT_DIAGNOSTICS_CAPS,
  ) {
    this.transitions = new BoundedStream(caps.maxTransitions);
    this.staleResults = new BoundedStream(caps.maxStaleResults);
    this.invalidOutcomes = new BoundedStream(caps.maxInvalidOutcomes);
    this.attempts = new BoundedStream(caps.maxAttempts);
    this.bindingSummaries = new BoundedStream(caps.maxBindingSummaries);
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
   * Record ONE per-iteration attempt row. Called by the LLM client at the
   * end of EVERY singleCall() iteration inside callWithRetry() — both on
   * success and on transient/terminal failure. Not called for
   * admission-only rejections (those correspond to `attemptedRoutes=[]` on
   * CircuitAllOpenError).
   */
  recordAttempt(row: AttemptEvent): void {
    try {
      this.attempts.push(row);
    } catch {
      // Never throw from diagnostics — see recordEvents note.
    }
  }

  /**
   * Record one aggregated per-binding summary. Called by the LLM client
   * exactly once per completed `callWithRetry()` (both primary and fallback
   * paths). Complementary to AttemptEvent: attempts give iteration-level
   * detail, summaries give binding-level totals for latency and outcome.
   */
  recordBindingSummary(row: BindingSummary): void {
    try {
      this.bindingSummaries.push(row);
    } catch {
      // Never throw from diagnostics.
    }
  }

  /**
   * Return an immutable snapshot of all streams. Callers are expected to
   * treat the snapshot as read-only; the collector may still receive more
   * events after `flush()` (though in practice the handler flushes exactly
   * once in `finally`).
   */
  flush(): DiagnosticsSnapshot {
    return Object.freeze({
      requestId: this.requestId,
      transitions: this.transitions.snapshot(),
      stale_results: this.staleResults.snapshot(),
      invalid_outcomes: this.invalidOutcomes.snapshot(),
      attempts: this.attempts.snapshot(),
      binding_summaries: this.bindingSummaries.snapshot(),
    });
  }
}

/**
 * v0.4.3.1 §C+integration H2: map a raw error into a bounded category.
 * Never returns raw error text or an unbounded string. Callers pass the
 * caught error; unknown / non-Error values collapse into 'other'.
 */
export function categorizeFailure(err: unknown): FailureCategory {
  if (err == null) return 'other';
  const msg = err instanceof Error ? err.message : String(err);
  if (/429|rate|too many/i.test(msg)) return 'rate_limit';
  if (/timeout|ETIMEDOUT|EAI_AGAIN|aborted/i.test(msg)) return 'timeout';
  if (/ECONN|fetch failed|socket hang up|network|proxy/i.test(msg)) return 'network';
  if (/\b5\d\d\b|server error|internal/i.test(msg)) return 'server_5xx';
  if (/\b4\d\d\b/i.test(msg)) return 'client_4xx';
  if (/parse|JSON|malformed|invalid/i.test(msg)) return 'parse';
  return 'other';
}
