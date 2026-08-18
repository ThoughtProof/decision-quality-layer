/**
 * Numeric specialist-objection evidence bind (DQL surface gate).
 *
 * Principle: specialist objections/reasons are claims, not facts.
 * Where a reason is numeric and checkable against bound evidence
 * (structured_context / mandate / proposed_action / context JSON), verify
 * before the text is user-visible, agent-replan-visible, or graph-attested.
 *
 * Does NOT change axis or aggregate verdicts. Surface text only.
 *
 * Origin: owned-verifiers Week-1 freeze (Paris 583 ≤ 600 + "exceeds budget").
 * Ported from thoughtproof-sentinel after P0 live success.
 */

import type { AxisResult, DqlStructuredContext } from './types.js';

const EXCEED_RE =
  /(exceed(?:s|ed)?|over(?:\s+the)?\s+budget|above\s+(?:the\s+)?(?:budget|ceiling|limit)|over\s+(?:budget|ceiling|limit)|too\s+(?:high|large|expensive)|outside\s+(?:the\s+)?(?:budget|limit)|oversize)/i;

const WITHIN_RE =
  /(within\s+(?:budget|limit|ceiling)|under\s+(?:budget|limit|ceiling)|below\s+(?:the\s+)?(?:budget|limit|ceiling)|does\s+not\s+exceed)/i;

const TOTAL_RE =
  /(?:total|sum|cost|amount|price|notional)\s*(?:is|=|:)\s*(?:[$€£])?\s*([0-9]{1,3}(?:,[0-9]{3})+(?:\.[0-9]+)?|[0-9]+(?:\.[0-9]+)?)/i;

const CEILING_RE =
  /(?:budget|ceiling|limit|max(?:imum)?|cap)\s*(?:of|is|=|:)?\s*(?:[$€£])?\s*([0-9]{1,3}(?:,[0-9]{3})+(?:\.[0-9]+)?|[0-9]+(?:\.[0-9]+)?)/i;

const NUM_RE = /([0-9]{1,3}(?:,[0-9]{3})+(?:\.[0-9]+)?|[0-9]+(?:\.[0-9]+)?)/g;

/** `$100 + $200 = $300` — currency required on each term. */
const MONEY_PAIR_RE =
  /(?:[$€£])\s*([0-9]{1,3}(?:,[0-9]{3})+(?:\.[0-9]+)?|[0-9]+(?:\.[0-9]+)?)\s*(?:\+|and)\s*(?:[$€£])\s*([0-9]{1,3}(?:,[0-9]{3})+(?:\.[0-9]+)?|[0-9]+(?:\.[0-9]+)?)\s*=\s*(?:[$€£])\s*([0-9]{1,3}(?:,[0-9]{3})+(?:\.[0-9]+)?|[0-9]+(?:\.[0-9]+)?)/i;

const MONEY_NUM = String.raw`[0-9]{1,3}(?:,[0-9]{3})+(?:\.[0-9]+)?|[0-9]+(?:\.[0-9]+)?`;
const MONEY_SYM_RE = new RegExp(`([$€£])\\s*(${MONEY_NUM})`, 'g');
const MONEY_ISO_RE = new RegExp(`(${MONEY_NUM})\\s*(USD|EUR|GBP)\\b`, 'gi');

const UNVERIFIED_STUB =
  '[objection_unverified] numeric claim without bound evidence';
const UNVERIFIED_STUB_RE =
  /numeric claims? without bound evidence|\[objection_unverified\]/i;

export type BindSurface = 'pass_through' | 'strip_reason' | 'rewrite_reason';

export type BindStatus =
  | 'non_numeric'
  | 'verified'
  | 'numbers_rewritten'
  | 'objection_evidence_fail'
  | 'unverified_insufficient_bounds';

export interface BoundTotals {
  amount: number | null;
  ceiling: number | null;
  components: Record<string, number>;
  components_sum?: number;
  sources: string[];
}

export interface NumericClaim {
  raw: string;
  is_numericish: boolean;
  relation: 'exceed' | 'within' | null;
  stated_total: number | null;
  stated_ceiling: number | null;
  parsed_numbers: number[];
}

export interface BindItemResult {
  claim: NumericClaim;
  bounds: BoundTotals;
  status: BindStatus;
  surface: BindSurface;
  safe_reason: string;
  log_code: string | null;
  detail: Record<string, unknown> | null;
}

export interface BindBatchResult {
  n: number;
  n_non_numeric: number;
  n_verified: number;
  n_evidence_fail: number;
  n_unverified: number;
  surface_gated: boolean;
  items: BindItemResult[];
  codes: string[];
}

export interface BindContext {
  /** Free-text mandate. */
  mandate?: string;
  /** Free-text proposed action. */
  proposed_action?: string;
  /** Agent reasoning free text. */
  reasoning?: string;
  /** Free-text context. */
  context?: string;
  /** Machine-readable structured context (preferred bounds source). */
  structured_context?: DqlStructuredContext;
}

function num(x: unknown): number | null {
  if (x === null || x === undefined || typeof x === 'boolean') return null;
  if (typeof x === 'number' && Number.isFinite(x)) return x;
  if (typeof x === 'string') return parseMoneyNumber(x);
  return null;
}

/**
 * Parse a finance figure. `$1,499` → 1499 (comma thousands), never 1.499.
 * Accepts optional `$` / `€` / `£` wrappers.
 */
export function parseMoneyNumber(raw: string): number | null {
  const s = String(raw ?? '')
    .trim()
    .replace(/[$€£]/g, '')
    .replace(/\s+/g, '');
  if (!s) return null;
  if (/^-?\d{1,3}(,\d{3})+(\.\d+)?$/.test(s)) {
    const v = Number(s.replace(/,/g, ''));
    return Number.isFinite(v) ? v : null;
  }
  if (/^-?\d+(\.\d+)?$/.test(s)) {
    const v = Number(s);
    return Number.isFinite(v) ? v : null;
  }
  return null;
}

type MoneyLabel = 'amount' | 'ceiling' | 'list' | null;

interface MoneyToken {
  value: number;
  raw: string;
  start: number;
  end: number;
  label: MoneyLabel;
}

function closeNum(n: number, target: number | null, tol: number): boolean {
  if (target === null) return false;
  return Math.abs(n - target) <= Math.max(tol, 0.01 * Math.max(Math.abs(target), 1));
}

function labelAround(text: string, start: number, end: number): MoneyLabel {
  const before = text.slice(Math.max(0, start - 48), start).toLowerCase();
  const after = text.slice(end, end + 28).toLowerCase();
  const window = `${before} ${after}`;
  if (/\b(list(\s+price)?|msrp|original(\s+price)?|was)\b/.test(window)) return 'list';
  // "budget mismatch ($848 vs …)" — budget names the dispute, not the $848 ceiling.
  const budgetMismatch = /\bbudget\s+mismatch\b/.test(before);
  if (
    !budgetMismatch &&
    (/\b(budget|cap|ceiling|max(?:imum)?|limit)\b/.test(window) ||
      /\b(under|below|up to|at most|no more than)\b/.test(before))
  ) {
    return 'ceiling';
  }
  if (/\b(price|amount|cost|total|notional|sale|purchase)\b/.test(window)) return 'amount';
  return null;
}

export function extractMoneyTokens(text: string): MoneyToken[] {
  const out: MoneyToken[] = [];
  if (!text) return out;
  const occupied: Array<{ start: number; end: number }> = [];
  const overlaps = (start: number, end: number) =>
    occupied.some((r) => start < r.end && end > r.start);

  for (const m of text.matchAll(MONEY_SYM_RE)) {
    if (m.index === undefined) continue;
    const v = parseMoneyNumber(m[2] ?? '');
    if (v === null) continue;
    const start = m.index;
    const end = start + m[0].length;
    occupied.push({ start, end });
    out.push({
      value: v,
      raw: m[0],
      start,
      end,
      label: labelAround(text, start, end),
    });
  }
  for (const m of text.matchAll(MONEY_ISO_RE)) {
    if (m.index === undefined) continue;
    const v = parseMoneyNumber(m[1] ?? '');
    if (v === null) continue;
    const start = m.index;
    const end = start + m[0].length;
    if (overlaps(start, end)) continue;
    occupied.push({ start, end });
    out.push({
      value: v,
      raw: m[0],
      start,
      end,
      label: labelAround(text, start, end),
    });
  }
  out.sort((a, b) => a.start - b.start);

  // `$848 vs $700` — left is amount, right is ceiling.
  for (let i = 0; i < out.length - 1; i++) {
    const a = out[i]!;
    const b = out[i + 1]!;
    const between = text.slice(a.end, b.start);
    if (/^\s*vs\.?\s*$/i.test(between)) {
      if (a.label !== 'ceiling') a.label = 'amount';
      b.label = 'ceiling';
    }
  }
  return out;
}

function moneyTokensBound(tokens: MoneyToken[], bounds: BoundTotals, tol: number): boolean {
  if (tokens.length === 0) return true;
  const extras = Object.values(bounds.components);
  const isBoundValue = (n: number) =>
    closeNum(n, bounds.amount, tol) ||
    closeNum(n, bounds.ceiling, tol) ||
    extras.some((c) => closeNum(n, c, tol));

  for (const t of tokens) {
    if (t.label === 'amount') {
      if (!closeNum(t.value, bounds.amount, tol)) return false;
    } else if (t.label === 'ceiling') {
      if (!closeNum(t.value, bounds.ceiling, tol)) return false;
    } else if (!isBoundValue(t.value)) {
      return false;
    }
  }
  return true;
}

function amountFromProposedAction(text: string): number | null {
  const tokens = extractMoneyTokens(text);
  if (tokens.length === 0) return null;
  const actionable = tokens.filter((t) => t.label !== 'list');
  const labeled = actionable.filter((t) => t.label === 'amount');
  if (labeled.length === 1) return labeled[0]!.value;
  if (labeled.length > 1) {
    const first = labeled[0]!.value;
    return labeled.every((t) => t.value === first) ? first : null;
  }
  if (actionable.length === 1) return actionable[0]!.value;
  const eq = MONEY_PAIR_RE.exec(text);
  if (eq) {
    const a = parseMoneyNumber(eq[1] ?? '');
    const b = parseMoneyNumber(eq[2] ?? '');
    const c = parseMoneyNumber(eq[3] ?? '');
    if (a !== null && b !== null && c !== null && Math.abs(a + b - c) <= 0.02) return c;
  }
  return null;
}

function ceilingFromFreeText(text: string): number | null {
  const tokens = extractMoneyTokens(text);
  const labeled = tokens.filter((t) => t.label === 'ceiling');
  if (labeled.length === 1) return labeled[0]!.value;
  if (labeled.length > 1) {
    const first = labeled[0]!.value;
    return labeled.every((t) => t.value === first) ? first : null;
  }
  return null;
}

function asDict(x: unknown): Record<string, unknown> {
  if (x && typeof x === 'object' && !Array.isArray(x)) {
    return x as Record<string, unknown>;
  }
  if (typeof x === 'string') {
    const s = x.trim();
    if ((s.startsWith('{') && s.endsWith('}')) || (s.startsWith('[') && s.endsWith(']'))) {
      try {
        const o = JSON.parse(s) as unknown;
        if (o && typeof o === 'object' && !Array.isArray(o)) {
          return o as Record<string, unknown>;
        }
      } catch {
        /* ignore */
      }
    }
  }
  return {};
}

/** Extract nested JSON objects embedded in free text (claim/evidence blobs). */
function extractEmbeddedDicts(text: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  if (!text) return out;
  // Whole-string JSON
  const whole = asDict(text);
  if (Object.keys(whole).length > 0) out.push(whole);

  // Scan for balanced {...} blocks
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '{') continue;
    let depth = 0;
    for (let j = i; j < text.length; j++) {
      if (text[j] === '{') depth++;
      else if (text[j] === '}') {
        depth--;
        if (depth === 0) {
          const slice = text.slice(i, j + 1);
          try {
            const o = JSON.parse(slice) as unknown;
            if (o && typeof o === 'object' && !Array.isArray(o)) {
              out.push(o as Record<string, unknown>);
            }
          } catch {
            /* not json */
          }
          i = j;
          break;
        }
      }
    }
  }
  return out;
}

const AMOUNT_KEYS = [
  'amount',
  'size_usd',
  'quoteSize',
  'quotesize',
  'notional',
  'total',
  'total_eur',
  'total_usd',
  'amount_eur',
  'amount_usd',
  'maxAmount',
] as const;

const CEILING_KEYS = [
  'budget',
  'budget_ceiling',
  'ceiling',
  'limit',
  'max_amount',
  'maxAmount',
  'soft_ceiling',
  'amount_limit',
] as const;

export function boundTotals(ctx: BindContext): BoundTotals {
  const out: BoundTotals = {
    amount: null,
    ceiling: null,
    components: {},
    sources: [],
  };

  const blobs: Array<{ src: string; blob: Record<string, unknown> }> = [];

  // Preferred: structured_context (ADR-0020)
  if (ctx.structured_context?.proposed) {
    blobs.push({
      src: 'structured.proposed',
      blob: ctx.structured_context.proposed as unknown as Record<string, unknown>,
    });
  }
  if (ctx.structured_context?.granted) {
    const g = { ...(ctx.structured_context.granted as unknown as Record<string, unknown>) };
    // Map DQL max_amount → ceiling synonym used below
    if (g.max_amount !== undefined && g.maxAmount === undefined) g.maxAmount = g.max_amount;
    if (g.materiality_ceiling !== undefined && g.budget_ceiling === undefined) {
      g.budget_ceiling = g.materiality_ceiling;
    }
    blobs.push({ src: 'structured.granted', blob: g });
  }

  for (const d of extractEmbeddedDicts(ctx.mandate ?? '')) {
    blobs.push({ src: 'mandate', blob: d });
  }
  for (const d of extractEmbeddedDicts(ctx.proposed_action ?? '')) {
    blobs.push({ src: 'proposed_action', blob: d });
  }
  for (const d of extractEmbeddedDicts(ctx.reasoning ?? '')) {
    blobs.push({ src: 'reasoning', blob: d });
  }
  for (const d of extractEmbeddedDicts(ctx.context ?? '')) {
    blobs.push({ src: 'context', blob: d });
  }

  for (const { src, blob } of blobs) {
    for (const k of AMOUNT_KEYS) {
      if (out.amount === null && blob[k] !== undefined) {
        const v = num(blob[k]);
        if (v !== null) {
          // maxAmount on granted is ceiling, not amount
          if (k === 'maxAmount' && src.includes('granted')) continue;
          out.amount = v;
          out.sources.push(`${src}.${k}`);
        }
      }
    }
    for (const k of CEILING_KEYS) {
      if (out.ceiling === null && blob[k] !== undefined) {
        const v = num(blob[k]);
        if (v !== null) {
          out.ceiling = v;
          out.sources.push(`${src}.${k}`);
        }
      }
    }
    // granted max is the canonical ceiling when present
    if (
      out.ceiling === null &&
      (src === 'structured.granted' || src === 'mandate.granted') &&
      (blob.maxAmount !== undefined || blob.max_amount !== undefined)
    ) {
      const v = num(blob.maxAmount ?? blob.max_amount);
      if (v !== null) {
        out.ceiling = v;
        out.sources.push(`${src}.max_amount`);
      }
    }

    // cart / line items / named cost components
    for (const [k, v] of Object.entries(blob)) {
      const kl = k.toLowerCase();
      if (['flight', 'hotel', 'price', 'cost', 'fee'].some((t) => kl.includes(t))) {
        const nv = num(v);
        if (nv !== null && out.components[k] === undefined) {
          out.components[k] = nv;
        }
      }
    }
    const cart = blob.cart ?? blob.items ?? blob.line_items;
    if (Array.isArray(cart)) {
      cart.forEach((it, i) => {
        if (it && typeof it === 'object') {
          const row = it as Record<string, unknown>;
          const nv = num(row.amount ?? row.price ?? row.total);
          if (nv !== null) out.components[`cart[${i}]`] = nv;
        }
      });
    }
  }

  if (Object.keys(out.components).length > 0) {
    const s = Object.values(out.components).reduce((a, b) => a + b, 0);
    out.components_sum = s;
    if (out.amount === null) {
      out.amount = s;
      out.sources.push('sum(components)');
    }
  }

  // Free-text finance values require an explicit currency in the match
  // ($ / € / £ or ISO USD/EUR/GBP). `under 2 kg` / `total 3 cameras` stay out.
  if (out.ceiling === null) {
    for (const t of [ctx.mandate, ctx.proposed_action, ctx.reasoning, ctx.context]) {
      if (!t) continue;
      const v = ceilingFromFreeText(t);
      if (v !== null) {
        out.ceiling = v;
        out.sources.push('text.ceiling');
        break;
      }
    }
  }

  if (out.amount === null && ctx.proposed_action) {
    const v = amountFromProposedAction(ctx.proposed_action);
    if (v !== null) {
      out.amount = v;
      out.sources.push('text.proposed_action.money');
    }
  }

  return out;
}

export function isUnverifiedNumericStub(text: string): boolean {
  return UNVERIFIED_STUB_RE.test(String(text ?? ''));
}

export function parseNumericClaim(text: string): NumericClaim {
  const s = String(text ?? '');
  const claim: NumericClaim = {
    raw: s.slice(0, 300),
    is_numericish: false,
    relation: null,
    stated_total: null,
    stated_ceiling: null,
    parsed_numbers: [],
  };
  if (!s.trim()) return claim;

  const nums: number[] = [];
  for (const m of s.matchAll(NUM_RE)) {
    const v = parseMoneyNumber(m[1] ?? '');
    if (v !== null) nums.push(v);
  }
  claim.parsed_numbers = nums.slice(0, 8);

  if (EXCEED_RE.test(s)) {
    claim.is_numericish = true;
    claim.relation = 'exceed';
  } else if (WITHIN_RE.test(s)) {
    claim.is_numericish = true;
    claim.relation = 'within';
  }

  const mt = TOTAL_RE.exec(s);
  if (mt) {
    claim.stated_total = parseMoneyNumber(mt[1] ?? '');
    claim.is_numericish = true;
  }
  const mc = CEILING_RE.exec(s);
  if (mc) {
    claim.stated_ceiling = parseMoneyNumber(mc[1] ?? '');
    claim.is_numericish = true;
  }
  const mp = MONEY_PAIR_RE.exec(s);
  if (mp) {
    claim.stated_total = parseMoneyNumber(mp[3] ?? '');
    claim.is_numericish = true;
  }

  const money = extractMoneyTokens(s);
  if (money.length > 0) {
    claim.is_numericish = true;
    const vsAmount = money.find((t) => t.label === 'amount');
    const vsCeiling = money.find((t) => t.label === 'ceiling');
    if (vsAmount && claim.stated_total === null) claim.stated_total = vsAmount.value;
    if (vsCeiling && claim.stated_ceiling === null) claim.stated_ceiling = vsCeiling.value;
    if (/\bmismatch\b|\bvs\.?\b/i.test(s) && vsAmount && vsCeiling) {
      claim.relation = claim.relation ?? 'exceed';
    }
  }

  return claim;
}

export function bindObjectionText(
  text: string,
  ctx: BindContext,
  tol = 1e-6,
): BindItemResult {
  const claim = parseNumericClaim(text);
  const bounds = boundTotals(ctx);
  const result: BindItemResult = {
    claim,
    bounds,
    status: 'non_numeric',
    surface: 'pass_through',
    safe_reason: String(text ?? '').slice(0, 500),
    log_code: null,
    detail: null,
  };

  if (!claim.is_numericish) return result;

  const amount = bounds.amount;
  const ceiling = bounds.ceiling;
  const statedTotal = claim.stated_total;
  const statedCeiling = claim.stated_ceiling;
  const money = extractMoneyTokens(String(text ?? ''));

  // Every monetary figure in the claim must be bound, with semantic
  // assignment (price/amount/cost/total → amount; budget/cap/max → ceiling).
  // One matching number must not verify the rest.
  if (money.length > 0 && !moneyTokensBound(money, bounds, tol)) {
    result.status = 'unverified_insufficient_bounds';
    result.surface = 'strip_reason';
    result.safe_reason = UNVERIFIED_STUB;
    result.log_code = 'numeric_unverified';
    result.detail = {
      has_amount: amount !== null,
      has_ceiling: ceiling !== null,
      relation: claim.relation,
      unbound_money: true,
    };
    return result;
  }

  if (claim.relation === 'exceed' && amount !== null && ceiling !== null) {
    const actuallyExceeds = amount > ceiling + tol;
    let numMismatch = false;
    if (
      statedTotal !== null &&
      Math.abs(statedTotal - amount) > Math.max(tol, 0.01 * Math.max(Math.abs(amount), 1))
    ) {
      numMismatch = true;
    }
    if (
      statedCeiling !== null &&
      Math.abs(statedCeiling - ceiling) > Math.max(tol, 0.01 * Math.max(Math.abs(ceiling), 1))
    ) {
      numMismatch = true;
    }

    if (!actuallyExceeds) {
      result.status = 'objection_evidence_fail';
      result.surface = 'strip_reason';
      result.safe_reason =
        `[objection_evidence_fail] claimed exceed but bound total ${amount} <= ceiling ${ceiling}`;
      result.log_code = 'numeric_exceed_false';
      result.detail = {
        computed_amount: amount,
        computed_ceiling: ceiling,
        actually_exceeds: false,
        num_mismatch: numMismatch,
      };
      return result;
    }

    if (numMismatch) {
      result.status = 'numbers_rewritten';
      result.surface = 'rewrite_reason';
      result.safe_reason = `Total ${amount} exceeds budget ceiling ${ceiling}.`;
      result.log_code = 'numeric_exceed_true_numbers_fixed';
    } else {
      result.status = 'verified';
      result.surface = 'pass_through';
      result.log_code = 'numeric_exceed_true';
    }
    result.detail = {
      computed_amount: amount,
      computed_ceiling: ceiling,
      actually_exceeds: true,
      num_mismatch: numMismatch,
    };
    return result;
  }

  if (claim.relation === 'within' && amount !== null && ceiling !== null) {
    const actuallyWithin = amount <= ceiling + tol;
    if (!actuallyWithin) {
      result.status = 'objection_evidence_fail';
      result.surface = 'strip_reason';
      result.safe_reason =
        `[objection_evidence_fail] claimed within budget but bound total ${amount} > ceiling ${ceiling}`;
      result.log_code = 'numeric_within_false';
      result.detail = { computed_amount: amount, computed_ceiling: ceiling };
      return result;
    }
    result.status = 'verified';
    result.surface = 'pass_through';
    result.log_code = 'numeric_within_true';
    result.detail = { computed_amount: amount, computed_ceiling: ceiling };
    return result;
  }

  // All cited money is bound and assigned. No exceed/within relation —
  // still pass through (Sony `budget mismatch ($848 vs $700 max)`).
  if (money.length > 0 && amount !== null && ceiling !== null) {
    result.status = 'verified';
    result.surface = 'pass_through';
    result.log_code = 'numeric_bound_match';
    result.detail = {
      computed_amount: amount,
      computed_ceiling: ceiling,
      relation: claim.relation,
    };
    return result;
  }

  // Numericish but insufficient bounds — fail-closed on surface text only
  result.status = 'unverified_insufficient_bounds';
  result.surface = 'strip_reason';
  result.safe_reason = UNVERIFIED_STUB;
  result.log_code = 'numeric_unverified';
  result.detail = {
    has_amount: amount !== null,
    has_ceiling: ceiling !== null,
    relation: claim.relation,
  };
  return result;
}

export interface AxisBindBatchResult {
  n: number;
  n_non_numeric: number;
  n_verified: number;
  n_evidence_fail: number;
  n_unverified: number;
  surface_gated: boolean;
  surface_axes: AxisResult[];
  items: BindItemResult[];
  codes: string[];
}

function applyTextBind(
  text: string,
  ctx: BindContext,
  counters: { non: number; verified: number; fail: number; unverified: number },
  items: BindItemResult[],
  codes: string[],
): { text: string; item: BindItemResult } {
  const r = bindObjectionText(text ?? '', ctx);
  items.push(r);
  if (r.log_code) codes.push(r.log_code);
  if (r.status === 'non_numeric') {
    counters.non++;
    return { text: text ?? '', item: r };
  }
  if (r.status === 'verified') {
    counters.verified++;
    return { text: text ?? '', item: r };
  }
  if (r.status === 'numbers_rewritten') {
    counters.verified++;
    return { text: r.safe_reason, item: r };
  }
  if (r.status === 'objection_evidence_fail') {
    counters.fail++;
    return { text: r.safe_reason, item: r };
  }
  counters.unverified++;
  return { text: r.safe_reason, item: r };
}

/**
 * Bind DQL per-axis surface text (objection + reasoning).
 * Axis verdicts and aggregate are never changed here.
 */
export function bindAxisResults(
  axes: AxisResult[],
  ctx: BindContext,
): AxisBindBatchResult {
  const items: BindItemResult[] = [];
  const codes: string[] = [];
  const counters = { non: 0, verified: 0, fail: 0, unverified: 0 };
  const surface: AxisResult[] = [];
  const objectionBinds: Array<BindItemResult | null> = [];

  for (const axis of axes ?? []) {
    const next: AxisResult = { ...axis };
    let objectionBind: BindItemResult | null = null;
    // Bind objection first (primary surface for FAIL/UNCERTAIN)
    if ((next.objection ?? '').trim()) {
      const applied = applyTextBind(next.objection, ctx, counters, items, codes);
      next.objection = applied.text;
      objectionBind = applied.item;
    } else {
      counters.non++;
    }
    // Bind reasoning second (always present)
    if ((next.reasoning ?? '').trim()) {
      const applied = applyTextBind(next.reasoning, ctx, counters, items, codes);
      next.reasoning = applied.text;
    } else {
      counters.non++;
    }
    objectionBinds.push(objectionBind);
    surface.push(next);
  }

  // Receipt / MCP hygiene: suppress the unverified stub only beside a
  // binder-verified FAIL (status verified + pass_through/rewrite_reason).
  // Unchecked model text must not hide the last unbound-numeric stub.
  suppressUnverifiedStubBesideConcreteFail(surface, objectionBinds);

  return {
    n: items.length,
    n_non_numeric: counters.non,
    n_verified: counters.verified,
    n_evidence_fail: counters.fail,
    n_unverified: counters.unverified,
    surface_gated: counters.fail + counters.unverified > 0,
    surface_axes: surface,
    items,
    codes,
  };
}

function isConcreteVerifiedFail(
  axis: AxisResult,
  objectionBind: BindItemResult | null,
): boolean {
  if (axis.verdict !== 'FAIL' || !objectionBind) return false;
  return (
    objectionBind.status === 'verified' &&
    (objectionBind.surface === 'pass_through' || objectionBind.surface === 'rewrite_reason')
  );
}

function suppressUnverifiedStubBesideConcreteFail(
  axes: AxisResult[],
  objectionBinds: Array<BindItemResult | null>,
): void {
  const hasConcreteFail = axes.some((a, i) =>
    isConcreteVerifiedFail(a, objectionBinds[i] ?? null),
  );
  if (!hasConcreteFail) return;
  for (const axis of axes) {
    if (isUnverifiedNumericStub(axis.objection ?? '')) {
      axis.objection = '';
    }
    if (isUnverifiedNumericStub(axis.reasoning ?? '')) {
      axis.reasoning = '';
    }
  }
}
