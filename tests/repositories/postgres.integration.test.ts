import { readFile } from 'node:fs/promises';

import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PostgresDatabase } from '../../src/repositories/database.js';
import {
  PostgresCommentRepository,
  PostgresPostRepository,
  PostgresReplyOperationRepository,
} from '../../src/repositories/postgres.js';
import { seedSecondConnection, seedTenants } from '../../src/seed-data.js';
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
  /**
   * A post created fresh for this run.
   *
   * Tests that assert an exact row count cannot use the seeded post: rows
   * accumulate across runs against a persistent compose stack, and two such
   * tests were demonstrated failing after roughly fifty local runs while their
   * own comments claimed re-runnability. CI never saw it because CI is always
   * fresh (Spec-020).
   */
  let scratchPostId = '';

  beforeAll(async () => {
    database = new PostgresDatabase(appUrl!);
    comments = new PostgresCommentRepository(database);
    posts = new PostgresPostRepository(database);
    operations = new PostgresReplyOperationRepository(database);

    // Gate the whole file on the service role being ordinary. The drift test
    // below elevates it cluster-wide and restores it in `finally`; if a hard
    // kill ever skips that restore, every isolation assertion here would pass
    // for the wrong reason. Checking on entry — rather than relying on the
    // in-file assertion appearing before the drift test in declaration order —
    // makes a leaked elevation fail loudly at setup instead (second sweep).
    const roleGate = await database.withTenant(
      tenantA.accountId,
      async (tx) =>
        (
          await tx.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
            `select rolsuper, rolbypassrls from pg_roles where rolname = current_user`,
          )
        ).rows[0],
    );
    if (roleGate?.rolsuper || roleGate?.rolbypassrls) {
      throw new Error(
        'comments_app entered the suite holding SUPERUSER or BYPASSRLS — a previous run leaked an elevation; reset with `docker compose down -v`',
      );
    }

    scratchPostId = crypto.randomUUID();
    const owner = new Client({ connectionString: ownerUrl });
    await owner.connect();
    try {
      await owner.query(
        `insert into posts (id, account_id, social_account_id, external_post_id, status, published_at)
         values ($1, $2, $3, $4, 'published', now())`,
        [scratchPostId, tenantA.accountId, tenantA.socialAccountId, `scratch-${scratchPostId}`],
      );
    } finally {
      await owner.end();
    }

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
    // Tenant B needs a reply operation to exist for the predicate-removed proof
    // to mean anything on that table: on a fresh database the count was zero
    // whether the policy worked or not, and CI is always fresh (Spec-020).
    await operations.claim(contextB, {
      id: crypto.randomUUID(),
      commentId: storedB[0]!,
      idempotencyKey: `tenant-b-visible-${crypto.randomUUID()}`,
      requestFingerprint: 'fingerprint',
      status: 'pending',
      resultingCommentId: null,
      failureCode: null,
      leaseExpiresAt: new Date(Date.now() + 600_000).toISOString(),
      externalReplyId: null,
      createdAt: new Date().toISOString(),
      completedAt: null,
    });
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
    // A post created for this run, not the seeded one. Against a persistent
    // compose stack the seeded post accumulates rows until `limit: 500` starts
    // reporting hasMore, and this test failed at 537 rows despite claiming
    // re-runnability (Spec-020).
    const query = { postId: scratchPostId, platform: tenantA.platform } as const;
    await comments.upsertMany(contextA, [
      {
        ...comment(tenantA, `walk-1-${scratchPostId}`, '2026-08-01T10:00:00.000Z'),
        postId: scratchPostId,
      },
      {
        ...comment(tenantA, `walk-2-${scratchPostId}`, '2026-08-01T11:00:00.000Z'),
        postId: scratchPostId,
      },
      {
        ...comment(tenantA, `walk-3-${scratchPostId}`, '2026-08-01T12:00:00.000Z'),
        postId: scratchPostId,
      },
      {
        ...comment(tenantA, `walk-4-${scratchPostId}`, '2026-08-01T13:00:00.000Z'),
        postId: scratchPostId,
      },
      {
        ...comment(tenantA, `walk-5-${scratchPostId}`, '2026-08-01T14:00:00.000Z'),
        postId: scratchPostId,
      },
    ]);

    const everything = await comments.listByPost(contextA, { ...query, limit: 500 });
    expect(everything.items).toHaveLength(5);
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
    // On a fresh post so the count is exact: the seeded post accumulates rows
    // across runs and had reached 57, pinning both sides of a 50-limit
    // comparison at 50 whatever the upsert did — a duplicate row could not have
    // moved either number (Spec-020).
    const externalId = `dedup-${crypto.randomUUID()}`;
    const observe = () =>
      comments.upsertMany(contextA, [
        { ...comment(tenantA, externalId, '2026-08-01T10:00:00.000Z'), postId: scratchPostId },
      ]);
    await observe();
    await observe();

    // Resolve the assigned id for this external id, then count its occurrences.
    // The scratch post is shared by other tests in this file, so filter by the
    // row this test created rather than by the post.
    const [stored] = await observe();
    const page = await comments.listByPost(contextA, {
      postId: scratchPostId,
      platform: tenantA.platform,
      limit: 500,
    });
    expect(page.items.filter((item) => item.id === stored!.id)).toHaveLength(1);
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
    // migration reported success. The correcting statement is read out of the
    // migration itself, so removing it from the migration fails this test. On
    // managed PostgreSQL that statement cannot run without superuser, so the
    // migration also asserts the role is ordinary and fails loudly otherwise —
    // that assertion is exercised below too (Spec-018, second sweep).
    const migration = await readFile(
      'migrations/006_isolation_and_schema_completeness.sql',
      'utf8',
    );
    const clears = migration.includes('alter role comments_app nosuperuser nobypassrls');
    const asserts = /comments_app holds SUPERUSER or BYPASSRLS/.test(migration);
    expect(clears).toBe(true);
    expect(asserts).toBe(true);

    const owner = new Client({ connectionString: ownerUrl });
    await owner.connect();
    try {
      // Cluster-wide and visible to every other connection for as long as it
      // lasts. `fileParallelism: false` keeps the other database-backed file
      // from probing isolation during this window, and the finally block below
      // restores the role whatever happens.
      await owner.query('alter role comments_app superuser bypassrls');
      const drifted = await owner.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
        `select rolsuper, rolbypassrls from pg_roles where rolname = 'comments_app'`,
      );
      expect(drifted.rows[0]).toEqual({ rolsuper: true, rolbypassrls: true });

      // The migration's own guard: when the role is elevated, the assertion
      // block raises rather than completing. Re-run the migration's assertion
      // exactly as written and confirm it refuses.
      const guard = `do $$
        declare elevated boolean;
        begin
          select rolsuper or rolbypassrls into elevated from pg_roles where rolname = 'comments_app';
          if elevated then
            raise exception 'comments_app holds SUPERUSER or BYPASSRLS, which defeats every row-level security policy; refusing to complete migration 006';
          end if;
        end $$;`;
      await expect(owner.query(guard)).rejects.toThrow(/defeats every row-level security policy/);

      // The correcting statement then makes it ordinary.
      await owner.query('alter role comments_app nosuperuser nobypassrls');
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

  it('finds a stored reply by the provider identifier recovery uses', async () => {
    const parentExternal = `recovery-parent-${crypto.randomUUID()}`;
    const replyExternal = `recovery-${crypto.randomUUID()}`;
    const [parent] = await comments.upsertMany(contextA, [
      comment(tenantA, parentExternal, '2026-08-01T15:00:00.000Z'),
    ]);
    const [stored] = await comments.upsertMany(contextA, [
      comment(tenantA, replyExternal, '2026-08-01T15:01:00.000Z'),
    ]);

    await expect(
      comments.findReplyByExternalId(contextA, parent!.id, replyExternal),
    ).resolves.toMatchObject({ id: stored!.id });
    // Another tenant cannot resolve it at all, sibling or no sibling.
    await expect(
      comments.findReplyByExternalId(contextB, parent!.id, replyExternal),
    ).resolves.toBeNull();
  });

  it('reads back only the batch it stored, not another connection with the same id', async () => {
    // The read-back after an upsert selected by account and external id alone.
    // With two connections holding the same provider identifier it returned
    // both rows, so a one-item batch came back as two and the caller — which
    // destructures the first — could take the wrong one (Spec-024).
    const shared = `readback-${crypto.randomUUID()}`;

    const owner = new Client({ connectionString: ownerUrl });
    await owner.connect();
    try {
      await owner.query(
        `insert into comments
           (account_id, post_id, social_account_id, external_comment_id,
            author_external_id, author_display_name, body, published_at, updated_at)
         values ($1, $2, $3, $4, 'author', 'Ada Lovelace', 'other connection', now(), now())
         on conflict (social_account_id, external_comment_id) do nothing`,
        [
          tenantA.accountId,
          seedSecondConnection.postId,
          seedSecondConnection.socialAccountId,
          shared,
        ],
      );
    } finally {
      await owner.end();
    }

    const stored = await comments.upsertMany(contextA, [
      comment(tenantA, shared, '2026-08-01T22:00:00.000Z'),
    ]);

    expect(stored).toHaveLength(1);
    expect(stored[0]!.postId).toBe(tenantA.postId);
  });

  it('resolves a reply on the sibling connection, not another of the same tenant', async () => {
    // Provider identifiers are unique per social account, so a tenant with two
    // connections can hold the same one twice. Scoping the lookup by account
    // alone returned whichever row the planner produced first, which could
    // complete a reply operation against a reply published through a different
    // connection (Spec-024).
    const shared = `two-conn-reply-${crypto.randomUUID()}`;
    const parentExternal = `two-conn-recovery-parent-${crypto.randomUUID()}`;

    const [parentOnFirst] = await comments.upsertMany(contextA, [
      comment(tenantA, parentExternal, '2026-08-01T21:00:00.000Z'),
    ]);
    const [replyOnFirst] = await comments.upsertMany(contextA, [
      comment(tenantA, shared, '2026-08-01T21:01:00.000Z'),
    ]);

    // The same provider identifier under tenant A's other connection.
    const owner = new Client({ connectionString: ownerUrl });
    await owner.connect();
    let replyOnSecond = '';
    try {
      const inserted = await owner.query<{ id: string }>(
        `insert into comments
           (account_id, post_id, social_account_id, external_comment_id,
            author_external_id, author_display_name, body, published_at, updated_at)
         values ($1, $2, $3, $4, 'author', 'Ada Lovelace', 'other connection', now(), now())
         on conflict (social_account_id, external_comment_id) do update
           set last_seen_at = now()
         returning id`,
        [
          tenantA.accountId,
          seedSecondConnection.postId,
          seedSecondConnection.socialAccountId,
          shared,
        ],
      );
      replyOnSecond = inserted.rows[0]!.id;
    } finally {
      await owner.end();
    }
    expect(replyOnSecond).not.toBe(replyOnFirst!.id);

    const resolved = await comments.findReplyByExternalId(contextA, parentOnFirst!.id, shared);

    expect(resolved?.id).toBe(replyOnFirst!.id);
    expect(resolved?.id).not.toBe(replyOnSecond);
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

    // Resolved by identity rather than by scanning a page, so an accumulated
    // database cannot push the new row past the limit (Spec-020).
    await expect(comments.findById(contextC, stored!.id)).resolves.toMatchObject({
      platform: 'youtube',
    });
    expect(onYoutube.items.every((item) => item.platform === 'youtube')).toBe(true);
    expect(onYoutube.items.length).toBeGreaterThan(0);
    expect(onInstagram.items).toEqual([]);
  });

  it('refuses to hand back a stored comment the domain model rejects', async () => {
    // `not null` is not the same as valid: the column accepts an empty body,
    // and a mapper defect or a bad write would produce exactly this. Without
    // the guard it serialises as a comment with an empty body (Spec-025).
    const owner = new Client({ connectionString: ownerUrl });
    await owner.connect();
    let brokenId = '';
    try {
      const inserted = await owner.query<{ id: string }>(
        `insert into comments
           (account_id, post_id, social_account_id, external_comment_id,
            author_external_id, author_display_name, body, published_at, updated_at)
         values ($1, $2, $3, $4, 'author', 'Ada Lovelace', '', now(), now())
         returning id`,
        [
          tenantA.accountId,
          scratchPostId,
          tenantA.socialAccountId,
          `invalid-body-${crypto.randomUUID()}`,
        ],
      );
      brokenId = inserted.rows[0]!.id;
    } finally {
      await owner.end();
    }

    await expect(comments.findById(contextA, brokenId)).rejects.toMatchObject({
      code: 'INTERNAL_ERROR',
      reason: 'stored_record_invalid',
      statusCode: 500,
      recordKind: 'comment',
      recordId: brokenId,
    });

    const cleanup = new Client({ connectionString: ownerUrl });
    await cleanup.connect();
    await cleanup.query(`delete from comments where id = $1`, [brokenId]);
    await cleanup.end();
  });

  it('refuses to hand back a stored reply operation the domain model rejects', async () => {
    // The mapper that actually shipped broken. A cast rather than a map made
    // every field undefined, and every idempotent retry looked like a
    // different request (Spec-025).
    const key = `invalid-operation-${crypto.randomUUID()}`;
    const owner = new Client({ connectionString: ownerUrl });
    await owner.connect();
    try {
      await owner.query(
        `insert into reply_operations
           (id, account_id, comment_id, idempotency_key, request_fingerprint, status,
            lease_expires_at)
         values ($1, $2, $3, $4, '', 'pending', now())`,
        [crypto.randomUUID(), tenantA.accountId, storedA[0]!, key],
      );
    } finally {
      await owner.end();
    }

    await expect(operations.findByIdempotencyKey(contextA, key)).rejects.toMatchObject({
      code: 'INTERNAL_ERROR',
      reason: 'stored_record_invalid',
      recordKind: 'reply_operation',
    });

    const cleanup = new Client({ connectionString: ownerUrl });
    await cleanup.connect();
    await cleanup.query(`delete from reply_operations where idempotency_key = $1`, [key]);
    await cleanup.end();
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
    // `max: 1` forces the second checkout onto the same physical connection the
    // first used. The earlier version of this test asserted on a brand-new
    // pg.Client, which has never had set_config called and is therefore empty
    // whatever the code does: flipping set_config's `is_local` flag to false —
    // real cross-request tenant carry-over — left it green (Spec-020).
    const pooled = new PostgresDatabase({ connectionString: appUrl!, max: 1 });
    try {
      const seen = await pooled.withTenant(
        tenantA.accountId,
        async (tx) =>
          (
            await tx.query<{ value: string }>(
              `select current_setting('app.account_id', true) as value`,
            )
          ).rows[0]!.value,
      );
      expect(seen).toBe(tenantA.accountId);

      // Same connection, outside any transaction this time.
      const after = await pooled.withTenant(
        tenantB.accountId,
        async (tx) =>
          (await tx.query<{ pid: number }>(`select pg_backend_pid() as pid`)).rows[0]!.pid,
      );
      expect(after).toEqual(expect.any(Number));

      const carried = await pooled.withTenant(
        tenantB.accountId,
        async (tx) =>
          (
            await tx.query<{ value: string }>(
              `select current_setting('app.account_id', true) as value`,
            )
          ).rows[0]!.value,
      );
      // Tenant A's context must not survive into tenant B's transaction on the
      // very same backend.
      expect(carried).toBe(tenantB.accountId);
      expect(carried).not.toBe(tenantA.accountId);
    } finally {
      await pooled.close();
    }
  });

  it('scopes the tenant setting to the transaction, not the session', async () => {
    // The distinction that matters is the `is_local` flag on set_config. With
    // it false the value survives the commit and stays on the pooled backend
    // for whatever runs next, which is cross-request tenant carry-over.
    //
    // withTenant re-sets the value at the start of every transaction, so the
    // leak is invisible from inside one. Committing early through the session
    // the port hands out puts the next statement outside any transaction on the
    // same backend, which is precisely where a leaked value would show
    // (Spec-020).
    const pooled = new PostgresDatabase({ connectionString: appUrl!, max: 1 });
    try {
      const afterCommit = await pooled.withTenant(tenantA.accountId, async (tx) => {
        const inside = await tx.query<{ value: string }>(
          `select current_setting('app.account_id', true) as value`,
        );
        expect(inside.rows[0]!.value).toBe(tenantA.accountId);

        await tx.query('commit');
        const outside = await tx.query<{ value: string | null }>(
          `select current_setting('app.account_id', true) as value`,
        );
        return outside.rows[0]!.value ?? '';
      });

      expect(afterCommit).toBe('');
      expect(afterCommit).not.toBe(tenantA.accountId);
    } finally {
      await pooled.close();
    }
  });

  it('does not carry a tenant setting out of a transaction on the same backend', async () => {
    const pooled = new PostgresDatabase({ connectionString: appUrl!, max: 1 });
    try {
      const first = await pooled.withTenant(
        tenantA.accountId,
        async (tx) =>
          (await tx.query<{ pid: number }>(`select pg_backend_pid() as pid`)).rows[0]!.pid,
      );

      // A raw read on the same pooled backend, with no transaction of its own.
      // `set_config(..., true)` is transaction-local, so this must see nothing.
      const leaked = await pooled.withTenant(tenantA.accountId, async () => undefined);
      expect(leaked).toBeUndefined();

      const second = await pooled.withTenant(tenantB.accountId, async (tx) => {
        const row = await tx.query<{ pid: number; value: string }>(
          `select pg_backend_pid() as pid, current_setting('app.account_id', true) as value`,
        );
        return row.rows[0]!;
      });

      // Proves the two ran on one backend, so the isolation above is real
      // rather than an artefact of a fresh connection each time.
      expect(second.pid).toBe(first);
      expect(second.value).toBe(tenantB.accountId);
    } finally {
      await pooled.close();
    }
  });

  it('rolls a failed batch back rather than committing its prefix', async () => {
    // Replacing `rollback` with `commit` in withTenant survived the suite. A
    // mid-batch upsert failure would then leave the rows written before the
    // failure permanently stored (Spec-020).
    const good = `rollback-good-${crypto.randomUUID()}`;

    await expect(
      comments.upsertMany(contextA, [
        comment(tenantA, good, '2026-08-01T19:00:00.000Z'),
        // Second item names another tenant's post: the insert selects no post
        // row for this account, so upsertComment throws mid-batch.
        { ...comment(tenantB, `rollback-bad-${crypto.randomUUID()}`, '2026-08-01T19:01:00.000Z') },
      ]),
    ).rejects.toThrow();

    await expect(comments.findReplyByExternalId(contextA, storedA[0]!, good)).resolves.toBeNull();
  });

  it('treats a malformed comment identifier as absent rather than a failed cast', async () => {
    // The postId twin of this guard has a killing test; the comment sibling did
    // not, so deleting `if (!isUuid(commentId)) return null` survived and a
    // malformed path parameter reached a ::uuid cast as a 500 (Spec-020).
    await expect(comments.findById(contextA, 'not-a-uuid')).resolves.toBeNull();
    await expect(comments.resolveExternalId(contextA, 'not-a-uuid')).resolves.toBeNull();
  });

  it('treats a well-formed cursor holding a non-uuid position as absent', async () => {
    // The existing negative test uses `cursor=tampered`, which dies at base64
    // parse and never reaches the `$5::uuid` cast. This one is a structurally
    // valid keyset whose id is not a UUID, which is the only input that gets
    // that far.
    await expect(
      comments.listByPost(contextA, {
        postId: tenantA.postId,
        platform: tenantA.platform,
        limit: 10,
        after: { publishedAt: '2026-08-01T10:00:00.000Z', id: 'not-a-uuid' },
      }),
    ).resolves.toEqual({ items: [], hasMore: false });
  });

  it('returns every stored comment of a batch, matched by external id not position', async () => {
    // The two adapters are one port. The PostgreSQL read-back has no ORDER BY,
    // so a caller reading stored[i] positionally would be right in memory and
    // wrong here; the contract says match on externalId (Spec-024).
    const ids = [
      `batch-a-${crypto.randomUUID()}`,
      `batch-b-${crypto.randomUUID()}`,
      `batch-c-${crypto.randomUUID()}`,
    ];
    const stored = await comments.upsertMany(
      contextA,
      ids.map((externalId, index) => ({
        ...comment(tenantA, externalId, `2026-08-01T2${index}:00:00.000Z`),
        postId: scratchPostId,
      })),
    );

    // Every input is represented exactly once, keyed by the provider id.
    const byExternal = new Map(stored.map((row) => [row.id, row]));
    expect(byExternal.size).toBe(3);
    for (const externalId of ids) {
      const match = await comments.findReplyByExternalId(contextA, stored[0]!.id, externalId);
      expect(match).not.toBeNull();
    }
  });

  it('breaks a keyset tie on id, so comments sharing a timestamp all page through', async () => {
    // Every comment fixture in the repository had a distinct published_at, so
    // dropping the (published_at, id) tie-break — in either adapter — left the
    // suite green. Real platforms report second-granularity timestamps and a
    // busy post routinely has several comments inside one second; without the
    // tie-break a page boundary landing inside such a group silently drops the
    // rest of the group (Spec-020).
    const tie = '2026-08-01T20:30:00.000Z';
    const stored = (
      await comments.upsertMany(contextA, [
        { ...comment(tenantA, `tie-a-${crypto.randomUUID()}`, tie), postId: scratchPostId },
        { ...comment(tenantA, `tie-b-${crypto.randomUUID()}`, tie), postId: scratchPostId },
        { ...comment(tenantA, `tie-c-${crypto.randomUUID()}`, tie), postId: scratchPostId },
      ])
    ).map((item) => item.id);

    const walked: string[] = [];
    let after: { publishedAt: string; id: string } | undefined;
    for (let guard = 0; guard < 10; guard += 1) {
      const page: CommentPage = await comments.listByPost(contextA, {
        postId: scratchPostId,
        platform: tenantA.platform,
        limit: 1,
        ...(after === undefined ? {} : { after }),
      });
      walked.push(...page.items.map((item) => item.id));
      const last = page.items[page.items.length - 1];
      if (!page.hasMore || last === undefined) break;
      after = { publishedAt: last.publishedAt, id: last.id };
    }

    // Every tied comment reached exactly once, none dropped at a page boundary.
    for (const id of stored) expect(walked.filter((seen) => seen === id)).toHaveLength(1);
  });

  it('treats a keyset holding a non-timestamp position as absent', async () => {
    // The mirror of the non-uuid guard below it: this half reached
    // $4::timestamptz and produced a 500 with an error-level log (Spec-022).
    await expect(
      comments.listByPost(contextA, {
        postId: tenantA.postId,
        platform: tenantA.platform,
        limit: 10,
        after: { publishedAt: 'CANARY-ATTACKER-VALUE', id: crypto.randomUUID() },
      }),
    ).resolves.toEqual({ items: [], hasMore: false });
  });

  it('scopes the parent join to one connection when a tenant has two', async () => {
    // Every seed tenant had exactly one social account, so
    // `parent.social_account_id = c.social_account_id` could never exclude
    // anything and was removable with the suite green. With two connections the
    // same provider comment id can exist under both, and without the predicate
    // the left join fans out and duplicates the reply in the page (Spec-020).
    const sharedParentExternal = `two-conn-parent-${crypto.randomUUID()}`;
    const owner = new Client({ connectionString: ownerUrl });
    await owner.connect();
    try {
      // The same provider identifier under each of tenant A's two connections.
      for (const [socialAccountId, postId] of [
        [tenantA.socialAccountId, scratchPostId],
        [seedSecondConnection.socialAccountId, seedSecondConnection.postId],
      ] as const) {
        await owner.query(
          `insert into comments
             (account_id, post_id, social_account_id, external_comment_id,
              author_external_id, author_display_name, body, published_at, updated_at)
           values ($1, $2, $3, $4, 'author', 'Ada Lovelace', 'parent', now(), now())
           on conflict (social_account_id, external_comment_id) do nothing`,
          [tenantA.accountId, postId, socialAccountId, sharedParentExternal],
        );
      }
    } finally {
      await owner.end();
    }

    const [reply] = await comments.upsertMany(contextA, [
      {
        ...comment(tenantA, `two-conn-reply-${crypto.randomUUID()}`, '2026-08-01T20:00:00.000Z'),
        postId: scratchPostId,
        externalParentCommentId: sharedParentExternal,
      },
    ]);

    // Exactly one parent, and it is the one on this reply's own connection.
    // Resolved by social account directly: `findByExternalId` scopes only by
    // account, so with two connections holding the same provider identifier it
    // is ambiguous — which is recorded as its own finding rather than papered
    // over here.
    expect(reply).toBeDefined();
    const expectedParent = await (async () => {
      const client = new Client({ connectionString: ownerUrl });
      await client.connect();
      try {
        const found = await client.query<{ id: string }>(
          `select id from comments
           where social_account_id = $1 and external_comment_id = $2`,
          [tenantA.socialAccountId, sharedParentExternal],
        );
        return found.rows[0]!.id;
      } finally {
        await client.end();
      }
    })();
    expect(reply!.parentCommentId).toBe(expectedParent);

    // And the read-back does not duplicate the reply row. On the scratch post,
    // which does not accumulate across runs (Spec-020).
    const page = await comments.listByPost(contextA, {
      postId: scratchPostId,
      platform: tenantA.platform,
      limit: 500,
    });
    const occurrences = page.items.filter((item) => item.id === reply!.id);
    expect(occurrences).toHaveLength(1);
  });
});
