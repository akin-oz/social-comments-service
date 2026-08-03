import { describe, expect, it } from 'vitest';

import {
  InMemoryCommentRepository,
  InMemoryPostRepository,
  InMemoryReplyOperationRepository,
} from '../../src/repositories/in-memory.js';
import type { Comment, PublishedPost } from '../../src/shared/types.js';

const context = { accountId: 'account-1' };
const post: PublishedPost = {
  id: 'post-1',
  accountId: 'account-1',
  platform: 'instagram',
  externalPostId: 'external-post-1',
  publishedAt: '2026-08-01T10:00:00.000Z',
};
const comment = (id: string): Comment => ({
  id,
  postId: post.id,
  platform: post.platform,
  author: { id: `author-${id}`, displayName: 'Ada' },
  body: id,
  parentCommentId: null,
  publishedAt: `2026-08-01T10:00:0${id.slice(-1)}.000Z`,
  updatedAt: '2026-08-01T10:00:00.000Z',
});

describe('in-memory repository contracts', () => {
  it('scopes post and comment reads to the tenant and uses deterministic cursors', async () => {
    const comments = new InMemoryCommentRepository([comment('comment-1'), comment('comment-2')]);
    const posts = new InMemoryPostRepository([post]);

    await expect(posts.findPublishedById({ accountId: 'other' }, post.id)).resolves.toBeNull();
    await expect(
      comments.listByPost(context, { postId: post.id, platform: post.platform, limit: 1 }),
    ).resolves.toMatchObject({
      items: [expect.objectContaining({ id: 'comment-1' })],
      pagination: { hasMore: true, nextCursor: expect.any(String) },
    });
    await expect(
      comments.listByPost(
        { accountId: 'other' },
        { postId: post.id, platform: post.platform, limit: 10 },
      ),
    ).resolves.toMatchObject({ items: [] });
  });

  it('deduplicates reply operations by account and idempotency key', async () => {
    const operations = new InMemoryReplyOperationRepository();
    const input = {
      id: 'operation-1',
      commentId: 'comment-1',
      idempotencyKey: 'request-1',
      requestFingerprint: 'comment-1:reply',
      status: 'pending' as const,
      resultingCommentId: null,
      failureCode: null,
      createdAt: '2026-08-01T10:00:00.000Z',
      completedAt: null,
    };
    await operations.createPending(context, input);
    await expect(
      operations.createPending(context, { ...input, id: 'operation-2' }),
    ).resolves.toMatchObject({
      id: 'operation-1',
    });
    await expect(
      operations.findByIdempotencyKey({ accountId: 'other' }, 'request-1'),
    ).resolves.toBeNull();
  });
});
