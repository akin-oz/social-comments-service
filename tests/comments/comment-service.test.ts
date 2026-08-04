import { describe, expect, it } from 'vitest';

import { CommentService } from '../../src/comments/comment-service.js';
import {
  AdaptiveProviderAdapter,
  type ProviderClient,
} from '../../src/platforms/adaptive-provider.js';
import { FixtureProviderClient } from '../../src/platforms/fixture-provider.js';
import { InMemoryPlatformProviderRegistry } from '../../src/platforms/provider-registry.js';
import {
  InMemoryCommentRepository,
  InMemoryPostRepository,
  InMemoryReplyOperationRepository,
} from '../../src/repositories/in-memory.js';
import { ProviderRateLimitError, ServiceError } from '../../src/shared/errors.js';
import { internalCommentId } from '../../src/shared/identity.js';
import type { ProviderCapability } from '../../src/comments/contracts.js';
import type { RetryPolicy } from '../../src/shared/observability.js';
import { externalComment, post, tenant } from '../support/fixtures.js';

const immediatePolicy: RetryPolicy = {
  maxAttempts: 1,
  baseDelayMs: 1,
  maxDelayMs: 1,
  timeoutMs: 1_000,
  shouldRetry: () => false,
};

/** Counts provider traffic so cache behaviour is observable in assertions. */
class CountingClient implements ProviderClient {
  public listCalls = 0;
  public replyCalls = 0;

  public constructor(private readonly inner: ProviderClient) {}

  public async listComments(query: Parameters<ProviderClient['listComments']>[0]) {
    this.listCalls += 1;
    return this.inner.listComments(query);
  }

  public async replyToComment(command: Parameters<ProviderClient['replyToComment']>[0]) {
    this.replyCalls += 1;
    return this.inner.replyToComment(command);
  }
}

interface Harness {
  client?: ProviderClient;
  maxPageSize?: number;
  capabilities?: readonly ProviderCapability[];
}

function buildService(options: Harness = {}) {
  const inner =
    options.client ??
    new FixtureProviderClient({
      commentsByPost: new Map([
        [
          post.externalPostId,
          [
            externalComment('ig-comment-1', '2026-08-01T10:00:00.000Z'),
            externalComment('ig-comment-2', '2026-08-01T11:00:00.000Z'),
            externalComment('ig-comment-3', '2026-08-01T12:00:00.000Z'),
          ],
        ],
      ]),
      ...(options.maxPageSize === undefined ? {} : { maxPageSize: options.maxPageSize }),
      now: () => '2026-08-02T12:00:00.000Z',
    });
  const client = new CountingClient(inner);
  const provider = new AdaptiveProviderAdapter(
    post.platform,
    client,
    new Set(options.capabilities ?? ['list_comments', 'reply_to_comment']),
    immediatePolicy,
  );
  const comments = new InMemoryCommentRepository([], tenant.accountId);
  const operations = new InMemoryReplyOperationRepository();
  const service = new CommentService(
    comments,
    new InMemoryPostRepository([post]),
    operations,
    new InMemoryPlatformProviderRegistry(new Map([[post.platform, provider]])),
  );
  return { service, client, comments, operations };
}

describe('listing comments', () => {
  it('hydrates an empty snapshot from the provider', async () => {
    const { service, client } = buildService();

    const result = await service.listComments(tenant, post.id, { limit: 25 });

    expect(result.items.map((item) => item.body)).toEqual([
      'body of ig-comment-1',
      'body of ig-comment-2',
      'body of ig-comment-3',
    ]);
    expect(client.listCalls).toBe(1);
  });

  it('serves a repeated request from the snapshot without calling the provider again', async () => {
    const { service, client } = buildService();

    await service.listComments(tenant, post.id, { limit: 25 });
    const second = await service.listComments(tenant, post.id, { limit: 25 });

    expect(second.items).toHaveLength(3);
    expect(client.listCalls).toBe(1);
  });

  it('pages through a provider that returns fewer comments than requested', async () => {
    const { service, client } = buildService({ maxPageSize: 2 });

    const page1 = await service.listComments(tenant, post.id, { limit: 2 });
    expect(page1.items.map((item) => item.body)).toEqual([
      'body of ig-comment-1',
      'body of ig-comment-2',
    ]);
    expect(page1.pagination.hasMore).toBe(true);

    const cursor = page1.pagination.nextCursor;
    expect(cursor).toEqual(expect.any(String));

    const page2 = await service.listComments(tenant, post.id, {
      limit: 2,
      ...(cursor === null ? {} : { cursor }),
    });
    expect(page2.items.map((item) => item.body)).toEqual(['body of ig-comment-3']);
    expect(page2.pagination).toEqual({ hasMore: false, nextCursor: null });
    expect(client.listCalls).toBe(2);
  });

  it('stops asking the provider once its stream is exhausted', async () => {
    const { service, client } = buildService();

    const first = await service.listComments(tenant, post.id, { limit: 3 });
    expect(first.pagination.hasMore).toBe(false);

    const callsAfterHydration = client.listCalls;
    await service.listComments(tenant, post.id, { limit: 3 });
    expect(client.listCalls).toBe(callsAfterHydration);
  });

  it('rejects a cursor the service did not issue', async () => {
    const { service } = buildService();

    await expect(
      service.listComments(tenant, post.id, { limit: 25, cursor: 'tampered' }),
    ).rejects.toMatchObject({ code: 'INVALID_CURSOR', statusCode: 400 });
  });

  it('reports an unknown post without contacting the provider', async () => {
    const { service, client } = buildService();

    await expect(service.listComments(tenant, 'missing-post', { limit: 25 })).rejects.toMatchObject(
      { code: 'POST_NOT_FOUND', statusCode: 404 },
    );
    expect(client.listCalls).toBe(0);
  });
});

describe('replying to a comment', () => {
  async function withCachedComments(options: Harness = {}) {
    const harness = buildService(options);
    await harness.service.listComments(tenant, post.id, { limit: 25 });
    return { ...harness, parentId: internalCommentId(post.platform, 'ig-comment-1') };
  }

  it('publishes the reply and stores it against the internal post', async () => {
    const { service, parentId } = await withCachedComments();

    const reply = await service.replyToComment(tenant, parentId, 'Thank you!', 'key-1');

    expect(reply).toMatchObject({
      postId: post.id,
      platform: post.platform,
      body: 'Thank you!',
      parentCommentId: parentId,
    });
  });

  it('returns the stored reply on retry without publishing twice', async () => {
    const { service, client, parentId } = await withCachedComments();

    const first = await service.replyToComment(tenant, parentId, 'Thank you!', 'key-1');
    const second = await service.replyToComment(tenant, parentId, 'Thank you!', 'key-1');

    expect(second.id).toBe(first.id);
    expect(client.replyCalls).toBe(1);
  });

  it('refuses to reuse an idempotency key for a different body', async () => {
    const { service, parentId } = await withCachedComments();
    await service.replyToComment(tenant, parentId, 'Thank you!', 'key-1');

    await expect(
      service.replyToComment(tenant, parentId, 'A different reply', 'key-1'),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT', statusCode: 409 });
  });

  it('records the taxonomy code when the provider rate limits the reply', async () => {
    const { service, operations, parentId } = await withCachedComments({
      client: {
        listComments: async () => ({
          items: [externalComment('ig-comment-1', '2026-08-01T10:00:00.000Z')],
          nextCursor: null,
          hasMore: false,
        }),
        replyToComment: async () => {
          throw new ProviderRateLimitError('Too many requests.', 30_000);
        },
      },
    });

    await expect(
      service.replyToComment(tenant, parentId, 'Thank you!', 'key-1'),
    ).rejects.toBeInstanceOf(ProviderRateLimitError);

    await expect(operations.findByIdempotencyKey(tenant, 'key-1')).resolves.toMatchObject({
      status: 'failed',
      failureCode: 'PROVIDER_RATE_LIMITED',
    });
  });

  it('treats a failed key as terminal so an ambiguous publish is never repeated', async () => {
    const { service, parentId } = await withCachedComments({
      client: {
        listComments: async () => ({
          items: [externalComment('ig-comment-1', '2026-08-01T10:00:00.000Z')],
          nextCursor: null,
          hasMore: false,
        }),
        replyToComment: async () => {
          throw new ProviderRateLimitError('Too many requests.', 30_000);
        },
      },
    });
    await expect(service.replyToComment(tenant, parentId, 'Thank you!', 'key-1')).rejects.toThrow();

    await expect(
      service.replyToComment(tenant, parentId, 'Thank you!', 'key-1'),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT', statusCode: 409 });
  });

  it('reports an unknown comment rather than guessing provider coordinates', async () => {
    const { service } = await withCachedComments();

    await expect(
      service.replyToComment(tenant, internalCommentId(post.platform, 'never-seen'), 'Hi', 'key-1'),
    ).rejects.toMatchObject({ code: 'COMMENT_NOT_FOUND', statusCode: 404 });
  });

  it('refuses the write when the provider cannot reply, without consuming the key', async () => {
    const { service, operations, parentId } = await withCachedComments({
      capabilities: ['list_comments'],
    });

    await expect(
      service.replyToComment(tenant, parentId, 'Thank you!', 'key-1'),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_CAPABILITY', statusCode: 422 });
    await expect(operations.findByIdempotencyKey(tenant, 'key-1')).resolves.toBeNull();
  });
});

describe('service error contract', () => {
  it('uses the documented status codes', () => {
    expect(new ServiceError('INVALID_CURSOR', 'bad cursor', 400).statusCode).toBe(400);
  });
});
