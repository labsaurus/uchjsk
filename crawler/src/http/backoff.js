// Exponential backoff with jitter + Retry-After parsing.

export const RETRYABLE_STATUSES = new Set([408, 429, 500, 502, 503, 504]);

/**
 * "Equal jitter" exponential backoff: half the exponential delay is fixed,
 * half is random. Guarantees a meaningful minimum wait while still
 * de-synchronising workers.
 */
export function computeBackoff(attempt, { baseMs, maxMs }, rand = Math.random) {
  const exp = Math.min(maxMs, baseMs * 2 ** Math.max(0, attempt));
  const half = exp / 2;
  return Math.round(half + rand() * half);
}

/**
 * Parse a Retry-After header value (delta-seconds or HTTP-date).
 * Returns milliseconds to wait, or null if absent/invalid.
 */
export function parseRetryAfter(value, now = Date.now()) {
  if (value == null) return null;
  const v = String(value).trim();
  if (v === '') return null;
  if (/^\d+$/.test(v)) return Number(v) * 1000;
  const date = Date.parse(v);
  if (Number.isNaN(date)) return null;
  return Math.max(0, date - now);
}

/**
 * Decide how long to wait before the next retry. Retry-After always wins if
 * it asks for longer than our own backoff. Returns null when the server asks
 * us to wait longer than we're willing to (caller should give up on the item).
 */
export function retryDelay(attempt, retryAfterMs, opts, rand) {
  const computed = computeBackoff(attempt, opts, rand);
  if (retryAfterMs == null) return computed;
  if (retryAfterMs > opts.retryAfterMaxMs) return null;
  return Math.max(computed, retryAfterMs);
}
