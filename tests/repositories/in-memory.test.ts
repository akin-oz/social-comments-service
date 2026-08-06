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

  it('cannot match across the key delimiter one tenant identifier ends with', async () => {
    // The adapter used to flatten (accountId, id) into `accountId:id` and scope
    // reads with startsWith. An account identifier that is a prefix of another
    // one, delimiter and all, then matched its rows. There is no database
    // policy behind this composition, so the structure has to be the boundary
    // (Spec-018).
    const outer = { accountId: 'account-1', requestId: 'req-outer' };
    const inner = { accountId: 'account-1:nested', requestId: 'req-inner' };
    const comments = new InMemoryCommentRepository();

    await comments.upsertMany(outer, [first]);
    await comments.upsertMany(inner, [second]);

    const outerPage = await comments.listByPost(outer, { ...listQuery, limit: 50 });
    const innerPage = await comments.listByPost(inner, { ...listQuery, limit: 50 });

    expect(outerPage.items.map((item) => item.body)).toEqual([`body of ${first.externalId}`]);
    expect(innerPage.items.map((item) => item.body)).toEqual([`body of ${second.externalId}`]);
  });

  it('scopes idempotency keys across the delimiter too', async () => {
    const outer = { accountId: 'account-1' };
    const inner = { accountId: 'account-1:nested' };
    const operations = new InMemoryReplyOperationRepository();
    const claim = {
      id: crypto.randomUUID(),
      commentId: 'comment-1',
      idempotencyKey: 'shared-key',
      requestFingerprint: 'fingerprint',
      status: 'pending' as const,
      leaseExpiresAt: '2026-08-01T10:02:00.000Z',
      externalReplyId: null,
      resultingCommentId: null,
      failureCode: null,
      createdAt: '2026-08-01T10:00:00.000Z',
      completedAt: null,
    };

    await operations.claim(outer, claim);
    const other = await operations.claim(inner, { ...claim, id: crypto.randomUUID() });

    expect(other.claimed).toBe(true);
    await expect(operations.findByIdempotencyKey(inner, 'shared-key')).resolves.toMatchObject({
      accountId: inner.accountId,
    });
  });

  it('breaks a keyset tie on id when comments share a timestamp', async () => {
    // Replacing the id branch of compareKeyset with `return 0` left the suite
    // green, because no fixture held two comments at one timestamp. Paging in
    // ones through a tie must still reach every comment exactly once (Spec-020).
    const tie = '2026-08-01T20:30:00.000Z';
    const comments = new InMemoryCommentRepository(
      [observedComment('tie-a', tie), observedComment('tie-b', tie), observedComment('tie-c', tie)],
      tenant.accountId,
    );

    const ids = await storedIds(comments);
    expect(ids).toHaveLength(3);

    const walked: string[] = [];
    let after: { publishedAt: string; id: string } | undefined;
    for (let guard = 0; guard < 10; guard += 1) {
      const page = await comments.listByPost(tenant, {
        ...listQuery,
        limit: 1,
        ...(after === undefined ? {} : { after }),
      });
      walked.push(...page.items.map((item) => item.id));
      const last = page.items[page.items.length - 1];
      if (!page.hasMore || last === undefined) break;
      after = { publishedAt: last.publishedAt, id: last.id };
    }

    expect([...walked].sort()).toEqual([...ids].sort());
  });

  it('does not resolve a reply that lives on a different post than its sibling', async () => {
    // The SQL twin of this guard has a killing test; the in-memory one did not.
    // The post stands in for the connection here (one post, one connection), so
    // a reply identifier that resolves to a row on another post must not be
    // returned for this sibling — deleting the postId half of the guard let it
    // through (Spec-024).
    const comments = new InMemoryCommentRepository([], tenant.accountId);
    const [siblingOnPostA] = await comments.upsertMany(tenant, [
      { ...observedComment('sibling-a', '2026-08-01T10:00:00.000Z') },
    ]);
    await comments.upsertMany(tenant, [
      { ...observedComment('reply-on-post-b', '2026-08-01T11:05:00.000Z'), postId: 'post-2' },
    ]);

    // The reply row exists, but it is on post-2 while the sibling is on post.id.
    const resolved = await comments.findReplyByExternalId(
      tenant,
      siblingOnPostA!.id,
      'reply-on-post-b',
    );
    expect(resolved).toBeNull();

    // A reply on the sibling's own post does resolve.
    await comments.upsertMany(tenant, [
      { ...observedComment('reply-on-post-a', '2026-08-01T10:30:00.000Z') },
    ]);
    const onSamePost = await comments.findReplyByExternalId(
      tenant,
      siblingOnPostA!.id,
      'reply-on-post-a',
    );
    expect(onSamePost?.postId).toBe(post.id);
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
    leaseExpiresAt: '2026-08-01T10:02:00.000Z',
    externalReplyId: null,
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

  it('lets only the first recoverer resolve an abandoned operation', async () => {
    // The SQL twin of this guard has a killing test, the in-memory one did not,
    // and 36 of 167 tests skip without a database — so the adapter presented as
    // a first-class alternative could drift from the lifecycle contract and
    // nobody running `pnpm test` would know (Spec-020).
    const operations = new InMemoryReplyOperationRepository();
    await operations.claim(tenant, operation);

    const first = await operations.markUnknown(tenant, operation.id, 'REPLY_OUTCOME_UNKNOWN');
    const second = await operations.markUnknown(tenant, operation.id, 'REPLY_OUTCOME_UNKNOWN');

    expect(first).toMatchObject({ status: 'unknown', failureCode: 'REPLY_OUTCOME_UNKNOWN' });
    expect(second).toBeNull();
  });

  it('refuses to mark a completed operation unknown', async () => {
    const operations = new InMemoryReplyOperationRepository();
    await operations.claim(tenant, operation);
    await operations.complete(tenant, operation.id, crypto.randomUUID());

    await expect(
      operations.markUnknown(tenant, operation.id, 'REPLY_OUTCOME_UNKNOWN'),
    ).resolves.toBeNull();
    await expect(
      operations.findByIdempotencyKey(tenant, operation.idempotencyKey),
    ).resolves.toMatchObject({ status: 'completed' });
  });

  it('records the provider reply identifier without resolving the operation', async () => {
    const operations = new InMemoryReplyOperationRepository();
    await operations.claim(tenant, operation);

    const recorded = await operations.recordPublished(tenant, operation.id, 'ig-reply-7');

    expect(recorded).toMatchObject({ externalReplyId: 'ig-reply-7', status: 'pending' });
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
