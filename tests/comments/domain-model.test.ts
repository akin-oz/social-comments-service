import { describe, expect, it } from 'vitest';

import {
  DomainValidationError,
  isPlatform,
  validateComment,
  validateListCommentsQuery,
  validatePagination,
  validateReplyToCommentCommand,
} from '../../src/shared/validation.js';
import type { Comment } from '../../src/shared/types.js';

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
