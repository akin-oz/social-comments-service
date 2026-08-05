const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Identifiers this service issues are UUIDs. Checking the shape before a value
 * reaches SQL keeps a malformed one from failing a `::uuid` cast, which
 * produced a 500 and an error-level log where the contract promises a 404.
 */
export function isUuid(value: string): boolean {
  return UUID.test(value);
}
