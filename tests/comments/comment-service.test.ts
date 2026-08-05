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
import {
  ProviderCursorRejectedError,
  ProviderRateLimitError,
  ServiceError,
} from '../../src/shared/errors.js';
import type { ProviderCapability } from '../../src/comments/contracts.js';
import { noopMetrics, providerPolicies, type RetryPolicy } from '../../src/shared/observability.js';
import { externalComment, post, RecordingLogger, tenant } from '../support/fixtures.js';
import type { PublishedPost, RequestContext } from '../../src/shared/types.js';

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
    providerPolicies(immediatePolicy),
  );
  const comments = new InMemoryCommentRepository([], tenant.accountId);
  const operations = new InMemoryReplyOperationRepository();
  const logger = new RecordingLogger();
  const service = new CommentService(
    comments,
    new InMemoryPostRepository([post]),
    operations,
    new InMemoryPlatformProviderRegistry(new Map([[post.platform, provider]])),
    noopMetrics,
    logger,
  );
  return { service, client, comments, operations, logger };
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

  it('reports the same hasMore when a caller restarts pagination', async () => {
    // The reported defect: the first request hydrated one page and advertised
    // more, and an identical second request answered from the snapshot and
    // claimed the post was complete.
    const { service, client } = buildService({ maxPageSize: 2 });

    const first = await service.listComments(tenant, post.id, { limit: 2 });
    const afterFirst = client.listCalls;
    const second = await service.listComments(tenant, post.id, { limit: 2 });

    expect(first.pagination.hasMore).toBe(true);
    expect(second.pagination.hasMore).toBe(true);
    expect(second.items.map((item) => item.id)).toEqual(first.items.map((item) => item.id));
    // Starting a run completes the snapshot (Spec-014 revises Spec-013's
    // one-page-per-request rule), so the second run costs no provider traffic.
    expect(client.listCalls).toBe(afterFirst);
  });

  it('reports no more results once the provider stream is exhausted', async () => {
    const { service, client } = buildService({ maxPageSize: 2 });

    let cursor: string | null = null;
    let pages = 0;
    do {
      const page = await service.listComments(tenant, post.id, {
        limit: 2,
        ...(cursor === null ? {} : { cursor }),
      });
      cursor = page.pagination.nextCursor;
      pages += 1;
    } while (cursor !== null && pages < 10);

    // Having read the post through, a fresh first page must not claim more.
    const callsAfterWalk = client.listCalls;
    const restart = await service.listComments(tenant, post.id, { limit: 50 });

    expect(restart.items).toHaveLength(3);
    expect(restart.pagination.hasMore).toBe(false);
    expect(client.listCalls).toBe(callsAfterWalk);
  });

  it('does not re-ask the provider for a post shorter than the requested limit', async () => {
    const { service, client } = buildService();

    const first = await service.listComments(tenant, post.id, { limit: 25 });
    const second = await service.listComments(tenant, post.id, { limit: 25 });

    expect(first.pagination.hasMore).toBe(false);
    expect(second.pagination.hasMore).toBe(false);
    expect(client.listCalls).toBe(1);
  });

  it('returns every comment when the provider orders newest first', async () => {
    // Provider order is not the service's order. Meta, X, and YouTube return
    // newest first, so later provider pages land behind an ascending keyset.
    // Hydrating one page per request left them unreachable: this saw 2 of 6.
    const newestFirst = [6, 5, 4, 3, 2, 1].map((n) =>
      externalComment(`c${n}`, `2026-08-01T1${n}:00:00.000Z`),
    );
    const { service } = buildService({
      client: new FixtureProviderClient({
        commentsByPost: new Map([[post.externalPostId, newestFirst]]),
        maxPageSize: 2,
      }),
    });

    const seen: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 12; page += 1) {
      const result = await service.listComments(tenant, post.id, {
        limit: 2,
        ...(cursor === null ? {} : { cursor }),
      });
      seen.push(...result.items.map((item) => item.id));
      cursor = result.pagination.nextCursor;
      if (cursor === null) break;
    }

    expect(seen).toHaveLength(6);
    expect(new Set(seen).size).toBe(6);
  });

  it('reports the snapshot it answered from', async () => {
    const { service } = buildService();

    const result = await service.listComments(tenant, post.id, { limit: 25 });

    // Completing the stream records when, so a client can reason about
    // freshness rather than assume it.
    expect(result.snapshot.syncedAt).toEqual(expect.any(String));
  });

  it('reads the provider again once a completed snapshot goes stale', async () => {
    const previous = process.env.SNAPSHOT_LIFETIME_SECONDS;
    process.env.SNAPSHOT_LIFETIME_SECONDS = '0.001';
    try {
      const { service, client } = buildService();
      await service.listComments(tenant, post.id, { limit: 25 });
      const afterFirst = client.listCalls;

      await new Promise((resolve) => setTimeout(resolve, 15));
      await service.listComments(tenant, post.id, { limit: 25 });

      // Exhaustion without a lifetime hides every comment published since.
      expect(client.listCalls).toBeGreaterThan(afterFirst);
    } finally {
      if (previous === undefined) delete process.env.SNAPSHOT_LIFETIME_SECONDS;
      else process.env.SNAPSHOT_LIFETIME_SECONDS = previous;
    }
  });

  it('restarts the stream when the provider rejects a stored cursor', async () => {
    let calls = 0;
    const { service } = buildService({
      client: {
        listComments: async (query) => {
          calls += 1;
          if (query.cursor !== undefined) {
            throw new ProviderCursorRejectedError('that cursor is no longer valid');
          }
          return {
            items: [externalComment('c1', '2026-08-01T10:00:00.000Z')],
            nextCursor: calls === 1 ? 'stale-token' : null,
            hasMore: calls === 1,
          };
        },
        replyToComment: async () => {
          throw new Error('not used');
        },
      },
    });

    const result = await service.listComments(tenant, post.id, { limit: 25 });

    // Replay is safe: re-reading deduplicates on the provider identity.
    expect(result.items).toHaveLength(1);
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
    // Identity is assigned by persistence, so the parent is whatever the read
    // returned rather than a value the test can compute (ADR-0013).
    const listed = await harness.service.listComments(tenant, post.id, { limit: 25 });
    return { ...harness, parentId: listed.items[0]!.id };
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

  it('does not record a published reply as failed when storing it breaks', async () => {
    // The provider published. If storage then fails and the operation is marked
    // failed, the client is told to retry with a new key and publishes twice.
    const { service, operations, comments, parentId } = await withCachedComments();
    comments.upsertMany = async () => {
      throw new Error('database unavailable');
    };

    await expect(service.replyToComment(tenant, parentId, 'Thank you!', 'key-1')).rejects.toThrow();

    const operation = await operations.findByIdempotencyKey(tenant, 'key-1');
    expect(operation?.status).not.toBe('failed');
    expect(operation?.status).toBe('pending');
  });

  it('refuses to reply to a reply, because the model exposes one level', async () => {
    // The reply just published is itself a reply, so it is the natural parent
    // for the case ADR-0014 refuses. Nothing enforced this before: the service
    // would happily build a tree deeper than the contract can express.
    const { service, parentId } = await withCachedComments();
    const reply = await service.replyToComment(tenant, parentId, 'Thank you!', 'key-1');
    expect(reply.parentCommentId).toBe(parentId);

    await expect(
      service.replyToComment(tenant, reply.id, 'And one more thing', 'key-2'),
    ).rejects.toMatchObject({ code: 'REPLY_DEPTH_EXCEEDED', statusCode: 422 });
  });

  it('does not consume the idempotency key when it refuses on depth', async () => {
    const { service, operations, client, parentId } = await withCachedComments();
    const reply = await service.replyToComment(tenant, parentId, 'Thank you!', 'key-1');
    const callsBefore = client.replyCalls;

    await expect(service.replyToComment(tenant, reply.id, 'Deeper', 'key-2')).rejects.toThrow();

    await expect(operations.findByIdempotencyKey(tenant, 'key-2')).resolves.toBeNull();
    expect(client.replyCalls).toBe(callsBefore);
  });

  it('reports an unknown comment rather than guessing provider coordinates', async () => {
    const { service } = await withCachedComments();

    await expect(
      service.replyToComment(tenant, crypto.randomUUID(), 'Hi', 'key-1'),
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

describe('provider authorization context', () => {
  /**
   * Two tenants on one platform, sharing the single adapter instance the
   * registry holds. The connection has to travel with the call, because the
   * adapter cannot know which tenant it is serving (Spec-016).
   */
  function twoTenants() {
    const tenantB: RequestContext = { accountId: 'account-b', requestId: 'req-b' };
    const postB: PublishedPost = {
      id: 'post-b',
      accountId: tenantB.accountId,
      platform: 'instagram',
      externalPostId: 'external-post-b',
      publishedAt: '2026-08-01T09:30:00.000Z',
      connection: {
        socialAccountId: 'social-account-b',
        platform: 'instagram',
        credentialReference: 'secret://social/instagram/tenant-b',
      },
    };
    const client = new FixtureProviderClient({
      commentsByPost: new Map([
        [post.externalPostId, [externalComment('ig-comment-1', '2026-08-01T10:00:00.000Z')]],
        [postB.externalPostId, [externalComment('ig-comment-9', '2026-08-01T10:30:00.000Z')]],
      ]),
      now: () => '2026-08-02T12:00:00.000Z',
    });
    const logger = new RecordingLogger();
    const service = new CommentService(
      new InMemoryCommentRepository([], tenant.accountId),
      new InMemoryPostRepository([post, postB]),
      new InMemoryReplyOperationRepository(),
      new InMemoryPlatformProviderRegistry(
        new Map([
          [
            'instagram',
            new AdaptiveProviderAdapter(
              'instagram',
              client,
              new Set(['list_comments', 'reply_to_comment']),
              providerPolicies(immediatePolicy),
              logger,
            ),
          ],
        ]),
      ),
      noopMetrics,
      logger,
    );
    return { service, client, logger, tenantB, postB };
  }

  it('reaches the provider as the connection the post was published through', async () => {
    const { service, client } = twoTenants();

    await service.listComments(tenant, post.id, { limit: 25 });

    expect(client.connections).toEqual([post.connection]);
  });

  it('gives two tenants on one platform their own connections', async () => {
    const { service, client, tenantB, postB } = twoTenants();

    await service.listComments(tenant, post.id, { limit: 25 });
    await service.listComments(tenantB, postB.id, { limit: 25 });

    expect(client.connections.map((seen) => seen.credentialReference)).toEqual([
      post.connection.credentialReference,
      postB.connection.credentialReference,
    ]);
  });

  it('carries the connection into a reply as well as a read', async () => {
    const { service, client } = twoTenants();
    const listed = await service.listComments(tenant, post.id, { limit: 25 });

    await service.replyToComment(tenant, listed.items[0]!.id, 'Thank you!', 'key-1');

    expect(client.connections.at(-1)).toEqual(post.connection);
  });

  it('never writes a credential reference into the log', async () => {
    const { service, logger, tenantB, postB } = twoTenants();
    await service.listComments(tenant, post.id, { limit: 25 });
    await service.listComments(tenantB, postB.id, { limit: 25 });

    const written = JSON.stringify(logger.records);
    expect(written).not.toContain(post.connection.credentialReference);
    expect(written).not.toContain(postB.connection.credentialReference);
    expect(written).not.toContain('secret://');
  });
});

describe('service error contract', () => {
  it('uses the documented status codes', () => {
    expect(new ServiceError('INVALID_CURSOR', 'bad cursor', 400).statusCode).toBe(400);
  });
});

describe('observability', () => {
  it('distinguishes a provider fetch from a snapshot hit', async () => {
    const { service, logger } = buildService();

    await service.listComments(tenant, post.id, { limit: 25 });
    await service.listComments(tenant, post.id, { limit: 25 });

    expect(logger.events()).toContain('comments.list.hydrated');
    expect(logger.events()).toContain('comments.list.served_from_cache');
    expect(logger.find('provider.list.completed')?.fields).toMatchObject({
      platform: post.platform,
      fetched: 3,
    });
  });

  it('correlates records to the request that caused them', async () => {
    const { service, logger } = buildService();

    await service.listComments(tenant, post.id, { limit: 25 });

    for (const record of logger.records) {
      expect(record.fields).toMatchObject({
        requestId: tenant.requestId,
        accountId: tenant.accountId,
      });
    }
  });

  it('records a published reply and its replay separately', async () => {
    const { service, logger } = buildService();
    const listed = await service.listComments(tenant, post.id, { limit: 25 });
    const parentId = listed.items[0]!.id;

    await service.replyToComment(tenant, parentId, 'Thank you!', 'key-1');
    await service.replyToComment(tenant, parentId, 'Thank you!', 'key-1');

    expect(logger.events().filter((event) => event === 'comments.reply.published')).toHaveLength(1);
    expect(logger.events()).toContain('comments.reply.replayed');
  });

  it('never writes comment bodies or author names into the log', async () => {
    const { service, logger } = buildService();
    const listed = await service.listComments(tenant, post.id, { limit: 25 });
    const parentId = listed.items[0]!.id;
    await service.replyToComment(tenant, parentId, 'a secret reply body', 'key-1');

    const serialized = JSON.stringify(logger.records);
    expect(serialized).not.toContain('a secret reply body');
    expect(serialized).not.toContain('Ada Lovelace');
    expect(logger.find('comments.reply.published')?.fields).toMatchObject({ bodyLength: 19 });
  });

  it('reports a failure with its taxonomy code at warn, not error', async () => {
    const { service, logger } = buildService({
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
    const listed = await service.listComments(tenant, post.id, { limit: 25 });
    const parentId = listed.items[0]!.id;

    await expect(service.replyToComment(tenant, parentId, 'hi', 'key-1')).rejects.toThrow();

    const failure = logger.find('comments.reply.failed');
    expect(failure?.level).toBe('warn');
    expect(failure?.fields).toMatchObject({ code: 'PROVIDER_RATE_LIMITED' });
  });
});
