import { describe, expect, it } from 'vitest';

import {
  InMemoryCommentRepository,
  InMemoryPostRepository,
  InMemoryReplyOperationRepository,
} from '../../src/repositories/in-memory.js';
import { observedComment, otherTenant, post, tenant } from '../support/fixtures.js';

const first = observedComment('ig-comment-1', '2026-08-01T10:00:00.000Z');
const second = observedComment('ig-comment-2', '2026-08-01T11:00:00.000Z');
const third = observedComment('ig-comment-3', '2026-08-01T12:00:00.000Z');

function repository() {
  return new InMemoryCommentRepository([first, second, third], tenant.accountId);
}

/** Identities are assigned, so tests read them back rather than computing them. */
async function storedIds(comments: InMemoryCommentRepository): Promise<string[]> {
  const page = await comments.listByPost(tenant, { ...listQuery, limit: 50 });
  return page.items.map((item) => item.id);
}

const listQuery = { postId: post.id, platform: post.platform } as const;

describe('in-memory comment repository', () => {
  it('scopes reads to the tenant', async () => {
    const comments = repository();
    const posts = new InMemoryPostRepository([post]);

    await expect(posts.findPublishedById(otherTenant, post.id)).resolves.toBeNull();
    await expect(comments.listByPost(otherTenant, { ...listQuery, limit: 10 })).resolves.toEqual({
      items: [],
      hasMore: false,
    });
  });

  it('walks pages in keyset order without repeating or skipping', async () => {
    const comments = repository();

    const all = await storedIds(comments);

    const page1 = await comments.listByPost(tenant, { ...listQuery, limit: 2 });
    expect(page1.items.map((item) => item.id)).toEqual(all.slice(0, 2));
    expect(page1.hasMore).toBe(true);

    const last = page1.items[1]!;
    const page2 = await comments.listByPost(tenant, {
      ...listQuery,
      limit: 2,
      after: { publishedAt: last.publishedAt, id: last.id },
    });
    expect(page2.items.map((item) => item.id)).toEqual(all.slice(2));
    expect(page2.hasMore).toBe(false);
  });

  it('keeps an issued position stable when an earlier comment arrives later', async () => {
    const comments = repository();
    const all = await storedIds(comments);
    const firstStored = (await comments.listByPost(tenant, { ...listQuery, limit: 1 })).items[0]!;
    const after = { publishedAt: firstStored.publishedAt, id: firstStored.id };

    // An offset cursor would shift here; a keyset cursor must not.
    await comments.upsertMany(tenant, [
      observedComment('ig-comment-0', '2026-08-01T09:00:00.000Z'),
    ]);

    const page = await comments.listByPost(tenant, { ...listQuery, limit: 10, after });
    expect(page.items.map((item) => item.id)).toEqual(all.slice(1));
  });

  it('deduplicates a provider comment observed twice', async () => {
    const comments = repository();

    await comments.upsertMany(tenant, [
      observedComment('ig-comment-1', '2026-08-01T10:00:00.000Z'),
    ]);

    const page = await comments.listByPost(tenant, { ...listQuery, limit: 10 });
    expect(page.items).toHaveLength(3);
  });

  it('resolves the provider identifier for a stored comment', async () => {
    const comments = repository();

    const firstStored = (await comments.listByPost(tenant, { ...listQuery, limit: 1 })).items[0]!;

    await expect(comments.resolveExternalId(tenant, firstStored.id)).resolves.toBe('ig-comment-1');
    await expect(comments.resolveExternalId(otherTenant, firstStored.id)).resolves.toBeNull();
  });
});

describe('in-memory reply operation repository', () => {
  const operation = {
    id: 'operation-1',
    commentId: crypto.randomUUID(),
    idempotencyKey: 'request-1',
    requestFingerprint: 'fingerprint:reply',
    status: 'pending' as const,
    resultingCommentId: null,
    failureCode: null,
    createdAt: '2026-08-01T10:00:00.000Z',
    completedAt: null,
  };

  it('grants the key to exactly one caller', async () => {
    const operations = new InMemoryReplyOperationRepository();

    await expect(operations.claim(tenant, operation)).resolves.toMatchObject({
      claimed: true,
      operation: { id: 'operation-1' },
    });
    await expect(
      operations.claim(tenant, { ...operation, id: 'operation-2' }),
    ).resolves.toMatchObject({ claimed: false, operation: { id: 'operation-1' } });
  });

  it('grants a key to exactly one of two concurrent callers', async () => {
    // The claim previously scanned for the key behind an await, so both callers
    // passed the check and both were granted it. This asserted two before.
    const operations = new InMemoryReplyOperationRepository();

    const [first, second] = await Promise.all([
      operations.claim(tenant, { ...operation, id: crypto.randomUUID() }),
      operations.claim(tenant, { ...operation, id: crypto.randomUUID() }),
    ]);

    expect([first.claimed, second.claimed].filter(Boolean)).toHaveLength(1);
    expect(first.operation.id).toBe(second.operation.id);
  });

  it('scopes idempotency keys to the tenant', async () => {
    const operations = new InMemoryReplyOperationRepository();
    await operations.claim(tenant, operation);

    await expect(operations.findByIdempotencyKey(otherTenant, 'request-1')).resolves.toBeNull();
    await expect(operations.claim(otherTenant, operation)).resolves.toMatchObject({
      claimed: true,
    });
  });

  it('records terminal outcomes with a completion timestamp', async () => {
    const operations = new InMemoryReplyOperationRepository();
    await operations.claim(tenant, operation);

    await expect(operations.complete(tenant, 'operation-1', 'comment-9')).resolves.toMatchObject({
      status: 'completed',
      resultingCommentId: 'comment-9',
      completedAt: expect.any(String),
    });
    await expect(
      operations.fail(tenant, 'operation-1', 'PROVIDER_RATE_LIMITED'),
    ).resolves.toMatchObject({ status: 'failed', failureCode: 'PROVIDER_RATE_LIMITED' });
  });
});
