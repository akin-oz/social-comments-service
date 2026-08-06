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
  /**
   * Whether the run this cursor belongs to began over a snapshot the service
   * had not finished reading (Spec-021).
   *
   * It travels with the cursor because it is a property of the run, not of the
   * post: the snapshot may well be complete by the time the run ends, and the
   * run would still have missed everything backfilled behind its position.
   */
  partialRun: boolean;
}

interface EncodedCursor {
  a: [string, string] | null;
  /** Short, because every cursor carries it and clients never read it. */
  r?: 1;
}

export const emptyCursor: CommentCursor = { after: null, partialRun: false };

export function encodeCursor(cursor: CommentCursor): PageCursor {
  const payload: EncodedCursor = {
    a: cursor.after ? [cursor.after.publishedAt, cursor.after.id] : null,
    ...(cursor.partialRun ? { r: 1 as const } : {}),
  };
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

export function decodeCursor(value: PageCursor | undefined): CommentCursor {
  if (value === undefined) return emptyCursor;
  const payload = parse(value);
  const after = payload.a;
  if (after !== null && !isKeysetTuple(after)) throw invalidCursor();
  return {
    after: after === null ? null : { publishedAt: after[0], id: after[1] },
    partialRun: payload.r === 1,
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
    // Half the keyset reaches a ::timestamptz cast. A non-empty string that is
    // not a timestamp is not a cursor this service issued, and letting it
    // through turned into a 500 with an error-level log any caller could raise
    // at will — the identifier half was guarded, this half was not (Spec-022).
    Number.isFinite(Date.parse(value[0])) &&
    isNonEmptyString(value[1])
  );
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function invalidCursor(): ServiceError {
  return new ServiceError(
    'INVALID_CURSOR',
    'cursor_not_issued_by_service',
    'The pagination cursor is invalid.',
    400,
  );
}
