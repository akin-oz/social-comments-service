import { describe, expect, it } from 'vitest';

import { AdaptiveProviderAdapter } from '../../src/platforms/adaptive-provider.js';

describe('adaptive provider adapter', () => {
  it('maps provider identifiers and pagination into stable domain contracts', async () => {
    const adapter = new AdaptiveProviderAdapter(
      'instagram',
      {
        listComments: async () => ({
          items: [
            {
              externalId: 'external-comment-1',
              externalPostId: 'post-external-1',
              authorId: 'author-1',
              authorName: 'Ada',
              body: 'Hello',
              publishedAt: '2026-08-01T10:00:00.000Z',
              updatedAt: '2026-08-01T10:00:00.000Z',
            },
          ],
          nextCursor: 'provider-cursor',
          hasMore: true,
        }),
        replyToComment: async () => {
          throw new Error('not used');
        },
      },
      new Set(['list_comments']),
      () => 'post-external-1',
    );

    await expect(
      adapter.listComments({ postId: 'post-1', platform: 'instagram', limit: 10 }),
    ).resolves.toEqual({
      items: [
        expect.objectContaining({
          id: 'instagram:external-comment-1',
          postId: 'post-1',
          parentCommentId: null,
        }),
      ],
      pagination: { nextCursor: 'provider-cursor', hasMore: true },
    });
  });
});
