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
// Real (fetch-based) client
// -----------------------------------------------------------------------------

export class HttpLlmClient implements LlmClient {
  constructor(
    private readonly modelMap: Record<string, ModelBinding> = DEFAULT_MODEL_MAP,
    private readonly env: NodeJS.ProcessEnv = process.env
  ) {}

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

    const started = Date.now();
    const response = await fetch(`${binding.baseUrl}/chat/completions`, {
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
        max_tokens: input.maxTokens ?? 512,
        // JSON mode: SERV (openserv.ai) is OpenAI-compatible and accepts
        // response_format. If a model rejects the field we fall back to plain
        // text and let parseAxisResponse handle it.
        response_format: { type: 'json_object' },
      }),
    });

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
