import { internalCommentId } from '../../src/shared/identity.js';
import type { ExternalCommentRecord } from '../../src/platforms/adaptive-provider.js';
import type { NormalizedComment, PublishedPost, TenantContext } from '../../src/shared/types.js';

export const tenant: TenantContext = { accountId: 'account-1' };
export const otherTenant: TenantContext = { accountId: 'account-2' };

export const post: PublishedPost = {
  id: 'post-1',
  accountId: tenant.accountId,
  platform: 'instagram',
  externalPostId: 'external-post-1',
  publishedAt: '2026-08-01T09:00:00.000Z',
};

export function externalComment(externalId: string, publishedAt: string): ExternalCommentRecord {
  return {
    externalId,
    authorId: `author-${externalId}`,
    authorName: 'Ada Lovelace',
    body: `body of ${externalId}`,
    publishedAt,
    updatedAt: publishedAt,
  };
}

/** Builds the persisted form of a provider comment, mirroring adapter output. */
export function normalizedComment(externalId: string, publishedAt: string): NormalizedComment {
  return {
    comment: {
      id: internalCommentId(post.platform, externalId),
      postId: post.id,
      platform: post.platform,
      author: { id: `author-${externalId}`, displayName: 'Ada Lovelace' },
      body: `body of ${externalId}`,
      parentCommentId: null,
      publishedAt,
      updatedAt: publishedAt,
    },
    externalId,
    externalParentCommentId: null,
  };
}
