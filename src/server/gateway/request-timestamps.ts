/**
 * Allocate a strictly increasing, millisecond-precision completion timestamp.
 *
 * Request IDs are created at request arrival (and may be caller supplied), so
 * they cannot break ties between completions persisted in the same millisecond.
 * Advancing by one millisecond on collision gives the SSE replay cursor a
 * stable completion order without changing the requests table or API shape.
 */
export function nextRequestCompletionTimestamp(now: Date, latestCreatedAt?: string | null): string {
  const nowMs = now.getTime();
  if (!Number.isFinite(nowMs)) throw new RangeError('Invalid current request completion time');
  if (!latestCreatedAt) return new Date(nowMs).toISOString();

  const latestMs = Date.parse(latestCreatedAt);
  if (!Number.isFinite(latestMs)) throw new RangeError('Invalid latest persisted request timestamp');

  return new Date(Math.max(nowMs, latestMs + 1)).toISOString();
}
