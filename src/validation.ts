/**
 * Request validation for POST /dql/verify.
 *
 * Pure — no I/O. Returns discriminated union so callers can narrow safely.
 */

import { AXES, type Axis, type DqlRequest } from './types.js';

const MAX_FIELD_LENGTH = 20_000;

export type ValidationResult =
  | { valid: true; request: Required<Omit<DqlRequest, 'context'>> & Pick<DqlRequest, 'context'> }
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
      axes,
      sandbox,
    },
  };
}

function requireString(
  b: Record<string, unknown>,
  key: string,
  errors: string[]
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
  errors: string[]
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
