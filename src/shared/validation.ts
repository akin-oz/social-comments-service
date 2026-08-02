import type { Comment, ExternalAuthor, Pagination, Platform } from './types.js';
import type { ListCommentsQuery, ReplyToCommentCommand } from '../comments/contracts.js';

export type DomainValidationCode =
  | 'INVALID_COMMENT'
  | 'INVALID_LIST_COMMENTS_QUERY'
  | 'INVALID_PAGINATION'
  | 'INVALID_REPLY_COMMAND';

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
    !isNonEmptyString(comment.publishedAt) ||
    !isNonEmptyString(comment.updatedAt)
  ) {
    throw new DomainValidationError(
      'INVALID_COMMENT',
      'A comment must contain valid identity, platform, author, body, parent, and timestamp fields.',
    );
  }
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
    !isNullableNonEmptyString(query.cursor) ||
    !Number.isInteger(query.limit) ||
    query.limit < 1
  ) {
    throw new DomainValidationError(
      'INVALID_LIST_COMMENTS_QUERY',
      'A comment query requires a post, supported platform, positive integer limit, and opaque cursor when provided.',
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
