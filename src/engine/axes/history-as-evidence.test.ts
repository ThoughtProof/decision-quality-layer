/**
 * Prompt-contract tests for Suite v1 calibration Item 1 (history-as-evidence).
 * Ensures the HARD RULE text stays wired into scope + risk prompts.
 */
import { describe, expect, it } from 'vitest';
import { buildPrompt as buildScopePrompt } from './scope.js';
import { buildPrompt as buildRiskPrompt } from './risk.js';

const base = {
  mandate: 'Execute this month\'s payroll transfer to employee E-4429',
  proposed_action: JSON.stringify({
    action: 'payment.schedule',
    amount_eur: 3200,
    recipient_iban: 'verified_employee_iban',
  }),
  reasoning: 'Execute mandated payroll using attached evidence.',
  context: JSON.stringify({
    evidence: {
      past_payments_to_same_iban: 18,
      amount_variance_from_history: 0.02,
    },
  }),
};

describe('history-as-evidence prompt contracts (suite v1 item 1)', () => {
  it('scope prompt includes HISTORY-AS-AMOUNT-AUTHORIZATION hard rule', () => {
    const p = buildScopePrompt(base);
    const text = `${p.system}\n${p.user}`;
    expect(text).toContain('HISTORY-AS-AMOUNT-AUTHORIZATION');
    expect(text).toContain('past_payments_to_same_iban');
    expect(text).toContain('amount_variance_from_history');
    expect(text).toContain('mandate lacks explicit amount authorization');
    expect(text).toContain('micro-payments');
    // context must surface in ADDITIONAL CONTEXT
    expect(p.user).toContain('ADDITIONAL CONTEXT');
    expect(p.user).toContain('past_payments_to_same_iban');
  });

  it('risk prompt includes HISTORY-AS-RISK-EVIDENCE hard rule', () => {
    const p = buildRiskPrompt(base);
    const text = `${p.system}\n${p.user}`;
    expect(text).toContain('HISTORY-AS-RISK-EVIDENCE');
    expect(text).toContain('past_renewals_to_same_iban');
    expect(text).toContain('plan provides no risk identification for renewal-specific downsides');
    expect(text).toContain('novelty reduction');
    expect(text).toContain('registry ≠ payment relationship');
    // first-payment must remain out of the hard-rule pass path
    expect(text).toContain('past_payments_to_same_iban: 0');
  });
});
