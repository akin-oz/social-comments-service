const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Identifiers this service issues are UUIDs. Checking the shape before a value
 * reaches SQL keeps a malformed one from failing a `::uuid` cast, which
 * produced a 500 and an error-level log where the contract promises a 404.
 */
export function isUuid(value: string): boolean {
  return UUID.test(value);
}

/**
 * True only for the exact ISO-8601 UTC instant this service issues in a cursor.
 *
 * `encodeCursor` writes `new Date(...).toISOString()`, always
 * `YYYY-MM-DDTHH:mm:ss.sssZ`. Anything else did not come from this service, so
 * it is not a cursor position — and it must be rejected before it reaches a
 * `::timestamptz` cast. `Date.parse` is far more lenient than PostgreSQL:
 * "2026", "2026-8", "1", even the calendar-invalid "2026-02-30T00:00:00.000Z"
 * all parse to a finite number yet fail the cast with a 500. The round-trip
 * closes the gap: the regex fixes the shape and `toISOString() === value`
 * rejects a well-shaped but non-existent date, since Date normalises it to a
 * different day (Spec-022, second readiness sweep).
 */
const issuedTimestampShape = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export function isIssuedTimestamp(value: string): boolean {
  if (!issuedTimestampShape.test(value)) return false;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
}
