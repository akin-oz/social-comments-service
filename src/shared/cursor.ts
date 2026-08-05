import { ServiceError } from './errors.js';
import type { CommentKeyset, PageCursor } from './types.js';

/**
 * Decoded form of the opaque cursor exposed by the REST API.
 *
 * It carries only the caller's position in the local snapshot. It used to
 * carry the provider's continuation token as well, which handed clients the
 * very token vendors document must not be stored, and which the service
 * stopped reading once that state was persisted against the post (Spec-014).
 */
export interface CommentCursor {
  after: CommentKeyset | null;
}

interface EncodedCursor {
  a: [string, string] | null;
}

export const emptyCursor: CommentCursor = { after: null };

export function encodeCursor(cursor: CommentCursor): PageCursor {
  const payload: EncodedCursor = {
    a: cursor.after ? [cursor.after.publishedAt, cursor.after.id] : null,
  };
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

export function decodeCursor(value: PageCursor | undefined): CommentCursor {
  if (value === undefined) return emptyCursor;
  const payload = parse(value);
  const after = payload.a;
  if (after !== null && !isKeysetTuple(after)) throw invalidCursor();
  return { after: after === null ? null : { publishedAt: after[0], id: after[1] } };
}

function parse(value: PageCursor): EncodedCursor {
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
  } catch {
    throw invalidCursor();
  }
  if (typeof decoded !== 'object' || decoded === null) throw invalidCursor();
  const candidate = decoded as Record<string, unknown>;
  if (!('a' in candidate)) throw invalidCursor();
  if (candidate.a !== null && !Array.isArray(candidate.a)) throw invalidCursor();
  // A previously issued cursor may still carry the dropped provider field; it
  // is ignored rather than rejected.
  return candidate as unknown as EncodedCursor;
}

function isKeysetTuple(value: unknown): value is [string, string] {
  return (
    Array.isArray(value) &&
    value.length === 2 &&
    isNonEmptyString(value[0]) &&
    isNonEmptyString(value[1])
  );
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function invalidCursor(): ServiceError {
  return new ServiceError('INVALID_CURSOR', 'The pagination cursor is invalid.', 400);
}
