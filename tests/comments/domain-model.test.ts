import { describe, expect, it } from 'vitest';

import {
  DomainValidationError,
  isPlatform,
  validateComment,
  validateListCommentsQuery,
  validateObservedComment,
  validatePagination,
  validateReplyToCommentCommand,
} from '../../src/shared/validation.js';
import { assertStoredComment, assertStoredReplyOperation } from '../../src/shared/validation.js';
import { StoredRecordInvalidError } from '../../src/shared/errors.js';
import type { Comment, ReplyOperation } from '../../src/shared/types.js';

const operation: ReplyOperation = {
  id: 'operation_123',
  accountId: 'account_123',
  commentId: 'comment_123',
  idempotencyKey: 'request-1',
  requestFingerprint: 'fingerprint',
  status: 'pending',
  resultingCommentId: null,
  failureCode: null,
  leaseExpiresAt: '2026-08-01T10:02:00.000Z',
  externalReplyId: null,
  createdAt: '2026-08-01T10:00:00.000Z',
  completedAt: null,
};

const comment: Comment = {
  id: 'comment_123',
  postId: 'post_123',
  platform: 'instagram',
  author: {
    id: 'author_123',
    displayName: 'Ada Lovelace',
  },
  body: 'This is great!',
  parentCommentId: null,
  parentUnresolved: false,
  publishedAt: '2026-08-01T10:00:00.000Z',
  updatedAt: '2026-08-01T10:00:00.000Z',
};

describe('comment domain model', () => {
  it('recognizes only supported platforms', () => {
    expect(isPlatform('instagram')).toBe(true);
    expect(isPlatform('mastodon')).toBe(false);
  });

  it('validates a root comment and a one-level reply', () => {
    expect(() => validateComment(comment)).not.toThrow();
    expect(() =>
      validateComment({ ...comment, id: 'reply_123', parentCommentId: comment.id }),
    ).not.toThrow();
  });

  it('rejects incomplete comments with a typed domain error', () => {
    expect(() => validateComment({ ...comment, body: '  ' })).toThrowError(
      new DomainValidationError(
        'INVALID_COMMENT',
        'A comment must contain valid identity, platform, author, body, parent, and timestamp fields.',
      ),
    );
  });

  it('validates opaque pagination state', () => {
    expect(() => validatePagination({ nextCursor: 'cursor_2', hasMore: true })).not.toThrow();
    expect(() => validatePagination({ nextCursor: null, hasMore: false })).not.toThrow();
    expect(() => validatePagination({ nextCursor: null, hasMore: true })).toThrowError(
      'a page with more results requires a next cursor',
    );
  });

  it('validates list queries and positive limits', () => {
    expect(() =>
      validateListCommentsQuery({
        postId: comment.postId,
        platform: comment.platform,
        limit: 25,
      }),
    ).not.toThrow();
    expect(() =>
      validateListCommentsQuery({
        postId: comment.postId,
        platform: comment.platform,
        limit: 0,
      }),
    ).toThrowError('positive integer limit');
  });

  it('requires a complete keyset when a position is supplied', () => {
    const query = { postId: comment.postId, platform: comment.platform, limit: 25 };
    expect(() =>
      validateListCommentsQuery({
        ...query,
        after: { publishedAt: comment.publishedAt, id: comment.id },
      }),
    ).not.toThrow();
    expect(() =>
      validateListCommentsQuery({ ...query, after: { publishedAt: '', id: comment.id } }),
    ).toThrowError('complete keyset');
  });

  it('requires provider identifiers on an observed comment', () => {
    const observed = {
      postId: comment.postId,
      platform: comment.platform,
      author: comment.author,
      body: comment.body,
      publishedAt: comment.publishedAt,
      updatedAt: comment.updatedAt,
      externalId: 'ig-comment-1',
      externalParentCommentId: null,
    };
    expect(() => validateObservedComment(observed)).not.toThrow();
    expect(() => validateObservedComment({ ...observed, externalId: ' ' })).toThrowError(
      'provider identifiers',
    );
  });

  it('requires an idempotency key for replies', () => {
    expect(() =>
      validateReplyToCommentCommand({
        commentId: comment.id,
        body: 'Thank you!',
        idempotencyKey: 'reply-request-1',
      }),
    ).not.toThrow();
    expect(() =>
      validateReplyToCommentCommand({
        commentId: comment.id,
        body: 'Thank you!',
        idempotencyKey: ' ',
      }),
    ).toThrowError('idempotency key');
  });
});

describe('stored records are checked on their way out of a repository', () => {
  // The translation is the point. `validateComment` throws a
  // DomainValidationError, which the route handler maps to a 400 — right for
  // its other callers, all of which validate something supplied from outside,
  // and wrong for a row this service stored (Spec-025).

  it('reports a malformed stored comment as this service fault, not the caller', () => {
    const raised = catchError(() => assertStoredComment({ ...comment, body: '  ' }));

    expect(raised).toBeInstanceOf(StoredRecordInvalidError);
    expect(raised).toMatchObject({
      code: 'INTERNAL_ERROR',
      reason: 'stored_record_invalid',
      statusCode: 500,
      recordKind: 'comment',
      recordId: comment.id,
    });
    expect(raised).not.toBeInstanceOf(DomainValidationError);
  });

  it('catches the historical row-cast defect, where every field reads undefined', () => {
    // `toOperation` cast a snake_case row to a camelCase type. Every field was
    // undefined, every idempotent retry looked like a different request, and
    // the suite stayed green through the whole milestone.
    const cast = {} as ReplyOperation;

    const raised = catchError(() => assertStoredReplyOperation(cast));

    expect(raised).toBeInstanceOf(StoredRecordInvalidError);
    expect(raised).toMatchObject({ recordKind: 'reply_operation', recordId: null });
  });

  it('names the record without carrying its content', () => {
    // The row exists so user content is not stored beside it (ADR-0011); the
    // fault that reports on the row must not undo that.
    const raised = catchError(() =>
      assertStoredComment({ ...comment, publishedAt: '', body: 'a private reply' }),
    );

    expect((raised as Error).message).not.toContain('a private reply');
    expect((raised as Error).message).not.toContain('Ada Lovelace');
    expect((raised as StoredRecordInvalidError).recordId).toBe(comment.id);
  });

  it('passes a well-formed record straight through', () => {
    expect(assertStoredComment(comment)).toBe(comment);
    expect(assertStoredReplyOperation(operation)).toBe(operation);
  });

  it('rejects a reply operation whose status is not one this service knows', () => {
    const raised = catchError(() =>
      assertStoredReplyOperation({ ...operation, status: 'in-flight' as never }),
    );

    expect(raised).toBeInstanceOf(StoredRecordInvalidError);
  });
});

function catchError(run: () => unknown): unknown {
  try {
    run();
    return null;
  } catch (error) {
    return error;
  }
}
