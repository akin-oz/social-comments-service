import { StoredRecordInvalidError } from './errors.js';
import type {
  Comment,
  CommentKeyset,
  ExternalAuthor,
  ObservedComment,
  Pagination,
  Platform,
  ReplyOperation,
  ReplyOperationStatus,
} from './types.js';
import type { ListCommentsQuery, ReplyToCommentCommand } from '../comments/contracts.js';

export type DomainValidationCode =
  | 'INVALID_COMMENT'
  | 'INVALID_LIST_COMMENTS_QUERY'
  | 'INVALID_PAGINATION'
  | 'INVALID_REPLY_COMMAND'
  | 'INVALID_REPLY_OPERATION';

export class DomainValidationError extends Error {
  public constructor(
    public readonly code: DomainValidationCode,
    message: string,
  ) {
    super(message);
    this.name = 'DomainValidationError';
  }
}

const platforms: readonly Platform[] = ['facebook', 'instagram', 'linkedin', 'x', 'youtube'];

export function isPlatform(value: string): value is Platform {
  return platforms.includes(value as Platform);
}

export function validateComment(comment: Comment): void {
  if (
    !isNonEmptyString(comment.id) ||
    !isNonEmptyString(comment.postId) ||
    !isPlatform(comment.platform) ||
    !isValidAuthor(comment.author) ||
    !isNonEmptyString(comment.body) ||
    !isNullableNonEmptyString(comment.parentCommentId) ||
    typeof comment.parentUnresolved !== 'boolean' ||
    // A resolved parent and an unresolved one are mutually exclusive by
    // construction: `parentUnresolved` means the join found nothing, so a row
    // claiming both is an adapter that computed one of them wrong (ADR-0016).
    (comment.parentCommentId !== null && comment.parentUnresolved) ||
    !isNonEmptyString(comment.publishedAt) ||
    !isNonEmptyString(comment.updatedAt)
  ) {
    throw new DomainValidationError(
      'INVALID_COMMENT',
      'A comment must contain valid identity, platform, author, body, parent, and timestamp fields.',
    );
  }
}

export function validateObservedComment(observed: ObservedComment): void {
  if (
    !isNonEmptyString(observed.postId) ||
    !isPlatform(observed.platform) ||
    !isValidAuthor(observed.author) ||
    !isNonEmptyString(observed.body) ||
    !isNonEmptyString(observed.publishedAt) ||
    !isNonEmptyString(observed.updatedAt) ||
    !isNonEmptyString(observed.externalId) ||
    !isNullableNonEmptyString(observed.externalParentCommentId)
  ) {
    throw new DomainValidationError(
      'INVALID_COMMENT',
      'An observed comment requires a post, supported platform, author, body, timestamps, and the provider identifiers used for deduplication.',
    );
  }
}

const replyOperationStatuses: readonly ReplyOperationStatus[] = [
  'pending',
  'completed',
  'failed',
  'unknown',
];

/**
 * What a reply operation must look like to be usable.
 *
 * Written for the mapper that actually shipped broken: `toOperation` cast a
 * snake_case row to this type, so every field read as `undefined`, every
 * idempotent retry looked like a different request, and nothing noticed
 * (Spec-025).
 */
export function validateReplyOperation(operation: ReplyOperation): void {
  if (
    !isNonEmptyString(operation.id) ||
    !isNonEmptyString(operation.accountId) ||
    !isNonEmptyString(operation.commentId) ||
    !isNonEmptyString(operation.idempotencyKey) ||
    !isNonEmptyString(operation.requestFingerprint) ||
    !replyOperationStatuses.includes(operation.status) ||
    !isNullableNonEmptyString(operation.resultingCommentId) ||
    !isNullableNonEmptyString(operation.failureCode) ||
    !isNonEmptyString(operation.leaseExpiresAt) ||
    !isNullableNonEmptyString(operation.externalReplyId) ||
    !isNonEmptyString(operation.createdAt) ||
    !isNullableNonEmptyString(operation.completedAt)
  ) {
    throw new DomainValidationError(
      'INVALID_REPLY_OPERATION',
      'A reply operation requires identity, tenancy, a comment, a key, a fingerprint, a known status, a lease, and a creation timestamp.',
    );
  }
}

/**
 * Checks a comment on its way out of a repository, and reports a failure as
 * this service's fault rather than the caller's.
 *
 * The translation is the point. `validateComment` throws a
 * `DomainValidationError`, which the route handler maps to a 400 — correct for
 * its other callers, all of which validate something supplied from outside,
 * and wrong here (Spec-025).
 */
export function assertStoredComment(comment: Comment): Comment {
  try {
    validateComment(comment);
  } catch (error) {
    throw asStoredRecordFault('comment', comment.id, error);
  }
  return comment;
}

/** The reply-operation twin of {@link assertStoredComment}. */
export function assertStoredReplyOperation(operation: ReplyOperation): ReplyOperation {
  try {
    validateReplyOperation(operation);
  } catch (error) {
    throw asStoredRecordFault('reply_operation', operation.id, error);
  }
  return operation;
}

function asStoredRecordFault(
  kind: 'comment' | 'reply_operation',
  id: unknown,
  error: unknown,
): StoredRecordInvalidError {
  return new StoredRecordInvalidError(
    kind,
    typeof id === 'string' && id.trim() !== '' ? id : null,
    error instanceof DomainValidationError ? error.code : 'unknown',
  );
}

export function validatePagination(pagination: Pagination): void {
  if (
    typeof pagination.hasMore !== 'boolean' ||
    !isNullableNonEmptyString(pagination.nextCursor) ||
    (pagination.hasMore && pagination.nextCursor === null)
  ) {
    throw new DomainValidationError(
      'INVALID_PAGINATION',
      'Pagination must contain a valid cursor state; a page with more results requires a next cursor.',
    );
  }
}

export function validateListCommentsQuery(query: ListCommentsQuery): void {
  if (
    !isNonEmptyString(query.postId) ||
    !isPlatform(query.platform) ||
    !isValidKeyset(query.after) ||
    !Number.isInteger(query.limit) ||
    query.limit < 1
  ) {
    throw new DomainValidationError(
      'INVALID_LIST_COMMENTS_QUERY',
      'A comment query requires a post, supported platform, positive integer limit, and complete keyset when provided.',
    );
  }
}

export function validateReplyToCommentCommand(command: ReplyToCommentCommand): void {
  if (
    !isNonEmptyString(command.commentId) ||
    !isNonEmptyString(command.body) ||
    !isNonEmptyString(command.idempotencyKey)
  ) {
    throw new DomainValidationError(
      'INVALID_REPLY_COMMAND',
      'A reply command requires a comment ID, non-empty body, and idempotency key.',
    );
  }
}

function isValidKeyset(keyset: CommentKeyset | undefined): boolean {
  if (keyset === undefined) return true;
  return isNonEmptyString(keyset.publishedAt) && isNonEmptyString(keyset.id);
}

function isValidAuthor(author: ExternalAuthor): boolean {
  return (
    isNonEmptyString(author.id) &&
    isNonEmptyString(author.displayName) &&
    isNullableNonEmptyString(author.profileUrl)
  );
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isNullableNonEmptyString(value: unknown): value is string | null | undefined {
  return value === null || value === undefined || isNonEmptyString(value);
}
