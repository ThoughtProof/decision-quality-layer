/**
 * Shared types for axis handlers.
 *
 * Each axis is a pure function from (mandate, proposed_action, reasoning,
 * context) → prompt. The engine wraps the prompt in a cascade call, parses
 * the model output, and returns an AxisResult.
 */

export interface AxisPromptInput {
  mandate: string;
  proposed_action: string;
  reasoning: string;
  context?: string;
}

export interface AxisPrompt {
  system: string;
  user: string;
}

export type AxisPromptBuilder = (input: AxisPromptInput) => AxisPrompt;
