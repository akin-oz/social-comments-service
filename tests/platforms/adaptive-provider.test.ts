import { describe, expect, it } from 'vitest';

import { AdaptiveProviderAdapter } from '../../src/platforms/adaptive-provider.js';
import { FixtureProviderClient } from '../../src/platforms/fixture-provider.js';
import { ProviderError, ProviderUnavailableError } from '../../src/shared/errors.js';
import { providerPolicies, providerRetryPolicy } from '../../src/shared/observability.js';
import { externalComment, post } from '../support/fixtures.js';

function adapter(client: ConstructorParameters<typeof AdaptiveProviderAdapter>[1]) {
  return new AdaptiveProviderAdapter(
    'instagram',
    client,
    new Set(['list_comments', 'reply_to_comment']),
  );
}

function fixtureAdapter(comments: ReturnType<typeof externalComment>[]) {
  return adapter(
    new FixtureProviderClient({
      commentsByPost: new Map([[post.externalPostId, comments]]),
      now: () => '2026-08-02T12:00:00.000Z',
    }),
  );
}

describe('adaptive provider adapter', () => {
  it('maps provider records onto internal identities and the internal post', async () => {
    const provider = fixtureAdapter([externalComment('ig-comment-1', '2026-08-01T10:00:00.000Z')]);

    const page = await provider.listComments({ post, limit: 10 });

    expect(page).toEqual({
      items: [
        expect.objectContaining({
          postId: post.id,
          platform: 'instagram',
          externalId: 'ig-comment-1',
          externalParentCommentId: null,
        }),
      ],
      nextProviderCursor: null,
      hasMore: false,
    });
  });

  it('sends the provider its own post identifier, never the internal one', async () => {
    const seen: string[] = [];
    const provider = adapter({
      listComments: async (query) => {
        seen.push(query.externalPostId);
        return { items: [], nextCursor: null, hasMore: false };
      },
      replyToComment: async () => {
        throw new Error('not used');
      },
    });

    await provider.listComments({ post, limit: 10 });

    expect(seen).toEqual([post.externalPostId]);
  });

  it('replies against the provider identifier and links the stored parent', async () => {
    const seen: { externalCommentId: string; externalPostId: string }[] = [];
    const provider = adapter({
      listComments: async () => ({ items: [], nextCursor: null, hasMore: false }),
      replyToComment: async (command) => {
        seen.push({
          externalCommentId: command.externalCommentId,
          externalPostId: command.externalPostId,
        });
        return {
          externalId: 'ig-reply-1',
          authorId: 'account-author',
          authorName: 'Blotato',
          body: command.body,
          publishedAt: '2026-08-02T12:00:00.000Z',
          updatedAt: '2026-08-02T12:00:00.000Z',
        };
      },
    });

    const reply = await provider.replyToComment({
      post,
      parentExternalCommentId: 'ig-comment-1',
      body: 'Thank you!',
    });

    expect(seen).toEqual([
      { externalCommentId: 'ig-comment-1', externalPostId: post.externalPostId },
    ]);
    // The provider omitted the parent, so the adapter restores it from the request.
    expect(reply.externalParentCommentId).toBe('ig-comment-1');
    expect(reply.externalId).toBe('ig-reply-1');
    // The adapter assigns no identity; persistence does (ADR-0013).
    expect(reply).not.toHaveProperty('id');
  });

  it('carries the provider continuation token through the page contract', async () => {
    const provider = fixtureAdapter([
      externalComment('ig-comment-1', '2026-08-01T10:00:00.000Z'),
      externalComment('ig-comment-2', '2026-08-01T11:00:00.000Z'),
    ]);

    const page = await provider.listComments({ post, limit: 1 });

    expect(page.hasMore).toBe(true);
    expect(page.nextProviderCursor).toEqual(expect.any(String));
  });

  it('never republishes a reply whose outcome is unknown', async () => {
    // A timeout does not prove the provider rejected the request. Replaying it
    // publishes a second reply under someone else's name — the duplication the
    // idempotency design exists to prevent. Against a shared retry policy this
    // asserted 3.
    let published = 0;
    const provider = new AdaptiveProviderAdapter(
      'instagram',
      {
        listComments: async () => ({ items: [], nextCursor: null, hasMore: false }),
        replyToComment: async (command) => {
          published += 1;
          // Accepted and published, but slower than the call budget.
          await new Promise((resolve) => setTimeout(resolve, 60));
          return {
            externalId: `published-${published}`,
            authorId: 'account-author',
            authorName: 'Blotato',
            body: command.body,
            publishedAt: '2026-08-02T12:00:00.000Z',
            updatedAt: '2026-08-02T12:00:00.000Z',
          };
        },
      },
      new Set(['reply_to_comment']),
      providerPolicies({ ...providerRetryPolicy, timeoutMs: 10, baseDelayMs: 1, maxDelayMs: 2 }),
    );

    await expect(
      provider.replyToComment({ post, parentExternalCommentId: 'ig-comment-1', body: 'Thanks!' }),
    ).rejects.toBeInstanceOf(ProviderUnavailableError);

    expect(published).toBe(1);
  });

  it('still retries a read, because refetching a page is safe', async () => {
    let attempts = 0;
    const provider = new AdaptiveProviderAdapter(
      'instagram',
      {
        listComments: async () => {
          attempts += 1;
          if (attempts === 1) throw new ProviderUnavailableError('temporarily down');
          return { items: [], nextCursor: null, hasMore: false };
        },
        replyToComment: async () => {
          throw new Error('not used');
        },
      },
      new Set(['list_comments']),
      providerPolicies({ ...providerRetryPolicy, timeoutMs: 500, baseDelayMs: 1, maxDelayMs: 2 }),
    );

    await expect(provider.listComments({ post, limit: 10 })).resolves.toMatchObject({ items: [] });
    expect(attempts).toBe(2);
  });

  it('rejects a provider page that claims more results without a cursor', async () => {
    const provider = adapter({
      listComments: async () => ({ items: [], nextCursor: null, hasMore: true }),
      replyToComment: async () => {
        throw new Error('not used');
      },
    });

    await expect(provider.listComments({ post, limit: 10 })).rejects.toBeInstanceOf(ProviderError);
  });
});
