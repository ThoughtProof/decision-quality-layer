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
  /(?:total|sum|cost|amount|price|notional|size)\s*(?:is|=|:)?\s*\$?\s*([0-9]+(?:[.,][0-9]+)?)/i;

const CEILING_RE =
  /(?:budget|ceiling|limit|max(?:imum)?)\s*(?:of|is|=|:)?\s*\$?\s*([0-9]+(?:[.,][0-9]+)?)/i;

const NUM_RE = /([0-9]+(?:[.,][0-9]+)?)/g;

const MONEY_PAIR_RE =
  /\$?\s*([0-9]+(?:[.,][0-9]+)?)\s*(?:\+|and|,)?\s*\$?\s*([0-9]+(?:[.,][0-9]+)?)\s*=\s*\$?\s*([0-9]+(?:[.,][0-9]+)?)/i;

/** `$848` or `848 USD` — not bare model numbers (A6400). */
const DOLLAR_RE = /\$\s*([0-9]+(?:[.,][0-9]+)?)/g;
const CURRENCY_AMT_RE =
  /(?:^|[^\w.])([0-9]+(?:[.,][0-9]+)?)\s*(?:usd|eur|gbp)\b/gi;
const AMOUNT_TEXT_RE =
  /(?:amount|price|cost|total|notional)\s*(?:is|=|:)?\s*\$?\s*([0-9]+(?:[.,][0-9]+)?)/i;
const UNDER_CEILING_RE =
  /(?:under|below|up to|at most|no more than)\s+\$?\s*([0-9]+(?:[.,][0-9]+)?)/i;

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
  if (typeof x === 'string') {
    const s = x.trim().replace(/,/g, '').replace(/\$/g, '');
    const m = s.match(/-?\d+(?:\.\d+)?/);
    if (!m) return null;
    const v = Number(m[0]);
    return Number.isFinite(v) ? v : null;
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

  // free-text ceiling from free-text fields if still missing
  if (out.ceiling === null) {
    for (const t of [ctx.mandate, ctx.proposed_action, ctx.reasoning, ctx.context]) {
      if (!t) continue;
      const m = CEILING_RE.exec(t) ?? UNDER_CEILING_RE.exec(t);
      if (m) {
        const v = num(m[1]);
        if (v !== null) {
          out.ceiling = v;
          out.sources.push('text.ceiling');
          break;
        }
      }
    }
  }

  // Free-text proposed_action money (Sony / A6400 family): `$848` is bound
  // evidence for the action amount when structured.proposed.amount is absent.
  // Do not harvest bare integers — model numbers like A6400 are not amounts.
  if (out.amount === null && ctx.proposed_action) {
    const fromLabel = AMOUNT_TEXT_RE.exec(ctx.proposed_action);
    const labeled = fromLabel ? num(fromLabel[1]) : null;
    if (labeled !== null && labeled !== out.ceiling) {
      out.amount = labeled;
      out.sources.push('text.proposed_action.amount');
    } else {
      const money = extractMoneyAmounts(ctx.proposed_action).filter(
        (v) => out.ceiling === null || Math.abs(v - out.ceiling) > 1e-6,
      );
      if (money.length === 1) {
        out.amount = money[0]!;
        out.sources.push('text.proposed_action.money');
      } else if (money.length > 1) {
        out.amount = Math.max(...money);
        out.sources.push('text.proposed_action.money_max');
      }
    }
  }

  return out;
}

function extractMoneyAmounts(text: string): number[] {
  const out: number[] = [];
  if (!text) return out;
  for (const m of text.matchAll(DOLLAR_RE)) {
    const v = num(m[1]);
    if (v !== null) out.push(v);
  }
  for (const m of text.matchAll(CURRENCY_AMT_RE)) {
    const v = num(m[1]);
    if (v !== null) out.push(v);
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
    const v = num(m[1]);
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
    claim.stated_total = num(mt[1]);
    claim.is_numericish = true;
  }
  const mc = CEILING_RE.exec(s);
  if (mc) {
    claim.stated_ceiling = num(mc[1]);
    claim.is_numericish = true;
  }
  const mp = MONEY_PAIR_RE.exec(s);
  if (mp) {
    claim.stated_total = num(mp[3]);
    claim.is_numericish = true;
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

  // Numericish without exceed/within wording, but the cited figures are
  // already bound (proposed_action / structured_context). Pass through —
  // do not invent an unverified stub next to a bound-checked mismatch.
  if (amount !== null && ceiling !== null && claim.parsed_numbers.length > 0) {
    const boundMatch = claim.parsed_numbers.some(
      (n) =>
        Math.abs(n - amount) <= Math.max(tol, 0.01 * Math.max(Math.abs(amount), 1)) ||
        Math.abs(n - ceiling) <= Math.max(tol, 0.01 * Math.max(Math.abs(ceiling), 1)),
    );
    if (boundMatch) {
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
): string {
  const r = bindObjectionText(text ?? '', ctx);
  items.push(r);
  if (r.log_code) codes.push(r.log_code);
  if (r.status === 'non_numeric') {
    counters.non++;
    return text ?? '';
  }
  if (r.status === 'verified') {
    counters.verified++;
    return text ?? '';
  }
  if (r.status === 'numbers_rewritten') {
    counters.verified++;
    return r.safe_reason;
  }
  if (r.status === 'objection_evidence_fail') {
    counters.fail++;
    return r.safe_reason;
  }
  counters.unverified++;
  return r.safe_reason;
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

  for (const axis of axes ?? []) {
    const next: AxisResult = { ...axis };
    // Bind objection first (primary surface for FAIL/UNCERTAIN)
    if ((next.objection ?? '').trim()) {
      next.objection = applyTextBind(next.objection, ctx, counters, items, codes);
    } else {
      counters.non++;
    }
    // Bind reasoning second (always present)
    if ((next.reasoning ?? '').trim()) {
      next.reasoning = applyTextBind(next.reasoning, ctx, counters, items, codes);
    } else {
      counters.non++;
    }
    surface.push(next);
  }

  // Receipt / MCP hygiene: if a real FAIL objection already cites the
  // bound-checked reason, do not also emit the unverified stub. Verdicts
  // stay unchanged. If the stub is the only FAIL surface, keep it
  // (fail-closed).
  suppressUnverifiedStubBesideConcreteFail(surface);

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

function suppressUnverifiedStubBesideConcreteFail(axes: AxisResult[]): void {
  const hasConcreteFail = axes.some((a) => {
    if (a.verdict !== 'FAIL') return false;
    const o = (a.objection ?? '').trim();
    return o.length > 0 && !isUnverifiedNumericStub(o);
  });
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
