/**
 * Request validation for POST /dql/verify.
 *
 * Pure — no I/O. Returns discriminated union so callers can narrow safely.
 */

import {
  AXES,
  type Axis,
  type DqlRequest,
  type DqlStructuredContext,
  type StructuralGateMode,
  type StructuralGranted,
  type StructuralHistory,
  type StructuralProposed,
} from './types.js';

const MAX_FIELD_LENGTH = 20_000;

/** Validated request shape: required fields filled, optionals preserved. */
export type ValidatedDqlRequest = Required<
  Omit<DqlRequest, 'context' | 'structured_context' | 'gate_mode'>
> &
  Pick<DqlRequest, 'context' | 'structured_context' | 'gate_mode'>;

export type ValidationResult =
  | { valid: true; request: ValidatedDqlRequest }
  | { valid: false; errors: string[] };

export function validateVerifyRequest(body: unknown): ValidationResult {
  const errors: string[] = [];

  if (body === null || typeof body !== 'object') {
    return { valid: false, errors: ['Request body must be a JSON object'] };
  }

  const b = body as Record<string, unknown>;

  const mandate = requireString(b, 'mandate', errors);
  const proposed_action = requireString(b, 'proposed_action', errors);
  const reasoning = requireString(b, 'reasoning', errors);
  const context = optionalString(b, 'context', errors);

  let axes: Axis[] = [...AXES];
  if (b.axes !== undefined) {
    if (!Array.isArray(b.axes)) {
      errors.push('axes must be an array of axis names');
    } else {
      const invalid: string[] = [];
      const chosen: Axis[] = [];
      for (const a of b.axes) {
        if (typeof a === 'string' && (AXES as readonly string[]).includes(a)) {
          chosen.push(a as Axis);
        } else {
          invalid.push(String(a));
        }
      }
      if (invalid.length > 0) {
        errors.push(`Unknown axes: ${invalid.join(', ')}. Valid: ${AXES.join(', ')}`);
      }
      if (chosen.length === 0 && invalid.length === 0) {
        errors.push('axes array cannot be empty');
      }
      axes = dedupe(chosen);
    }
  }

  let sandbox = false;
  if (b.sandbox !== undefined) {
    if (typeof b.sandbox !== 'boolean') {
      errors.push('sandbox must be a boolean if provided');
    } else {
      sandbox = b.sandbox;
    }
  }

  let gate_mode: StructuralGateMode | undefined;
  if (b.gate_mode !== undefined) {
    if (b.gate_mode !== 'shadow' && b.gate_mode !== 'enforce') {
      errors.push("gate_mode must be 'shadow' or 'enforce' if provided");
    } else {
      gate_mode = b.gate_mode;
    }
  }

  let structured_context: DqlStructuredContext | undefined;
  if (b.structured_context !== undefined) {
    structured_context = parseStructuredContext(b.structured_context, errors);
  }

  if (errors.length > 0) {
    return { valid: false, errors };
  }

  return {
    valid: true,
    request: {
      mandate: mandate as string,
      proposed_action: proposed_action as string,
      reasoning: reasoning as string,
      context: context ?? undefined,
      structured_context,
      gate_mode,
      axes,
      sandbox,
    },
  };
}

function parseStructuredContext(
  raw: unknown,
  errors: string[],
): DqlStructuredContext | undefined {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    errors.push('structured_context must be an object if provided');
    return undefined;
  }
  const o = raw as Record<string, unknown>;
  const out: DqlStructuredContext = {};

  if (o.granted !== undefined) {
    const g = parseGranted(o.granted, errors);
    if (g) out.granted = g;
  }
  if (o.proposed !== undefined) {
    const p = parseProposed(o.proposed, errors);
    if (p) out.proposed = p;
  }
  if (o.history !== undefined) {
    const h = parseHistory(o.history, errors);
    if (h) out.history = h;
  }

  // Unknown top-level keys are ignored (forward-compat).
  return out;
}

function parseGranted(
  raw: unknown,
  errors: string[],
): StructuralGranted | undefined {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    errors.push('structured_context.granted must be an object');
    return undefined;
  }
  const o = raw as Record<string, unknown>;
  const g: StructuralGranted = {};
  if (o.max_amount !== undefined) {
    const n = requireFiniteNumber(o.max_amount, 'structured_context.granted.max_amount', errors);
    if (n !== undefined) g.max_amount = n;
  }
  if (o.amount_currency !== undefined) {
    const s = requireNonEmptyString(
      o.amount_currency,
      'structured_context.granted.amount_currency',
      errors,
    );
    if (s !== undefined) g.amount_currency = s;
  }
  if (o.recipient !== undefined) {
    const s = requireNonEmptyString(
      o.recipient,
      'structured_context.granted.recipient',
      errors,
    );
    if (s !== undefined) g.recipient = s;
  }
  if (o.iban !== undefined) {
    const s = requireNonEmptyString(o.iban, 'structured_context.granted.iban', errors);
    if (s !== undefined) g.iban = s;
  }
  if (o.allow_unlimited !== undefined) {
    if (typeof o.allow_unlimited !== 'boolean') {
      errors.push('structured_context.granted.allow_unlimited must be a boolean');
    } else {
      g.allow_unlimited = o.allow_unlimited;
    }
  }
  return g;
}

function parseProposed(
  raw: unknown,
  errors: string[],
): StructuralProposed | undefined {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    errors.push('structured_context.proposed must be an object');
    return undefined;
  }
  const o = raw as Record<string, unknown>;
  const p: StructuralProposed = {};
  if (o.amount !== undefined) {
    const n = requireFiniteNumber(o.amount, 'structured_context.proposed.amount', errors);
    if (n !== undefined) p.amount = n;
  }
  if (o.amount_currency !== undefined) {
    const s = requireNonEmptyString(
      o.amount_currency,
      'structured_context.proposed.amount_currency',
      errors,
    );
    if (s !== undefined) p.amount_currency = s;
  }
  if (o.recipient !== undefined) {
    const s = requireNonEmptyString(
      o.recipient,
      'structured_context.proposed.recipient',
      errors,
    );
    if (s !== undefined) p.recipient = s;
  }
  if (o.iban !== undefined) {
    const s = requireNonEmptyString(o.iban, 'structured_context.proposed.iban', errors);
    if (s !== undefined) p.iban = s;
  }
  if (o.allowance !== undefined) {
    if (typeof o.allowance === 'number') {
      if (!Number.isFinite(o.allowance)) {
        errors.push('structured_context.proposed.allowance must be a finite number or string');
      } else {
        p.allowance = o.allowance;
      }
    } else if (typeof o.allowance === 'string') {
      if (o.allowance.length === 0) {
        errors.push('structured_context.proposed.allowance cannot be empty');
      } else if (o.allowance.length > 256) {
        errors.push('structured_context.proposed.allowance exceeds max length of 256');
      } else {
        p.allowance = o.allowance;
      }
    } else {
      errors.push('structured_context.proposed.allowance must be a number or string');
    }
  }
  return p;
}

function parseHistory(
  raw: unknown,
  errors: string[],
): StructuralHistory | undefined {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    errors.push('structured_context.history must be an object');
    return undefined;
  }
  const o = raw as Record<string, unknown>;
  const h: StructuralHistory = {};
  if (o.past_payments_to_same_counterparty !== undefined) {
    const n = requireFiniteNumber(
      o.past_payments_to_same_counterparty,
      'structured_context.history.past_payments_to_same_counterparty',
      errors,
    );
    if (n !== undefined) h.past_payments_to_same_counterparty = n;
  }
  if (o.amount_variance_from_history !== undefined) {
    const n = requireFiniteNumber(
      o.amount_variance_from_history,
      'structured_context.history.amount_variance_from_history',
      errors,
    );
    if (n !== undefined) h.amount_variance_from_history = n;
  }
  return h;
}

function requireFiniteNumber(
  v: unknown,
  path: string,
  errors: string[],
): number | undefined {
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    errors.push(`${path} must be a finite number`);
    return undefined;
  }
  return v;
}

function requireNonEmptyString(
  v: unknown,
  path: string,
  errors: string[],
): string | undefined {
  if (typeof v !== 'string') {
    errors.push(`${path} must be a string`);
    return undefined;
  }
  if (v.length === 0) {
    errors.push(`${path} cannot be empty`);
    return undefined;
  }
  if (v.length > MAX_FIELD_LENGTH) {
    errors.push(`${path} exceeds max length of ${MAX_FIELD_LENGTH} characters`);
    return undefined;
  }
  return v;
}

function requireString(
  b: Record<string, unknown>,
  key: string,
  errors: string[],
): string | undefined {
  const v = b[key];
  if (typeof v !== 'string') {
    errors.push(`${key} is required and must be a string`);
    return undefined;
  }
  if (v.length === 0) {
    errors.push(`${key} cannot be empty`);
    return undefined;
  }
  if (v.length > MAX_FIELD_LENGTH) {
    errors.push(`${key} exceeds max length of ${MAX_FIELD_LENGTH} characters`);
    return undefined;
  }
  return v;
}

function optionalString(
  b: Record<string, unknown>,
  key: string,
  errors: string[],
): string | undefined {
  const v = b[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string') {
    errors.push(`${key} must be a string if provided`);
    return undefined;
  }
  if (v.length > MAX_FIELD_LENGTH) {
    errors.push(`${key} exceeds max length of ${MAX_FIELD_LENGTH} characters`);
    return undefined;
  }
  return v;
}

function dedupe<T>(xs: T[]): T[] {
  return Array.from(new Set(xs));
}
