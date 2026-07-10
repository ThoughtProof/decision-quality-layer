/**
 * Minimal OpenAI-compatible LLM client for the DQL cascade.
 *
 * The DQL cascade has one hot-path: send a (system, user) prompt to a model,
 * get back a JSON string. We deliberately do NOT reuse pot-cli's evaluator
 * here because pot-cli's EvalInput shape (trace_steps, gold_plan_steps,
 * provenance verification) is designed for graded-support evaluation and
 * carries semantics DQL does not need. Coupling to that shape would force
 * us to synthesise dummy trace/gold data on every call.
 *
 * pot-cli's cascade orchestration logic (early-exit, cross-family checks,
 * confirmBlocks) is instead re-implemented in `cascade-pot.ts` in a shape
 * that matches our PASS/FAIL/UNCERTAIN verdict vocabulary directly. See
 * ADR-0007 in the Sentinel repo for the empirical basis of that pattern.
 *
 * Supported providers:
 *   - `serv`    — SERV provider (openserv.ai) - default for DQL cascade  
 *   - `openai`  — raw OpenAI chat-completions API
 *   - `groq`    — Groq chat-completions (OpenAI-compatible)
 *   - `mock`    — in-memory router, driven by MockRegistry (tests only)
 *
 * Model aliases (`serv-nano`, `serv-swift`) resolve via `MODEL_MAP` to
 * concrete (provider, model_id, api_key_env) tuples. This keeps the axis
 * layer completely provider-agnostic.
 *
 * Reliability (2026-07-10, DQL-baseline v0.4.1b determinism study):
 * A determinism-metric run over 100 adversarial cases × N=5 draws surfaced
 * that 28% of individual axis-draws returned UNCERTAIN@0 with objection
 * "fetch failed". Root cause: undici (Node fetch) drops HTTP connections
 * after ~50s of server silence when SERV is under load, and the engine's
 * axis-level try/catch (src/engine/index.ts) mapped these directly onto
 * UNCERTAIN@0 without any retry. The Suite-runner had an outer retry
 * wrapper but its 6×20s cap collapsed together with the fetch cutoff.
 *
 * This client now applies:
 *   - Explicit AbortController-based per-request timeout (default 60s)
 *   - In-client retry loop with exponential backoff (default 6 attempts,
 *     base 800ms, cap 90s) on transient network / rate-limit errors
 *   - Retries are *inner* to the engine — the script-side RetryLlmClient
 *     stays as an outer belt-and-suspenders wrapper for suite runs
 */

export interface LlmCallInput {
  system: string;
  user: string;
  maxTokens?: number;
}

export interface LlmCallOutput {
  raw: string;
  modelUsed: string;
  latencyMs: number;
}

export interface LlmClient {
  call(modelAlias: string, input: LlmCallInput): Promise<LlmCallOutput>;
}

/**
 * Map alias → concrete backend. Keys are the aliases used by the cascade
 * (`serv-nano` = fast/cheap primary; `serv-swift` = stronger secondary).
 *
 * Kept minimal on purpose. NOTE (2026-07-08): DQL runs both stages on the SERV
 * stack (serv-nano primary, serv-swift secondary) — same provider, different
 * capability tiers. This is NOT the ADR-0007 cross-vendor-family setup; the
 * second-opinion value here comes from serv-swift being a stronger SERV model
 * than serv-nano, not from a different vendor. There is intentionally no
 * cross-family assertion at build time (it would reject two 'serv' bindings).
 */
export interface ModelBinding {
  provider: 'openai' | 'groq' | 'serv';
  modelId: string;
  /** Name of the env var that carries the API key. */
  apiKeyEnv: string;
  baseUrl: string;
}

export const DEFAULT_MODEL_MAP: Record<string, ModelBinding> = {
  // Primary — SERV serv-nano (openserv.ai). Same model Sentinel uses as its
  // standard-tier primary. NOT OpenAI gpt-4o-mini — DQL runs on the SERV stack
  // via SERV_API_KEY, identical to pot-cli's model-router bindings.
  'serv-nano': {
    provider: 'serv',
    modelId: 'serv-nano',
    apiKeyEnv: 'SERV_API_KEY',
    baseUrl: process.env.SERV_BASE_URL ?? 'https://inference-api.openserv.ai/v1',
  },
  // Secondary — SERV serv-swift. The cross-family strength comes from serv-swift
  // being a distinct, larger SERV model than serv-nano (mirrors Sentinel's
  // nano→swift standard-tier cascade), not from a second commercial vendor.
  'serv-swift': {
    provider: 'serv',
    modelId: 'serv-swift',
    apiKeyEnv: 'SERV_API_KEY',
    baseUrl: process.env.SERV_BASE_URL ?? 'https://inference-api.openserv.ai/v1',
  },
};

// -----------------------------------------------------------------------------
// Retry + timeout config
// -----------------------------------------------------------------------------

export interface HttpLlmClientConfig {
  /** Per-request timeout in ms (AbortController). Default: 60000. */
  timeoutMs?: number;
  /** Max retry attempts including the first one. Default: 6. */
  maxAttempts?: number;
  /** Base backoff in ms — actual wait = min(base * 2^(i-1), backoffCapMs) + jitter. Default: 800. */
  backoffBaseMs?: number;
  /** Backoff cap in ms. Default: 90000 (raised from suite-runner 20s to survive SERV overload windows). */
  backoffCapMs?: number;
  /** Injection point for tests — clock/sleep. */
  sleep?: (ms: number) => Promise<void>;
  /** Injection point for tests — fetch. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

const DEFAULT_CONFIG: Required<Omit<HttpLlmClientConfig, 'sleep' | 'fetchImpl'>> = {
  timeoutMs: 60_000,
  maxAttempts: 6,
  backoffBaseMs: 800,
  backoffCapMs: 90_000,
};

/**
 * Match the exact pattern the script-side RetryLlmClient uses so behavior
 * is identical whether the retry fires in-engine or in the wrapper.
 */
const RETRYABLE_PATTERN =
  /429|too many|rate|proxy|fetch failed|ECONN|ETIMEDOUT|EAI_AGAIN|socket hang up|aborted|timeout/i;

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// -----------------------------------------------------------------------------
// Real (fetch-based) client
// -----------------------------------------------------------------------------

export class HttpLlmClient implements LlmClient {
  private readonly config: Required<Omit<HttpLlmClientConfig, 'sleep' | 'fetchImpl'>>;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly fetchImpl: typeof fetch;

  constructor(
    private readonly modelMap: Record<string, ModelBinding> = DEFAULT_MODEL_MAP,
    private readonly env: NodeJS.ProcessEnv = process.env,
    config: HttpLlmClientConfig = {}
  ) {
    this.config = {
      timeoutMs: config.timeoutMs ?? DEFAULT_CONFIG.timeoutMs,
      maxAttempts: config.maxAttempts ?? DEFAULT_CONFIG.maxAttempts,
      backoffBaseMs: config.backoffBaseMs ?? DEFAULT_CONFIG.backoffBaseMs,
      backoffCapMs: config.backoffCapMs ?? DEFAULT_CONFIG.backoffCapMs,
    };
    this.sleep = config.sleep ?? defaultSleep;
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  async call(modelAlias: string, input: LlmCallInput): Promise<LlmCallOutput> {
    const binding = this.modelMap[modelAlias];
    if (!binding) {
      throw new Error(`[llm-client] unknown model alias: ${modelAlias}`);
    }
    const apiKey = this.env[binding.apiKeyEnv];
    if (!apiKey) {
      throw new Error(
        `[llm-client] missing env var ${binding.apiKeyEnv} for model alias ${modelAlias}`
      );
    }

    let lastErr: unknown;
    for (let attempt = 1; attempt <= this.config.maxAttempts; attempt++) {
      try {
        return await this.singleCall(binding, apiKey, input);
      } catch (err) {
        lastErr = err;
        const msg = err instanceof Error ? err.message : String(err);
        const retryable = RETRYABLE_PATTERN.test(msg);
        if (!retryable || attempt === this.config.maxAttempts) {
          throw err;
        }
        const wait =
          Math.min(this.config.backoffBaseMs * Math.pow(2, attempt - 1), this.config.backoffCapMs) +
          Math.floor(Math.random() * 800);
        await this.sleep(wait);
      }
    }
    // Unreachable — the loop above either returns or throws.
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }

  private async singleCall(
    binding: ModelBinding,
    apiKey: string,
    input: LlmCallInput
  ): Promise<LlmCallOutput> {
    const started = Date.now();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs);

    let response: Response;
    try {
      response = await this.fetchImpl(`${binding.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: binding.modelId,
          messages: [
            { role: 'system', content: input.system },
            { role: 'user', content: input.user },
          ],
          // Deterministic decoding — matches Sentinel's cascade (temperature: 0,
          // seed: 42). The DQL orthogonality spike was itself run through the
          // pot-cli grader at temp 0 / seed 42; running the live cascade at 0.1
          // without a seed would reintroduce exactly the verdict non-determinism
          // that the Sentinel RCA (2026-07-08) tracked down. Keep it pinned.
          temperature: 0,
          seed: 42,
          // SERV (openserv.ai) requires 'max_completion_tokens', not the legacy
          // 'max_tokens' (returns HTTP 400 unsupported_parameter otherwise).
          max_completion_tokens: input.maxTokens ?? 512,
          // JSON mode: SERV (openserv.ai) is OpenAI-compatible and accepts
          // response_format. If a model rejects the field we fall back to plain
          // text and let parseAxisResponse handle it.
          response_format: { type: 'json_object' },
        }),
        signal: controller.signal,
      });
    } catch (err) {
      // AbortError from our own timeout should surface as a retryable
      // "timeout" message so RETRYABLE_PATTERN picks it up.
      if (err instanceof Error && err.name === 'AbortError') {
        throw new Error(`[llm-client] request timeout after ${this.config.timeoutMs}ms (aborted)`);
      }
      throw err;
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(
        `[llm-client] ${binding.provider} ${response.status}: ${body.slice(0, 500)}`
      );
    }

    const json = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const raw = json?.choices?.[0]?.message?.content ?? '';
    return {
      raw,
      modelUsed: `${binding.provider}:${binding.modelId}`,
      latencyMs: Date.now() - started,
    };
  }
}

// -----------------------------------------------------------------------------
// Mock client — used by tests to drive the cascade without network calls.
// -----------------------------------------------------------------------------

export type MockResponder = (modelAlias: string, input: LlmCallInput) => LlmCallOutput | Promise<LlmCallOutput>;

export class MockLlmClient implements LlmClient {
  constructor(private readonly responder: MockResponder) {}

  async call(modelAlias: string, input: LlmCallInput): Promise<LlmCallOutput> {
    return await this.responder(modelAlias, input);
  }
}
