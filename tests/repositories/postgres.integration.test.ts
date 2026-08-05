import { readFile } from 'node:fs/promises';

import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PostgresDatabase } from '../../src/repositories/database.js';
import {
  PostgresCommentRepository,
  PostgresPostRepository,
  PostgresReplyOperationRepository,
} from '../../src/repositories/postgres.js';
import { seedTenants } from '../../src/seed-data.js';
import type { ObservedComment, TenantContext } from '../../src/shared/types.js';
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
/** A different platform, so a platform predicate has something to exclude. */
const tenantC = seedTenants[2]!;
const contextA: TenantContext = { accountId: tenantA.accountId };
const contextB: TenantContext = { accountId: tenantB.accountId };

function comment(tenant: typeof tenantA, externalId: string, publishedAt: string): ObservedComment {
  return {
    postId: tenant.postId,
    platform: tenant.platform,
    author: { id: `author-${externalId}`, displayName: 'Ada Lovelace' },
    body: `body of ${externalId}`,
    publishedAt,
    updatedAt: publishedAt,
    externalId,
    externalParentCommentId: null,
  };
}

describe.skipIf(!enabled)('PostgreSQL persistence and tenant isolation', () => {
  let database: PostgresDatabase;
  let comments: PostgresCommentRepository;
  let posts: PostgresPostRepository;
  let operations: PostgresReplyOperationRepository;
  /** Identities the database assigned, captured for tests that need one. */
  let storedA: readonly string[] = [];
  let storedB: readonly string[] = [];

  beforeAll(async () => {
    database = new PostgresDatabase(appUrl!);
    comments = new PostgresCommentRepository(database);
    posts = new PostgresPostRepository(database);
    operations = new PostgresReplyOperationRepository(database);

    storedA = (
      await comments.upsertMany(contextA, [
        comment(tenantA, 'a-comment-1', '2026-08-01T10:00:00.000Z'),
        comment(tenantA, 'a-comment-2', '2026-08-01T11:00:00.000Z'),
        comment(tenantA, 'a-comment-3', '2026-08-01T12:00:00.000Z'),
      ])
    ).map((item) => item.id);
    storedB = (
      await comments.upsertMany(contextB, [
        comment(tenantB, 'b-comment-1', '2026-08-01T10:30:00.000Z'),
      ])
    ).map((item) => item.id);
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

  it('gives two tenants observing the same provider comment two rows', async () => {
    // The collision ADR-0013 exists to prevent. Deriving identity from
    // (platform, externalId) gave both tenants one primary key, so the second
    // insert violated comments_pkey rather than the named conflict target and
    // rolled back the whole batch. Two tenants connecting one Instagram account
    // is an ordinary agency arrangement the schema deliberately permits.
    const shared = `shared-${crypto.randomUUID()}`;

    const [forA] = await comments.upsertMany(contextA, [
      comment(tenantA, shared, '2026-08-01T13:00:00.000Z'),
    ]);
    const [forB] = await comments.upsertMany(contextB, [
      comment(tenantB, shared, '2026-08-01T13:00:00.000Z'),
    ]);

    expect(forA!.id).not.toBe(forB!.id);
    await expect(comments.findById(contextA, forA!.id)).resolves.toMatchObject({ id: forA!.id });
    await expect(comments.findById(contextB, forB!.id)).resolves.toMatchObject({ id: forB!.id });
    // Each tenant sees only its own row.
    await expect(comments.findById(contextA, forB!.id)).resolves.toBeNull();
  });

  it('resolves a reply parent to the stored row rather than a derived value', async () => {
    const parentExternal = `parent-${crypto.randomUUID()}`;
    const [parent] = await comments.upsertMany(contextA, [
      comment(tenantA, parentExternal, '2026-08-01T14:00:00.000Z'),
    ]);
    const [reply] = await comments.upsertMany(contextA, [
      {
        ...comment(tenantA, `reply-${crypto.randomUUID()}`, '2026-08-01T14:01:00.000Z'),
        externalParentCommentId: parentExternal,
      },
    ]);

    expect(reply!.parentCommentId).toBe(parent!.id);
  });

  it('resolves a published post for its own tenant only', async () => {
    await expect(posts.findPublishedById(contextA, tenantA.postId)).resolves.toMatchObject({
      post: { id: tenantA.postId, externalPostId: tenantA.externalPostId },
      snapshot: { exhausted: expect.any(Boolean) },
    });
    await expect(posts.findPublishedById(contextA, tenantB.postId)).resolves.toBeNull();
  });

  it('returns the authorised connection the post was published through', async () => {
    // The join to social_accounts was already there for the platform column;
    // the connection a provider call acts as comes from the same row (Spec-016).
    const record = await posts.findPublishedById(contextA, tenantA.postId);

    expect(record?.post.connection).toEqual({
      socialAccountId: tenantA.socialAccountId,
      platform: tenantA.platform,
      credentialReference: tenantA.credentialReference,
    });
  });

  it('gives each tenant its own connection for the same platform', async () => {
    const a = await posts.findPublishedById(contextA, tenantA.postId);
    const b = await posts.findPublishedById(contextB, tenantB.postId);

    expect(a?.post.connection.credentialReference).toBe(tenantA.credentialReference);
    expect(b?.post.connection.credentialReference).toBe(tenantB.credentialReference);
    expect(a?.post.connection.socialAccountId).not.toBe(b?.post.connection.socialAccountId);
  });

  it('round-trips the snapshot state a read depends on', async () => {
    const start = (await posts.findPublishedById(contextA, tenantA.postId))!.snapshot;
    const page2 = { providerCursor: 'provider-page-2', exhausted: false, completedAt: null };

    await expect(posts.saveSnapshotState(contextA, tenantA.postId, page2, start)).resolves.toBe(
      true,
    );
    await expect(posts.findPublishedById(contextA, tenantA.postId)).resolves.toMatchObject({
      snapshot: { providerCursor: 'provider-page-2', exhausted: false },
    });

    const done = {
      providerCursor: null,
      exhausted: true,
      completedAt: '2026-08-01T10:00:00.000Z',
    };
    await expect(posts.saveSnapshotState(contextA, tenantA.postId, done, page2)).resolves.toBe(
      true,
    );
    await expect(posts.findPublishedById(contextA, tenantA.postId)).resolves.toMatchObject({
      snapshot: { providerCursor: null, exhausted: true },
    });
  });

  it('refuses to move a snapshot that changed underneath the writer', async () => {
    // Two concurrent hydrations used to write continuations in either order,
    // and the later writer won regardless of which was further along, so the
    // snapshot could move backwards (Spec-019).
    const start = (await posts.findPublishedById(contextA, tenantA.postId))!.snapshot;
    const ahead = { providerCursor: 'page-9', exhausted: false, completedAt: null };
    const behind = { providerCursor: 'page-2', exhausted: false, completedAt: null };

    await expect(posts.saveSnapshotState(contextA, tenantA.postId, ahead, start)).resolves.toBe(
      true,
    );
    // A writer still holding the state it read before `ahead` landed.
    await expect(posts.saveSnapshotState(contextA, tenantA.postId, behind, start)).resolves.toBe(
      false,
    );

    await expect(posts.findPublishedById(contextA, tenantA.postId)).resolves.toMatchObject({
      snapshot: { providerCursor: 'page-9' },
    });
  });

  it('cannot advance another tenant snapshot state', async () => {
    const before = await posts.findPublishedById(contextB, tenantB.postId);
    // Row-level security makes this update match nothing rather than fail loudly.
    await posts.saveSnapshotState(
      contextA,
      tenantB.postId,
      { providerCursor: 'forged', exhausted: true, completedAt: null },
      before!.snapshot,
    );
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

    // Tenant B's identity, assigned by the database; tenant A must not resolve it.
    const foreign = storedB[0]!;
    await expect(comments.findById(contextA, foreign)).resolves.toBeNull();
    await expect(comments.resolveExternalId(contextA, foreign)).resolves.toBeNull();
  });

  it('hides another tenant rows even without an account predicate', async () => {
    // The repository predicates are removed here on purpose. Only row-level
    // security can produce an empty result, so this is what distinguishes
    // working RLS from predicates that merely look like isolation.
    //
    // Every tenant-scoped table is covered, not only the two the read path
    // touches: the perimeter is only as good as its least-guarded table
    // (Spec-018).
    const rows = await database.withTenant(tenantA.accountId, async (tx) => {
      const count = async (sql: string, parameters: readonly unknown[]) =>
        (await tx.query<{ count: string }>(sql, parameters)).rows[0]!.count;
      return {
        comments: await count(`select count(*)::text as count from comments where post_id = $1`, [
          tenantB.postId,
        ]),
        posts: await count(`select count(*)::text as count from posts where id = $1`, [
          tenantB.postId,
        ]),
        socialAccounts: await count(
          `select count(*)::text as count from social_accounts where id = $1`,
          [tenantB.socialAccountId],
        ),
        replyOperations: await count(
          `select count(*)::text as count from reply_operations where account_id = $1`,
          [tenantB.accountId],
        ),
        accounts: await count(`select count(*)::text as count from accounts where id = $1`, [
          tenantB.accountId,
        ]),
      };
    });

    expect(rows).toEqual({
      comments: '0',
      posts: '0',
      socialAccounts: '0',
      replyOperations: '0',
      accounts: '0',
    });
  });

  it('shows a tenant exactly one account row: its own', async () => {
    // Nothing queries accounts today, which is why the policy is worth having.
    // The next query is written by someone who assumes the perimeter is whole.
    const rows = await database.withTenant(
      tenantA.accountId,
      async (tx) => (await tx.query<{ id: string }>(`select id from accounts`)).rows,
    );

    expect(rows.map((row) => row.id)).toEqual([tenantA.accountId]);
  });

  it('runs as a role holding neither SUPERUSER nor BYPASSRLS', async () => {
    // Both attributes exempt a role from every policy unconditionally, so a
    // role that has drifted turns each isolation test above into a test of
    // nothing. This fails loudly instead.
    const row = await database.withTenant(
      tenantA.accountId,
      async (tx) =>
        (
          await tx.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
            `select rolsuper, rolbypassrls from pg_roles where rolname = current_user`,
          )
        ).rows[0],
    );

    expect(row).toEqual({ rolsuper: false, rolbypassrls: false });
  });

  it('corrects a service role that already exists with elevated rights', async () => {
    // Migration 002 skips creation when the name is taken, so a pre-existing
    // comments_app holding SUPERUSER silently defeated every policy while the
    // migration reported success. The statement under test is read out of the
    // migration itself, so removing it from the migration fails this test.
    // Read from the repository root, which is vitest's working directory.
    const migration = await readFile(
      'migrations/006_isolation_and_schema_completeness.sql',
      'utf8',
    );
    const pin = /^alter role comments_app .+;$/m.exec(migration)?.[0];
    expect(pin).toBeDefined();

    const owner = new Client({ connectionString: ownerUrl });
    await owner.connect();
    try {
      await owner.query('alter role comments_app superuser bypassrls');
      const drifted = await owner.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
        `select rolsuper, rolbypassrls from pg_roles where rolname = 'comments_app'`,
      );
      expect(drifted.rows[0]).toEqual({ rolsuper: true, rolbypassrls: true });

      await owner.query(pin!);

      const corrected = await owner.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
        `select rolsuper, rolbypassrls from pg_roles where rolname = 'comments_app'`,
      );
      expect(corrected.rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });
    } finally {
      // Never leave the cluster with an elevated service role, whatever failed.
      await owner.query('alter role comments_app nosuperuser nobypassrls').catch(() => undefined);
      await owner.end();
    }
  });

  it('rejects a platform the domain does not support, at the database', async () => {
    const owner = new Client({ connectionString: ownerUrl });
    await owner.connect();
    try {
      await expect(
        owner.query(
          `insert into social_accounts
             (id, account_id, platform, external_account_id, credential_reference)
           values ($1, $2, 'myspace', 'ms-account', 'secret://social/myspace/x')`,
          [crypto.randomUUID(), tenantA.accountId],
        ),
      ).rejects.toThrow(/social_accounts_platform_check/);
    } finally {
      await owner.end();
    }
  });

  it('indexes every reply-operation foreign key and states its delete behaviour', async () => {
    const owner = new Client({ connectionString: ownerUrl });
    await owner.connect();
    try {
      // PostgreSQL indexes the referenced side of a foreign key, never the
      // referencing side, so an unindexed one is a sequential scan on lookup
      // and on any delete of the parent row.
      const indexed = await owner.query<{ indexdef: string }>(
        `select indexdef from pg_indexes where tablename = 'reply_operations'`,
      );
      const definitions = indexed.rows.map((row) => row.indexdef).join('\n');
      expect(definitions).toContain('comment_id');
      expect(definitions).toContain('resulting_comment_id');

      // No foreign key may be left on the default: deletion semantics are a
      // decision, and 'a' is PostgreSQL's "nobody chose".
      const actions = await owner.query<{ conname: string; confdeltype: string }>(
        `select conname, confdeltype from pg_constraint
         where contype = 'f'
           and conrelid in ('accounts'::regclass, 'social_accounts'::regclass,
                            'posts'::regclass, 'comments'::regclass,
                            'reply_operations'::regclass)`,
      );
      const byName = Object.fromEntries(actions.rows.map((row) => [row.conname, row.confdeltype]));
      expect(byName['comments_post_id_fkey']).toBe('c');
      expect(byName['reply_operations_comment_id_fkey']).toBe('a');
      expect(byName['reply_operations_resulting_comment_id_fkey']).toBe('a');
      expect(byName['comments_account_id_fkey']).toBe('c');
    } finally {
      await owner.end();
    }
  });

  it('round-trips the reply-operation lifecycle, including unknown', async () => {
    // Every column added by migration 007 has to survive the mapper: the
    // row-cast defect that shipped green was exactly this class of bug.
    const commentId = storedA[0]!;
    const key = `lifecycle-${crypto.randomUUID()}`;
    const lease = new Date(Date.now() + 60_000).toISOString();

    const claim = await operations.claim(contextA, {
      id: crypto.randomUUID(),
      commentId,
      idempotencyKey: key,
      requestFingerprint: 'fingerprint',
      status: 'pending',
      resultingCommentId: null,
      failureCode: null,
      leaseExpiresAt: lease,
      externalReplyId: null,
      createdAt: new Date().toISOString(),
      completedAt: null,
    });
    expect(claim.operation.leaseExpiresAt).toBe(lease);
    expect(claim.operation.externalReplyId).toBeNull();

    const published = await operations.recordPublished(contextA, claim.operation.id, 'ig-reply-99');
    expect(published.externalReplyId).toBe('ig-reply-99');
    expect(published.status).toBe('pending');

    const unknown = await operations.markUnknown(contextA, claim.operation.id, 'PROVIDER_ERROR');
    expect(unknown).toMatchObject({ status: 'unknown', failureCode: 'PROVIDER_ERROR' });
    expect(unknown?.completedAt).toEqual(expect.any(String));

    // Terminal: a second recoverer must not move it again.
    await expect(
      operations.markUnknown(contextA, claim.operation.id, 'PROVIDER_ERROR'),
    ).resolves.toBeNull();

    await expect(operations.findByIdempotencyKey(contextA, key)).resolves.toMatchObject({
      status: 'unknown',
      externalReplyId: 'ig-reply-99',
      leaseExpiresAt: lease,
    });
  });

  it('finds a stored comment by the provider identifier recovery uses', async () => {
    const externalId = `recovery-${crypto.randomUUID()}`;
    const [stored] = await comments.upsertMany(contextA, [
      comment(tenantA, externalId, '2026-08-01T15:00:00.000Z'),
    ]);

    await expect(comments.findByExternalId(contextA, externalId)).resolves.toMatchObject({
      id: stored!.id,
    });
    // Another tenant's provider identifier resolves to nothing here.
    await expect(comments.findByExternalId(contextB, externalId)).resolves.toBeNull();
  });

  it('does not resolve a post that is not published', async () => {
    // Every fixture was published, so `p.status = 'published'` was mutable to
    // `p.status is not null` with the whole suite still green (Spec-020).
    const owner = new Client({ connectionString: ownerUrl });
    await owner.connect();
    const draftId = crypto.randomUUID();
    try {
      await owner.query(
        `insert into posts (id, account_id, social_account_id, external_post_id, status, published_at)
         values ($1, $2, $3, $4, 'draft', null)`,
        [draftId, tenantA.accountId, tenantA.socialAccountId, `draft-${draftId}`],
      );

      await expect(posts.findPublishedById(contextA, draftId)).resolves.toBeNull();
    } finally {
      await owner.query(`delete from posts where id = $1`, [draftId]).catch(() => undefined);
      await owner.end();
    }
  });

  it('refreshes a comment the provider reports as edited', async () => {
    // The upsert's `do update set` clause was fully removable with nothing
    // failing: no fixture ever observed the same comment twice with different
    // content, so an edited comment would have silently stayed stale.
    const externalId = `edited-${crypto.randomUUID()}`;
    const [before] = await comments.upsertMany(contextA, [
      comment(tenantA, externalId, '2026-08-01T16:00:00.000Z'),
    ]);

    const [after] = await comments.upsertMany(contextA, [
      {
        ...comment(tenantA, externalId, '2026-08-01T16:00:00.000Z'),
        body: 'edited by its author',
        author: { id: `author-${externalId}`, displayName: 'Ada L.' },
        updatedAt: '2026-08-01T17:00:00.000Z',
      },
    ]);

    // Same row — identity is stable across observations.
    expect(after!.id).toBe(before!.id);
    expect(after!.body).toBe('edited by its author');
    expect(after!.author.displayName).toBe('Ada L.');
    expect(after!.updatedAt).toBe('2026-08-01T17:00:00.000Z');
    // And the refresh is durable, not just present in the returned row.
    await expect(comments.findById(contextA, before!.id)).resolves.toMatchObject({
      body: 'edited by its author',
    });
  });

  it('keeps one platform comments out of another platform query', async () => {
    // Every fixture used to be `instagram`, so the platform predicate in both
    // adapters could be neutralised without a single test noticing.
    const externalId = `yt-${crypto.randomUUID()}`;
    const contextC: TenantContext = { accountId: tenantC.accountId };
    const [stored] = await comments.upsertMany(contextC, [
      comment(tenantC, externalId, '2026-08-01T18:00:00.000Z'),
    ]);

    const onYoutube = await comments.listByPost(contextC, {
      postId: tenantC.postId,
      platform: 'youtube',
      limit: 50,
    });
    const onInstagram = await comments.listByPost(contextC, {
      postId: tenantC.postId,
      platform: 'instagram',
      limit: 50,
    });

    expect(onYoutube.items.map((item) => item.id)).toContain(stored!.id);
    expect(onYoutube.items.every((item) => item.platform === 'youtube')).toBe(true);
    expect(onInstagram.items).toEqual([]);
  });

  it('refuses to delete a comment a reply operation still records', async () => {
    // The row records something published under a customer's name. Losing it
    // silently to a cascade is worse than an explicit failure (Spec-018).
    const owner = new Client({ connectionString: ownerUrl });
    await owner.connect();
    try {
      const [stored] = await comments.upsertMany(contextA, [
        comment(tenantA, `delete-guard-${crypto.randomUUID()}`, '2026-08-01T14:00:00.000Z'),
      ]);
      await operations.claim(contextA, {
        id: crypto.randomUUID(),
        commentId: stored!.id,
        idempotencyKey: `delete-guard-${crypto.randomUUID()}`,
        requestFingerprint: 'fingerprint',
        status: 'pending',
        leaseExpiresAt: '2026-08-01T10:02:00.000Z',
        externalReplyId: null,
        resultingCommentId: null,
        failureCode: null,
        createdAt: new Date().toISOString(),
        completedAt: null,
      });

      await expect(owner.query(`delete from comments where id = $1`, [stored!.id])).rejects.toThrow(
        /reply_operations/,
      );
    } finally {
      await owner.end();
    }
  });

  it('removes a post comments when the post itself is deleted', async () => {
    // A comment is a snapshot of that post's conversation and has no meaning
    // without it, so the cascade is the deliberate choice here.
    const owner = new Client({ connectionString: ownerUrl });
    await owner.connect();
    try {
      const postId = crypto.randomUUID();
      await owner.query(
        `insert into posts (id, account_id, social_account_id, external_post_id, status, published_at)
         values ($1, $2, $3, $4, 'published', now())`,
        [postId, tenantA.accountId, tenantA.socialAccountId, `cascade-${postId}`],
      );
      await owner.query(
        `insert into comments
           (account_id, post_id, social_account_id, external_comment_id,
            author_external_id, author_display_name, body, published_at, updated_at)
         values ($1, $2, $3, $4, 'author', 'Ada Lovelace', 'body', now(), now())`,
        [tenantA.accountId, postId, tenantA.socialAccountId, `cascade-comment-${postId}`],
      );

      await owner.query(`delete from posts where id = $1`, [postId]);

      const remaining = await owner.query<{ count: string }>(
        `select count(*)::text as count from comments where post_id = $1`,
        [postId],
      );
      expect(remaining.rows[0]!.count).toBe('0');
    } finally {
      await owner.end();
    }
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
      commentId: storedA[0]!,
      idempotencyKey: `integration-${crypto.randomUUID()}`,
      requestFingerprint: 'fingerprint',
      status: 'pending' as const,
      leaseExpiresAt: '2026-08-01T10:02:00.000Z',
      externalReplyId: null,
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
      commentId: storedB[0]!,
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
