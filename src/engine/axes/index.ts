/**
 * Axis registry — maps axis name → prompt builder.
 */

import type { Axis } from '../../types.js';
import type { AxisPromptBuilder } from './types.js';
import { buildPrompt as buildIntentPrompt } from './intent.js';
import { buildPrompt as buildScopePrompt } from './scope.js';
import { buildPrompt as buildRiskPrompt } from './risk.js';
import { buildPrompt as buildConsistencyPrompt } from './consistency.js';
import { buildPrompt as buildReversibilityPrompt } from './reversibility.js';

export const AXIS_PROMPT_BUILDERS: Record<Axis, AxisPromptBuilder> = {
  intent: buildIntentPrompt,
  scope: buildScopePrompt,
  risk: buildRiskPrompt,
  consistency: buildConsistencyPrompt,
  reversibility: buildReversibilityPrompt,
};

export type { AxisPromptInput, AxisPrompt, AxisPromptBuilder } from './types.js';
