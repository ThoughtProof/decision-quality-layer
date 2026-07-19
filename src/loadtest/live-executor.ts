/**
 * Live (production Option-A) backend for the load-test harness.
 *
 * This module is the bridge between the transport-agnostic `LoadTestHarness`
 * and the REAL DQL production path:
 *
 *   • cascade  = PotCliCascade(serv-nano primary → serv-swift secondary),
 *                confirm_fail wired from the resolved production config
 *                (exact Option-A semantics as api/dql/verify.ts).
 *   • client   = the SAME HttpLlmClient the production runtime builds, with
 *                per-alias circuit breakers ON and deadline layering armed.
 *   • engine   = runVerification() with requestDeadlineMs / providerCallBudgetMs,
 *                and a RuntimeDiagnosticsCollector per case.
 *
 * It captures — WITHOUT any raw prompt/response text or secret — per-case:
 *   • per-alias route + outcome (served / provider_error / circuit_rejected),
 *   • the real deadline/timeout source (attempt_timeout | call_budget |
 *     request_deadline) observed on the call, replacing the offline 'none',
 *   • circuit OPEN / HALF_OPEN transitions,
 *   • provider-call count, retry attempts, backoff time, net latency.
 *
 * IMPORTANT: constructing the backend performs NO provider I/O. Provider calls
 * happen only when the harness invokes `executor` for a case. Alias identities
 * are pinned (via `aliasPins` / `resolveFingerprints`) and verified by the
 * harness BEFORE the first case — a drift fails closed with no call made. There
 * is NO model fallback/drift beyond the SERV-internal nano↔swift breaker
 * fallback that production itself uses.
 */

import {
  HttpLlmClient,
  DeadlineExceededError,
  routeFingerprint,
  type LlmClient,
  type LlmCallInput,
  type LlmCallOutput,
  type TimeoutSource,
  type CircuitDiagnostic,
} from '../engine/llm-client.js';
import type { CallContext } from '../engine/call-context.js';
import { PotCliCascade } from '../engine/cascade-pot.js';
import { StubCascade } from '../engine/cascade.js';
import { runVerification } from '../engine/index.js';
import { RuntimeDiagnosticsCollector, type DiagnosticsSnapshot } from '../engine/runtime-diagnostics.js';
import {
  createProductionRuntime,
  resolveModelBindings,
  type ClientOptionsOverride,
} from '../engine/production-runtime.js';
import type { DqlResponse, Axis } from '../types.js';
import type {
  CaseExecutor,
  CaseExecutorResult,
  CaseObservation,
  DeadlineSource,
  AliasOutcomeTally,
} from './harness.js';

const DEFAULT_AXES: Axis[] = ['intent', 'scope', 'risk', 'consistency', 'reversibility'];

/** deadline_source precedence: the most global exhausted budget wins. */
const DEADLINE_PRECEDENCE: TimeoutSource[] = ['request_deadline', 'call_budget', 'attempt_timeout'];

export interface LiveBackendOptions {
  /** Environment to resolve the production config + SERV key from. */
  env: NodeJS.ProcessEnv;
  /** Response `version` stamp (mirrors the handler's VERSION). */
  version: string;
  /** Layered deadline budget forwarded to runVerification per case. */
  deadline: { requestDeadlineMs: number; providerCallBudgetMs: number };
  /**
   * Instrumental-only client overrides (fetchImpl / sleep / timeoutMs /
   * maxAttempts / backoff). The production-runtime factory re-applies every
   * SAFETY option AFTER these, so an override can never subvert the breaker,
   * capital-path, or diagnostics posture. Offline tests inject a deterministic
   * `fetchImpl` here to exercise the full live wiring with zero network I/O.
   */
  clientOptionsOverride?: ClientOptionsOverride;
}

export interface LiveBackend {
  executor: CaseExecutor;
  /** Actual alias → route fingerprint resolved from the live bindings. */
  resolveFingerprints: () => Record<string, string>;
  /** Live per-alias circuit diagnostics for the harness transition probe. */
  probeCircuits: () => CircuitDiagnostic[];
  /** Frozen pins captured at construction — feed into LoadTestConfig.aliasPins. */
  aliasPins: Record<string, string>;
  /**
   * Resolved secret STRINGS for the harness leak scanner (never the env name).
   * Empty when the key is absent (offline). The agent never reads this value;
   * it is read from `env` at runtime only.
   */
  secretScanValues: string[];
}

const EMPTY_TALLY = (): AliasOutcomeTally => ({
  calls: 0,
  served: 0,
  provider_error: 0,
  circuit_rejected: 0,
});

/**
 * Thin LlmClient decorator that records the STRUCTURED deadline source of any
 * DeadlineExceededError (and of a successful call's `timeoutSource`) so the
 * observation can report the real source instead of a hard-coded 'none'. It
 * delegates verbatim and re-throws, so production semantics are unchanged.
 */
class DeadlineCapturingClient implements LlmClient {
  readonly sources: TimeoutSource[] = [];
  constructor(private readonly inner: LlmClient) {}
  async call(alias: string, input: LlmCallInput, ctx?: CallContext): Promise<LlmCallOutput> {
    try {
      const out = await this.inner.call(alias, input, ctx);
      if (out.timeoutSource && out.timeoutSource !== 'none') this.sources.push(out.timeoutSource);
      return out;
    } catch (err) {
      if (err instanceof DeadlineExceededError) this.sources.push(err.timeoutSource);
      throw err;
    }
  }
}

function pickDeadlineSource(sources: readonly TimeoutSource[]): DeadlineSource {
  for (const candidate of DEADLINE_PRECEDENCE) {
    if (sources.includes(candidate)) return candidate;
  }
  return 'none';
}

/**
 * Build a secret/raw-free CaseObservation from the live response + diagnostics.
 *
 * Per-alias tallies come from the collector's binding summaries (the truthful
 * per-fetch attribution: which alias actually served each provider draw), so a
 * fallback draw is credited to the alias that served it — not the one the
 * cascade asked for. circuit_rejected axes never produced a fetch (admission
 * was denied) so they carry no binding summary; they are attributed to the
 * primary alias the axis requested.
 */
export function buildLiveObservation(
  response: DqlResponse,
  snapshot: DiagnosticsSnapshot,
  deadlineSources: readonly TimeoutSource[],
  expectedFailAxis: string | undefined,
  primaryAlias: string,
): CaseObservation {
  const per_alias: Record<string, AliasOutcomeTally> = {};
  let attempts = 0;
  let backoff_ms = 0;
  let net_latency_ms = 0;

  for (const bs of snapshot.binding_summaries.items) {
    const tally = (per_alias[bs.attemptAlias] ??= EMPTY_TALLY());
    tally.calls += 1;
    if (bs.ok) tally.served += 1;
    else tally.provider_error += 1;
    attempts += bs.attemptCount;
    backoff_ms += bs.backoffWaitedMs;
    net_latency_ms += bs.netLatencyMs;
  }

  // Admission-rejected axes (no fetch) → circuit_rejected on the primary alias.
  for (const axis of response.axes) {
    if (axis.provider_outcome === 'circuit_rejected') {
      const tally = (per_alias[primaryAlias] ??= EMPTY_TALLY());
      tally.calls += 1;
      tally.circuit_rejected += 1;
    }
  }

  let open = 0;
  let half_open = 0;
  for (const t of snapshot.transitions.items) {
    if (t.kind === 'closed_to_open' || t.kind === 'half_open_to_open') open += 1;
    else if (t.kind === 'open_to_half_open') half_open += 1;
  }

  const hitAxis = expectedFailAxis
    ? response.axes.find((a) => a.axis === expectedFailAxis)
    : undefined;
  const axis_hit = expectedFailAxis ? hitAxis?.verdict === 'FAIL' : null;

  return {
    aggregate_verdict: response.aggregate.verdict,
    axis_hit,
    per_alias,
    deadline_source: pickDeadlineSource(deadlineSources),
    provider_calls: snapshot.binding_summaries.items.length,
    attempts,
    backoff_ms,
    net_latency_ms,
    transitions: { open, half_open },
  };
}

/**
 * Construct the live backend. Reads env + resolves the production config ONCE,
 * builds the shared HttpLlmClient (breakers persist across the whole burst so
 * cross-case circuit behaviour is realistic), and returns the collaborators
 * the harness needs. No provider call is made here.
 */
export function createLiveBackend(opts: LiveBackendOptions): LiveBackend {
  // Build the production runtime purely to (a) resolve+validate config with the
  // exact Option-A wiring and (b) obtain the SAME breaker-enabled client.
  const runtime = createProductionRuntime(opts.env, {
    ...(opts.clientOptionsOverride ? { clientOptionsOverride: opts.clientOptionsOverride } : {}),
  });
  const client = runtime.client;
  const confirmFail = runtime.config.confirm_fail;
  const primaryAlias = 'serv-nano';
  const secondaryAlias = 'serv-swift';

  const bindings = resolveModelBindings(runtime.config);
  const resolveFingerprints = (): Record<string, string> => ({
    [primaryAlias]: routeFingerprint(bindings[primaryAlias]!),
    [secondaryAlias]: routeFingerprint(bindings[secondaryAlias]!),
  });
  const aliasPins = resolveFingerprints();

  const probeCircuits = (): CircuitDiagnostic[] =>
    client instanceof HttpLlmClient ? client.circuitDiagnostics() : [];

  const key = opts.env.SERV_API_KEY;
  const secretScanValues = key ? [key] : [];

  let seq = 0;
  const executor: CaseExecutor = async ({ loadCase, deadline, signal }): Promise<CaseExecutorResult> => {
    if (signal.aborted) {
      // Wall-clock cap already tripped — do not start a provider call.
      throw Object.assign(new Error('aborted before start'), { name: 'AbortError' });
    }
    const requestId = `lt-${loadCase.id}-${seq++}`;
    const collector = new RuntimeDiagnosticsCollector(requestId);
    const capturing = new DeadlineCapturingClient(client);
    // Exact Option-A cascade over the capturing client (same nano→swift,
    // confirm_fail, per-alias breakers via the shared client).
    const cascade = new PotCliCascade(capturing, { confirmFail });

    const axes = (loadCase.request.axes && loadCase.request.axes.length > 0
      ? loadCase.request.axes
      : DEFAULT_AXES) as Axis[];

    const response = await runVerification({
      request: {
        mandate: loadCase.request.mandate,
        proposed_action: loadCase.request.proposed_action,
        reasoning: loadCase.request.reasoning,
        ...(loadCase.request.context !== undefined ? { context: loadCase.request.context } : {}),
        axes,
        sandbox: false,
      },
      cascade,
      // sandbox is always false here; StubCascade satisfies the type and is
      // never invoked.
      sandboxCascade: new StubCascade(),
      requestId,
      version: opts.version,
      collector,
      requestDeadlineMs: deadline.requestDeadlineMs,
      providerCallBudgetMs: deadline.providerCallBudgetMs,
    });

    const snapshot = collector.flush();
    const observation = buildLiveObservation(
      response,
      snapshot,
      capturing.sources,
      loadCase.expected_fail_axis,
      primaryAlias,
    );
    return { response, observation };
  };

  return { executor, resolveFingerprints, probeCircuits, aliasPins, secretScanValues };
}
