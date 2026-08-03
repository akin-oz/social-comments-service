import { describe, expect, it } from 'vitest';

import { createApplication } from '../../src/index.js';
import {
  InMemoryCommentRepository,
  InMemoryPostRepository,
} from '../../src/repositories/in-memory.js';
import type { AdaptiveProvider } from '../../src/comments/contracts.js';
import type { Comment, PublishedPost } from '../../src/shared/types.js';

const post: PublishedPost = {
  id: 'post-1',
  accountId: 'account-1',
  platform: 'instagram',
  externalPostId: 'external-post-1',
  publishedAt: '2026-08-01T10:00:00.000Z',
};
const sourceComment: Comment = {
  id: 'comment-1',
  postId: post.id,
  platform: post.platform,
  author: { id: 'author-1', displayName: 'Ada' },
  body: 'Hello',
  parentCommentId: null,
  publishedAt: '2026-08-01T10:00:00.000Z',
  updatedAt: '2026-08-01T10:00:00.000Z',
};

function provider(): AdaptiveProvider {
  return {
    platform: 'instagram',
    capabilities: new Set(['reply_to_comment']),
    listComments: async () => ({ items: [], pagination: { nextCursor: null, hasMore: false } }),
    replyToComment: async (command) => ({
      ...sourceComment,
      id: 'reply-1',
      body: command.body,
      parentCommentId: command.commentId,
    }),
  };
}

describe('comment REST API', () => {
  it('lists comments with an opaque pagination envelope', async () => {
    const app = createApplication({
      comments: new InMemoryCommentRepository([sourceComment]),
      posts: new InMemoryPostRepository([post]),
    });
    const response = await app.inject({
      method: 'GET',
      url: '/v2/posts/post-1/comments?limit=10',
      headers: { 'x-account-id': 'account-1' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ data: [{ id: 'comment-1' }] });
    await app.close();
  });

  it('requires authentication and idempotency for replies', async () => {
    const app = createApplication({
      comments: new InMemoryCommentRepository([sourceComment]),
      posts: new InMemoryPostRepository([post]),
      providers: new Map([['instagram', provider()]]),
    });
    await expect(
      app.inject({ method: 'GET', url: '/v2/posts/post-1/comments' }),
    ).resolves.toMatchObject({
      statusCode: 401,
    });
    const response = await app.inject({
      method: 'POST',
      url: '/v2/comments/comment-1/replies',
      headers: { 'x-account-id': 'account-1' },
      payload: { body: 'Thanks!' },
    });
    expect(response.statusCode).toBe(400);
    await app.close();
  });

  it('does not publish duplicate replies for an idempotent retry', async () => {
    let calls = 0;
    const configuredProvider = provider();
    const originalReply = configuredProvider.replyToComment;
    configuredProvider.replyToComment = async (command) => {
      calls += 1;
      return originalReply(command);
    };
    const app = createApplication({
      comments: new InMemoryCommentRepository([sourceComment]),
      posts: new InMemoryPostRepository([post]),
      providers: new Map([['instagram', configuredProvider]]),
    });
    const request = {
      method: 'POST' as const,
      url: '/v2/comments/comment-1/replies',
      headers: { 'x-account-id': 'account-1', 'idempotency-key': 'request-1' },
      payload: { body: 'Thanks!' },
    };
    await expect(app.inject(request)).resolves.toMatchObject({ statusCode: 201 });
    await expect(app.inject(request)).resolves.toMatchObject({ statusCode: 201 });
    expect(calls).toBe(1);
    await app.close();
  });
});
