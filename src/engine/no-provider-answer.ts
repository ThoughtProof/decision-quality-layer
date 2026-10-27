/**
 * Request-level marker: the cascade threw before any provider served an
 * answer. Distinct from a model-emitted UNCERTAIN (that path returns from
 * the cascade and must stay billable — founder decision, Raul).
 *
 * Classification uses error types, not Error.message scraping.
 */

import type { DqlResponse, NoProviderAnswerMarker, NoProviderAnswerReason } from '../types.js';
import { CircuitAllOpenError, DeadlineExceededError, ProviderCallError } from './llm-client.js';

const REASON_ORDER: readonly NoProviderAnswerReason[] = [
  'outage',
  'http_error',
  'deadline',
  'abort',
];

function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError';
}

/**
 * Map a cascade throw to a no-answer reason.
 * Returns undefined for local/config errors (missing key, unknown alias,
 * unexpected bug) — those keep the pre-existing billing policy.
 *
 *   CircuitAllOpenError                         → outage
 *   DeadlineExceededError with aborted          → abort
 *   DeadlineExceededError otherwise             → deadline
 *   ProviderCallError caused by AbortError      → deadline
 *     (per-attempt timeout wraps AbortError; it is not a client abort)
 *   ProviderCallError (HTTP status or transport)→ http_error
 *   raw AbortError                              → abort
 */
export function classifyUnservedProviderFailure(err: unknown): NoProviderAnswerReason | undefined {
  if (err instanceof CircuitAllOpenError) return 'outage';
  if (err instanceof DeadlineExceededError) return err.aborted ? 'abort' : 'deadline';
  if (err instanceof ProviderCallError) {
    const cause = (err as { cause?: unknown }).cause;
    if (isAbortError(cause)) return 'deadline';
    return 'http_error';
  }
  if (isAbortError(err)) return 'abort';
  return undefined;
}

/**
 * Marker is set only when every evaluated axis failed closed for one of the
 * four reasons. One served axis (including a genuine UNCERTAIN) omits it.
 */
export function noProviderAnswerMarker(
  reasons: readonly (NoProviderAnswerReason | undefined)[],
): NoProviderAnswerMarker | undefined {
  if (reasons.length === 0) return undefined;
  if (reasons.some((reason) => reason === undefined)) return undefined;
  const present = new Set(reasons);
  const ordered = REASON_ORDER.filter((reason) => present.has(reason));
  if (ordered.length === 0) return undefined;
  return { reasons: ordered };
}

export function isNoProviderAnswer(response: Pick<DqlResponse, 'meta'>): boolean {
  const reasons = response.meta.no_provider_answer?.reasons;
  if (!reasons || reasons.length === 0) return false;
  return reasons.every(
    (reason) =>
      reason === 'outage' ||
      reason === 'http_error' ||
      reason === 'deadline' ||
      reason === 'abort',
  );
}
