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
 * Kept minimal on purpose: the ADR-0007 cross-family invariant (primary
 * and secondary must differ in provider family) is checked at cascade
 * build time, not here.
 */
export interface ModelBinding {
  provider: 'openai' | 'groq';
  modelId: string;
  /** Name of the env var that carries the API key. */
  apiKeyEnv: string;
  baseUrl: string;
}

export const DEFAULT_MODEL_MAP: Record<string, ModelBinding> = {
  // Primary — fast/cheap. OpenAI's cheapest capable chat model.
  'serv-nano': {
    provider: 'openai',
    modelId: 'gpt-4o-mini',
    apiKeyEnv: 'OPENAI_API_KEY',
    baseUrl: 'https://api.openai.com/v1',
  },
  // Secondary — different family (cross-family invariant, ADR-0007).
  // Groq's Llama-3.1-70b hits the "different family, comparable strength"
  // slot without pulling in a second commercial vendor.
  'serv-swift': {
    provider: 'groq',
    modelId: 'llama-3.1-70b-versatile',
    apiKeyEnv: 'GROQ_API_KEY',
    baseUrl: 'https://api.groq.com/openai/v1',
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
        // Low temperature: we want the JSON payload to be as stable as
        // possible across runs. The orthogonality spike was run at 0.1.
        temperature: 0.1,
        max_tokens: input.maxTokens ?? 512,
        // JSON mode where supported. Groq accepts response_format on newer
        // models; OpenAI supports it broadly. If a model rejects the field
        // we fall back to plain text and let parseAxisResponse handle it.
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
