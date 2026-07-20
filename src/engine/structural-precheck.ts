/**
 * Deterministic Structural Pre-Check (ADR-0020)
 *
 * Sister pattern to Sentinel authorization-gate (ADR-0019) and cb4a fact-check:
 * binary, unfixable scope/identity violations belong in code, not the LLM.
 *
 * Runs BEFORE the DQL axis cascade when the caller supplies machine-readable
 * `structured_context`. Philosophy:
 *
 *   • Fail toward silence — missing/ambiguous fields → no opinion
 *   • Add-only — can only ADD blocks, never ALLOW
 *   • Never throws — any internal issue → silent
 *
 * Rollout: default gate_mode 'shadow' (compute + attach, do NOT short-circuit).
 * 'enforce' short-circuits the cascade on hard violations.
 *
 * Tolerances / thresholds are INITIAL / UNCALIBRATED until measured on real
 * structured traffic. Do NOT parse free-text mandates in v0.
 */

export type StructuralGateMode = 'shadow' | 'enforce';

export type StructuralViolationKind =
  | 'amount_overshoot'
  | 'recipient_mismatch'
  | 'iban_mismatch'
  | 'unlimited_approval'
  | 'history_variance_break';

export interface StructuralViolation {
  kind: StructuralViolationKind;
  detail: string;
}

/** What the principal authorized (typed). All fields optional. */
export interface StructuralGranted {
  /** Maximum amount authorized (same unit as proposed.amount). */
  max_amount?: number;
  /** ISO-ish currency code; amount compare is silent if currencies disagree. */
  amount_currency?: string;
  /** Authorized counterparty name / handle / address. */
  recipient?: string;
  /** Authorized IBAN (spaces ignored, case-insensitive). */
  iban?: string;
  /** Explicit unlimited-approval grant. Default false. */
  allow_unlimited?: boolean;
}

/** What the agent proposes (typed). All fields optional. */
export interface StructuralProposed {
  amount?: number;
  amount_currency?: string;
  recipient?: string;
  iban?: string;
  /** Approval allowance: number, or "unlimited" / "MAX_UINT256" / hex. */
  allowance?: string | number;
}

/** Optional payment-history evidence already computed by the caller. */
export interface StructuralHistory {
  /** Prior payments/renewals to the same counterparty/IBAN. */
  past_payments_to_same_counterparty?: number;
  /**
   * Relative amount deviation from historical band, e.g. 0.02 = 2%.
   * Only consulted when past_payments_to_same_counterparty ≥ HISTORY_MIN_COUNT.
   */
  amount_variance_from_history?: number;
}

/**
 * Machine-readable structured context. Independent of free-text `context`.
 * The pre-check speaks only when fields needed for a given rule are present
 * with full confidence.
 */
export interface DqlStructuredContext {
  granted?: StructuralGranted;
  proposed?: StructuralProposed;
  history?: StructuralHistory;
}

export interface StructuralPrecheckResult {
  mode: StructuralGateMode;
  /** True when at least one hard violation was detected. */
  would_block: boolean;
  /** True only in enforce mode with would_block. */
  enforced: boolean;
  violations: StructuralViolation[];
  /**
   * True when there was nothing usable to check (no structured fields, or
   * only incomplete pairs). LLM cascade is the backstop.
   */
  silent: boolean;
}

/** Effectively-unlimited allowance threshold. INITIAL / UNCALIBRATED. */
const UNLIMITED_ALLOWANCE_THRESHOLD = 1e30;

/** Amount may exceed ceiling by this fraction (fees/rounding). INITIAL. */
const AMOUNT_OVERSHOOT_TOLERANCE = 0.005; // 0.5%

/**
 * History-band hard break. Soft history / first-payment stay with LLM axes.
 * Only fires with past_payments ≥ HISTORY_MIN_COUNT. INITIAL / UNCALIBRATED.
 */
const HISTORY_VARIANCE_HARD = 0.2; // 20%
const HISTORY_MIN_COUNT = 3;

function parseAllowance(allowance: string | number | undefined): number | null {
  if (allowance === undefined || allowance === null) return null;
  if (typeof allowance === 'number') {
    return Number.isFinite(allowance) ? allowance : null;
  }
  if (typeof allowance !== 'string') return null;
  const s = allowance.trim().toLowerCase();
  if (s.length === 0) return null;
  if (
    s === 'unlimited' ||
    s === 'max_uint256' ||
    s === 'maxuint256' ||
    s === 'infinite' ||
    s === 'max'
  ) {
    return Infinity;
  }
  if (/^0x[0-9a-f]+$/.test(s)) {
    const hex = s.slice(2);
    if (hex.length >= 64 && /^f+$/i.test(hex.slice(0, 8))) return Infinity;
    const n = Number(s);
    return Number.isFinite(n) ? n : Infinity;
  }
  if (/^\d+(\.\d+)?$/.test(s)) {
    const n = parseFloat(s);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function normId(x: string | undefined): string | null {
  if (typeof x !== 'string') return null;
  const s = x.trim().toLowerCase();
  return s.length > 0 ? s : null;
}

function normIban(x: string | undefined): string | null {
  if (typeof x !== 'string') return null;
  const s = x.replace(/\s+/g, '').toUpperCase();
  return s.length > 0 ? s : null;
}

function normCurrency(x: string | undefined): string | null {
  if (typeof x !== 'string') return null;
  const s = x.trim().toUpperCase();
  return s.length > 0 ? s : null;
}

function finiteNumber(x: unknown): number | null {
  return typeof x === 'number' && Number.isFinite(x) ? x : null;
}

/**
 * Run the deterministic structural pre-check.
 * Pure. NEVER throws — on any internal issue returns silent.
 */
export function runStructuralPrecheck(
  structured: DqlStructuredContext | undefined,
  mode: StructuralGateMode = 'shadow',
): StructuralPrecheckResult {
  const violations: StructuralViolation[] = [];
  try {
    const granted = structured?.granted;
    const proposed = structured?.proposed;
    const history = structured?.history;

    const hasAny =
      (granted && Object.keys(granted).length > 0) ||
      (proposed && Object.keys(proposed).length > 0) ||
      (history && Object.keys(history).length > 0);

    if (!hasAny) {
      return {
        mode,
        would_block: false,
        enforced: false,
        violations: [],
        silent: true,
      };
    }

    // ── 1. Amount overshoot ──
    const maxAmount = finiteNumber(granted?.max_amount);
    const actionAmount = finiteNumber(proposed?.amount);
    if (maxAmount !== null && actionAmount !== null) {
      const gCur = normCurrency(granted?.amount_currency);
      const pCur = normCurrency(proposed?.amount_currency);
      // Fail-toward-silence on currency asymmetry: compare amounts ONLY when
      // units are unambiguously comparable — both unset (same implicit unit)
      // OR both set and equal. One side missing is "unknown unit", not "same".
      // (Probe 1 / ADR-0020 review 2026-07-20: EUR ceiling + bare proposed
      // amount must NOT hard-block; that was a false-block risk in enforce.)
      const currencyComparable =
        (gCur === null && pCur === null) ||
        (gCur !== null && pCur !== null && gCur === pCur);
      if (currencyComparable) {
        const ceiling = maxAmount * (1 + AMOUNT_OVERSHOOT_TOLERANCE);
        if (actionAmount > ceiling) {
          const unit = gCur ? ` ${gCur}` : '';
          violations.push({
            kind: 'amount_overshoot',
            detail:
              `Proposed amount ${actionAmount}${unit} exceeds granted maximum ` +
              `${maxAmount}${unit}. The principal did not authorize this magnitude.`,
          });
        }
      }
      // Currency disagreement OR one-sided currency → silence on amount (no FX).
    }

    // ── 2. Recipient mismatch ──
    const gRec = normId(granted?.recipient);
    const pRec = normId(proposed?.recipient);
    if (gRec !== null && pRec !== null && gRec !== pRec) {
      violations.push({
        kind: 'recipient_mismatch',
        detail:
          `Proposed recipient "${proposed!.recipient}" does not match authorized ` +
          `recipient "${granted!.recipient}".`,
      });
    }

    // ── 3. IBAN mismatch ──
    const gIban = normIban(granted?.iban);
    const pIban = normIban(proposed?.iban);
    if (gIban !== null && pIban !== null && gIban !== pIban) {
      violations.push({
        kind: 'iban_mismatch',
        detail:
          `Proposed IBAN does not match the authorized IBAN. ` +
          `The principal did not authorize this account.`,
      });
    }

    // ── 4. Unlimited approval without grant ──
    if (proposed) {
      const allowance = parseAllowance(proposed.allowance);
      const isUnlimited =
        allowance !== null && allowance >= UNLIMITED_ALLOWANCE_THRESHOLD;
      const grantedUnlimited = granted?.allow_unlimited === true;
      if (isUnlimited && !grantedUnlimited) {
        violations.push({
          kind: 'unlimited_approval',
          detail:
            `Proposed allowance is unlimited / effectively unbounded ` +
            `(${String(proposed.allowance)}) but unlimited approval was not granted. ` +
            `Least-privilege requires an exact-amount allowance.`,
        });
      }
    }

    // ── 5. History variance hard break (established counterparty only) ──
    const past = finiteNumber(history?.past_payments_to_same_counterparty);
    const variance = finiteNumber(history?.amount_variance_from_history);
    if (
      past !== null &&
      past >= HISTORY_MIN_COUNT &&
      variance !== null &&
      variance > HISTORY_VARIANCE_HARD
    ) {
      violations.push({
        kind: 'history_variance_break',
        detail:
          `Amount variance from history is ${(variance * 100).toFixed(1)}% ` +
          `over ${past} prior payments to the same counterparty ` +
          `(hard threshold ${(HISTORY_VARIANCE_HARD * 100).toFixed(0)}%). ` +
          `History no longer authorizes this magnitude.`,
      });
    }

    const would_block = violations.length > 0;
    const enforced = mode === 'enforce' && would_block;

    return {
      mode,
      would_block,
      enforced,
      violations,
      silent: false,
    };
  } catch {
    return {
      mode,
      would_block: false,
      enforced: false,
      violations: [],
      silent: true,
    };
  }
}

/** Build the public response.structural payload. */
export function toStructuralField(result: StructuralPrecheckResult): {
  mode: StructuralGateMode;
  would_block: boolean;
  enforced: boolean;
  silent: boolean;
  violations: StructuralViolation[];
} {
  return {
    mode: result.mode,
    would_block: result.would_block,
    enforced: result.enforced,
    silent: result.silent,
    violations: result.violations,
  };
}
