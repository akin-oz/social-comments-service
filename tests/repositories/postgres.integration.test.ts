import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PostgresDatabase } from '../../src/repositories/database.js';
import {
  PostgresCommentRepository,
  PostgresPostRepository,
  PostgresReplyOperationRepository,
} from '../../src/repositories/postgres.js';
import { internalCommentId } from '../../src/shared/identity.js';
import { seedTenants } from '../../src/seed-data.js';
import type { NormalizedComment, TenantContext } from '../../src/shared/types.js';
import type { CommentPage } from '../../src/comments/contracts.js';

/**
 * Runs against a real database, because the behaviour under test — row-level
 * security — cannot be observed anywhere else. Skipped without APP_DATABASE_URL
 * so the default suite stays fast and needs no Docker (Spec-012).
 */
const appUrl = process.env.APP_DATABASE_URL;
const ownerUrl = process.env.DATABASE_URL;
const enabled = appUrl !== undefined && ownerUrl !== undefined;

const tenantA = seedTenants[0]!;
const tenantB = seedTenants[1]!;
const contextA: TenantContext = { accountId: tenantA.accountId };
const contextB: TenantContext = { accountId: tenantB.accountId };

function comment(
  tenant: typeof tenantA,
  externalId: string,
  publishedAt: string,
): NormalizedComment {
  return {
    comment: {
      id: internalCommentId(tenant.platform, externalId),
      postId: tenant.postId,
      platform: tenant.platform,
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

describe.skipIf(!enabled)('PostgreSQL persistence and tenant isolation', () => {
  let database: PostgresDatabase;
  let comments: PostgresCommentRepository;
  let posts: PostgresPostRepository;
  let operations: PostgresReplyOperationRepository;

  beforeAll(async () => {
    database = new PostgresDatabase(appUrl!);
    comments = new PostgresCommentRepository(database);
    posts = new PostgresPostRepository(database);
    operations = new PostgresReplyOperationRepository(database);

    await comments.upsertMany(contextA, [
      comment(tenantA, 'a-comment-1', '2026-08-01T10:00:00.000Z'),
      comment(tenantA, 'a-comment-2', '2026-08-01T11:00:00.000Z'),
      comment(tenantA, 'a-comment-3', '2026-08-01T12:00:00.000Z'),
    ]);
    await comments.upsertMany(contextB, [
      comment(tenantB, 'b-comment-1', '2026-08-01T10:30:00.000Z'),
    ]);
  });

  afterAll(async () => {
    await database?.close();
  });

  it('connects as a role that does not own the tables', async () => {
    // If the service connected as the owner, PostgreSQL would exempt it from
    // every policy and the isolation tests below would pass for the wrong reason.
    const result = await database.withTenant(tenantA.accountId, (tx) =>
      tx.query<{ current_user: string; owner: string }>(
        `select current_user, (select tableowner from pg_tables where tablename = 'comments') as owner`,
      ),
    );
    const row = result.rows[0]!;
    expect(row.current_user).toBe('comments_app');
    expect(row.current_user).not.toBe(row.owner);
  });

  it('resolves a published post for its own tenant only', async () => {
    await expect(posts.findPublishedById(contextA, tenantA.postId)).resolves.toMatchObject({
      post: { id: tenantA.postId, externalPostId: tenantA.externalPostId },
      snapshot: { exhausted: expect.any(Boolean) },
    });
    await expect(posts.findPublishedById(contextA, tenantB.postId)).resolves.toBeNull();
  });

  it('round-trips the snapshot state a read depends on', async () => {
    await posts.saveSnapshotState(contextA, tenantA.postId, {
      providerCursor: 'provider-page-2',
      exhausted: false,
    });
    await expect(posts.findPublishedById(contextA, tenantA.postId)).resolves.toMatchObject({
      snapshot: { providerCursor: 'provider-page-2', exhausted: false },
    });

    await posts.saveSnapshotState(contextA, tenantA.postId, {
      providerCursor: null,
      exhausted: true,
    });
    await expect(posts.findPublishedById(contextA, tenantA.postId)).resolves.toMatchObject({
      snapshot: { providerCursor: null, exhausted: true },
    });
  });

  it('cannot advance another tenant snapshot state', async () => {
    const before = await posts.findPublishedById(contextB, tenantB.postId);
    // Row-level security makes this update match nothing rather than fail loudly.
    await posts.saveSnapshotState(contextA, tenantB.postId, {
      providerCursor: 'forged',
      exhausted: true,
    });
    const after = await posts.findPublishedById(contextB, tenantB.postId);

    expect(after?.snapshot).toEqual(before?.snapshot);
  });

  it('returns comments in keyset order and pages without repeating', async () => {
    const query = { postId: tenantA.postId, platform: tenantA.platform } as const;

    // Expectations come from the data actually present, so the test holds
    // against a database that already carries rows from earlier runs.
    const everything = await comments.listByPost(contextA, { ...query, limit: 500 });
    expect(everything.items.length).toBeGreaterThan(2);
    expect(everything.hasMore).toBe(false);

    const walked: string[] = [];
    let after: { publishedAt: string; id: string } | undefined;
    for (;;) {
      const page: CommentPage = await comments.listByPost(contextA, {
        ...query,
        limit: 2,
        ...(after === undefined ? {} : { after }),
      });
      walked.push(...page.items.map((item) => item.id));
      const last = page.items[page.items.length - 1];
      if (!page.hasMore || last === undefined) break;
      after = { publishedAt: last.publishedAt, id: last.id };
    }

    // Paging in twos must reproduce the full ordering exactly: no repeats, no gaps.
    expect(walked).toEqual(everything.items.map((item) => item.id));
    expect(new Set(walked).size).toBe(walked.length);
  });

  it('deduplicates a provider comment observed twice', async () => {
    const before = await comments.listByPost(contextA, {
      postId: tenantA.postId,
      platform: tenantA.platform,
      limit: 50,
    });
    await comments.upsertMany(contextA, [
      comment(tenantA, 'a-comment-1', '2026-08-01T10:00:00.000Z'),
    ]);
    const after = await comments.listByPost(contextA, {
      postId: tenantA.postId,
      platform: tenantA.platform,
      limit: 50,
    });

    expect(after.items).toHaveLength(before.items.length);
  });

  it('hides another tenant comments from the repository', async () => {
    const page = await comments.listByPost(contextA, {
      postId: tenantB.postId,
      platform: tenantB.platform,
      limit: 50,
    });
    expect(page.items).toEqual([]);

    const foreign = internalCommentId(tenantB.platform, 'b-comment-1');
    await expect(comments.findById(contextA, foreign)).resolves.toBeNull();
    await expect(comments.resolveExternalId(contextA, foreign)).resolves.toBeNull();
  });

  it('hides another tenant rows even without an account predicate', async () => {
    // The repository predicates are removed here on purpose. Only row-level
    // security can produce an empty result, so this is what distinguishes
    // working RLS from predicates that merely look like isolation.
    const rows = await database.withTenant(tenantA.accountId, async (tx) => {
      const comments = await tx.query<{ count: string }>(
        `select count(*)::text as count from comments where post_id = $1`,
        [tenantB.postId],
      );
      const posts = await tx.query<{ count: string }>(
        `select count(*)::text as count from posts where id = $1`,
        [tenantB.postId],
      );
      return { comments: comments.rows[0]!.count, posts: posts.rows[0]!.count };
    });

    expect(rows).toEqual({ comments: '0', posts: '0' });
  });

  it('refuses to write a row belonging to another tenant', async () => {
    // The WITH CHECK half of the policy: tenant A cannot insert into B's post.
    await expect(
      comments.upsertMany(contextA, [
        comment(tenantB, 'a-forged-comment', '2026-08-01T13:00:00.000Z'),
      ]),
    ).rejects.toThrow();
  });

  it('grants an idempotency key to exactly one caller', async () => {
    // Fresh identifiers each run so the suite is re-runnable against a database
    // that already holds rows from a previous run.
    const operation = {
      id: crypto.randomUUID(),
      commentId: internalCommentId(tenantA.platform, 'a-comment-1'),
      idempotencyKey: `integration-${crypto.randomUUID()}`,
      requestFingerprint: 'fingerprint',
      status: 'pending' as const,
      resultingCommentId: null,
      failureCode: null,
      createdAt: new Date().toISOString(),
      completedAt: null,
    };

    const first = await operations.claim(contextA, operation);
    const second = await operations.claim(contextA, { ...operation, id: crypto.randomUUID() });

    expect(first.claimed).toBe(true);
    expect(second.claimed).toBe(false);
    expect(second.operation.id).toBe(first.operation.id);

    // The same key is free for a different tenant.
    const other = await operations.claim(contextB, {
      ...operation,
      id: crypto.randomUUID(),
      commentId: internalCommentId(tenantB.platform, 'b-comment-1'),
    });
    expect(other.claimed).toBe(true);
  });

  it('keeps the tenant setting out of the pooled connection', async () => {
    await database.withTenant(tenantA.accountId, async (tx) => {
      const inside = await tx.query<{ value: string }>(
        `select current_setting('app.account_id', true) as value`,
      );
      expect(inside.rows[0]!.value).toBe(tenantA.accountId);
    });

    // Transaction-local scope means the next checkout starts with no tenant.
    const owner = new Client({ connectionString: ownerUrl! });
    await owner.connect();
    const leaked = await owner.query<{ value: string | null }>(
      `select current_setting('app.account_id', true) as value`,
    );
    await owner.end();
    expect(leaked.rows[0]!.value ?? '').toBe('');
  });
});
