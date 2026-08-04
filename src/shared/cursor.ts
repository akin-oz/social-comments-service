import { ServiceError } from './errors.js';
import type { CommentKeyset, PageCursor } from './types.js';

/**
 * Decoded form of the opaque cursor exposed by the REST API.
 *
 * `after` positions the caller inside the locally cached page ordering.
 * `providerCursor` carries the upstream continuation token so a later page can
 * still be hydrated from the provider once the cache is exhausted.
 */
export interface CommentCursor {
  after: CommentKeyset | null;
  providerCursor: string | null;
}

interface EncodedCursor {
  a: [string, string] | null;
  p: string | null;
}

export const emptyCursor: CommentCursor = { after: null, providerCursor: null };

export function encodeCursor(cursor: CommentCursor): PageCursor {
  const payload: EncodedCursor = {
    a: cursor.after ? [cursor.after.publishedAt, cursor.after.id] : null,
    p: cursor.providerCursor,
  };
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

export function decodeCursor(value: PageCursor | undefined): CommentCursor {
  if (value === undefined) return emptyCursor;
  const payload = parse(value);
  const after = payload.a;
  if (after !== null && !isKeysetTuple(after)) throw invalidCursor();
  if (payload.p !== null && !isNonEmptyString(payload.p)) throw invalidCursor();
  return {
    after: after === null ? null : { publishedAt: after[0], id: after[1] },
    providerCursor: payload.p,
  };
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
  if (!('a' in candidate) || !('p' in candidate)) throw invalidCursor();
  if (candidate.a !== null && !Array.isArray(candidate.a)) throw invalidCursor();
  if (candidate.p !== null && typeof candidate.p !== 'string') throw invalidCursor();
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
