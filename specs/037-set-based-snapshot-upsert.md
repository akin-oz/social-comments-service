---
spec: 037
title: Store a hydration page in one insert, de-duplicated before the conflict
status: proposed
approved: no
owner: persistence
depends_on:
  - Spec-027
  - Spec-031
paths:
  - src/repositories/postgres.ts
  - src/repositories/database.ts
---

# Spec-037: Store a hydration page in one insert, de-duplicated before the conflict

## Problem

`PostgresCommentRepository.upsertMany` stores a hydrated page one row at a time.
The body is a `for` loop that awaits a single-row `insert` per observation
(`for (const item of observed) await upsertComment(tx, context, item)`), then
reads the whole batch back in one query. A provider page is requested at
`PROVIDER_PAGE_LIMIT = 100` (`src/comments/comment-service.ts`), so a cold post
completing its snapshot issues up to 100 sequential round trips plus the
read-back — up to 101 statements inside one transaction — where one insert would
do.

Each statement is bounded (`statement_timeout`/`query_timeout` are 10s in
`src/repositories/database.ts`, and `DATABASE_CALL_BUDGET_MS` bounds one call at
15s), but the transaction that runs a hundred of them in sequence is bounded by
nothing but their sum, and the read that triggered it is answered under the
~30s HTTP request timeout the hydration join-wait is derived against. The cost
is latency and connection-hold time proportional to page size, on the hottest
path this service has — the first burst of readers on a popular post
(Spec-019). The principal-review board raised it as a P1 and asked whether a
set-based upsert is worth it at these page sizes; at 100 rows per page, it is.

The rewrite cannot be a naive multi-row `INSERT ... ON CONFLICT DO UPDATE`. The
conflict target is `unique (social_account_id, external_comment_id)` (migration
001), and every observation in a batch shares one connection, so the effective
in-batch key is `externalId`. If a provider page repeats a comment — which a
newest-first, paginating provider can do at a page boundary — two rows in the
same statement carry the same conflict key, and PostgreSQL aborts the whole
command with SQLSTATE `21000` (`cardinality_violation`): *"ON CONFLICT DO UPDATE
command cannot affect row a second time."* The row-by-row loop never hits this,
because each repeated key is a separate statement that conflicts with the row
the previous one just wrote. So the set-based form needs an explicit in-batch
de-duplication step that the loop got for free.

## Context and assumptions

- `upsertMany` is the hydration upsert. Its conflict clause deliberately
  overwrites the body (`do update set body = excluded.body, ...`) because
  hydration is reconciling with the provider and a conflict means the comment
  was edited (Spec-027, and the `'refreshes a comment the provider reports as
  edited'` integration test). This is the opposite of the reply path's
  `storePublishedReply`, which inserts `on conflict ... do nothing` so a publish
  can never write over a customer's own comment. Spec-027 split these two on
  purpose; this spec must not re-merge them or change which one overwrites.
- The current conflict clause updates exactly `body`, `author_display_name`,
  `external_parent_comment_id`, `updated_at`, and `last_seen_at = now()`. It
  leaves `author_external_id`, `published_at`, and the identity/ownership
  columns (`id`, `account_id`, `post_id`, `social_account_id`) untouched on
  conflict. That column set is behaviour, not incidental, and is preserved
  verbatim.
- A batch is single-post and single-connection by the caller contract. The
  read-back already relies on this — it scopes to `observed[0].postId`'s social
  account (Spec-024) — and `CommentService.hydrate` only ever passes one
  provider page for one post. This spec keeps that assumption; it does not widen
  `upsertMany` to mixed-post batches.
- The only production caller, `CommentService.hydrate`, ignores the return value
  (`if (page.items.length > 0) await this.comments.upsertMany(context, page.items)`).
  The `CommentRepository.upsertMany` contract already declares return order and
  cardinality unspecified and tells callers to match on `externalId`. So a
  change to how many rows the call returns for a duplicated batch is within the
  existing contract; today the SQL read-back already returns distinct rows while
  the in-memory adapter returns one per input, and this spec does not change
  either.
- Keeping the *last* occurrence of a repeated `externalId` is the tie-break that
  matches current behaviour on both adapters: the row-by-row `do update set body
  = excluded.body` leaves the last write standing, and the in-memory `store`
  reuses the assigned UUID and overwrites with the later observation. Keeping the
  first occurrence would diverge from both.

## Scope

In scope, `src/repositories/postgres.ts`:

1. Replace the per-item loop in `upsertMany` with a single multi-row
   `INSERT ... SELECT ... FROM posts ... ON CONFLICT (social_account_id,
   external_comment_id) DO UPDATE SET ... RETURNING id`, resolving each row's
   `post_id`/`social_account_id` by joining the input rows to `posts` on
   `(post_id, account_id)` exactly as the single-row insert does today.
2. De-duplicate the observations by `externalId` before building the insert,
   keeping the last occurrence of each key, so no single statement touches one
   conflict key twice.
3. Keep the conflict clause identical to today's, column for column, including
   that the body is overwritten on conflict.
4. Preserve `POST_NOT_FOUND` (404) with a full rollback when the batch names a
   post the tenant does not own. With `DO UPDATE`, every distinct requested key
   whose post exists returns a row (inserted or updated), so a returned-row
   count below the distinct-key count means at least one post was missing —
   which raises the same error the loop raises today, and the enclosing
   transaction rolls the whole call back.
5. Leave the read-back query, its `external_comment_id = any($2::text[])`
   predicate, and its connection scoping unchanged. Remove the now-unused
   module-local `upsertComment` function.

`src/repositories/database.ts` is claimed by this spec's paths. The rewrite fits
the existing `SqlSession.query(text, values)` port unchanged — array parameters
already cross it (`any($2::text[])`), so the multi-row insert can bind parallel
typed arrays or generated placeholder tuples without a port change. This file is
touched only if the implementer references `DATABASE_CALL_BUDGET_MS` in a comment
or adds a narrowly-scoped array-binding helper at the session boundary; if
neither is used, it is left unmodified, which is acceptable.

## Contract impact

None that is externally observable. This is an internal persistence rewrite. The
`CommentRepository` interface, the `Database`/`SqlSession` port, the REST
contract in `docs/api-design.md`, the error taxonomy, and `docs/database.md` are
all unchanged. The schema and its constraints are unchanged; no migration is
added. What changes is the number and shape of statements one method issues, and
that is behind the port by design (ADR-0012). The stored result of a hydration
page — which rows exist, which body each holds, and `POST_NOT_FOUND` on a
missing post — is identical to today's.

## Out of scope

- The in-memory adapter (`src/repositories/in-memory.ts`). Its loop already
  tolerates a repeated `externalId` (it reuses the UUID and keeps the last
  observation) and never issues a single `ON CONFLICT` statement, so it cannot
  hit the cardinality violation and needs no change. It remains the parity
  reference: its last-write-wins store is what the SQL keep-last de-duplication
  matches.
- `storePublishedReply` and its `do nothing` clause (Spec-027). This spec does
  not touch the reply path.
- Widening `upsertMany` to accept batches spanning more than one post or
  connection. The caller contract forbids it and the read-back assumes against
  it (Spec-024).
- Chunking a page larger than one statement can carry. `PROVIDER_PAGE_LIMIT` is
  100; a single insert of 100 rows with ~10 columns is well within parameter
  limits, so no batching layer is introduced.
- The unrelated open items in the same `tasks.md` bullet — `reply_operations`
  index ordering and `posts.account_id` — which are already closed by Spec-031
  and migration 008.

## Acceptance criteria

1. `upsertMany` issues one `INSERT ... ON CONFLICT DO UPDATE` for the whole page
   plus the existing single read-back — two round trips, constant in page size,
   down from `N + 1` (up to 101 at `PROVIDER_PAGE_LIMIT = 100`).
2. Before the insert, the batch is de-duplicated by `externalId`, keeping the
   last occurrence, so no statement touches one conflict key twice.
3. The `ON CONFLICT DO UPDATE` clause is unchanged from today: `body`,
   `author_display_name`, `external_parent_comment_id`, `updated_at`, and
   `last_seen_at = now()` are set; the body is still overwritten on conflict;
   `author_external_id`, `published_at`, and the identity/ownership columns are
   still left untouched.
4. A batch naming a post the tenant does not own still raises `POST_NOT_FOUND`
   (404) and rolls the whole call back; nothing is committed.
5. The read-back query and its connection scoping (Spec-024) are unchanged, and
   the module-local `upsertComment` is removed.
6. The `Database`/`SqlSession` interface and the in-memory adapter are unchanged.

## Verification plan

The existing integration coverage in
`tests/repositories/postgres.integration.test.ts` must stay green, unmodified,
and pins the conflict semantics and the rollback behaviour this rewrite must
preserve:

- `'refreshes a comment the provider reports as edited'` — two separate
  `upsertMany` calls with one `externalId`, the second carrying an edited body,
  author, and `updatedAt`; asserts the same row id and the new values, durable
  under `findById`. This proves the `DO UPDATE` still merges a later observation
  across calls (de-duplication against already-stored rows). Spec-020 already
  demonstrates a killing mutation for it: removing the `do update set` clause
  turns it red.
- `'rolls a failed batch back rather than committing its prefix'` — a batch whose
  second item names another tenant's post rejects, and the good row is absent
  afterwards. This proves the count-based `POST_NOT_FOUND` detection still
  rejects and rolls back.
- `'returns every stored comment of a batch, matched by external id not
  position'` — a three-item distinct batch, each represented once and matched by
  `externalId`. This proves the single insert stores the whole page.

Add one test for the case the rewrite introduces: a page that repeats one
`externalId` twice with two different bodies. It must resolve (not raise), store
exactly one row for that key, and that row's body must be the second (last)
occurrence's — verified via `findById`/`findReplyByExternalId`, since the
returned array's cardinality is unspecified.

**Named failing mutation — de-duplication is load-bearing.** Delete the in-batch
de-duplication step and feed the raw `observed` list into the multi-row
`INSERT ... ON CONFLICT (social_account_id, external_comment_id) DO UPDATE`.
Against the new duplicate-page test, PostgreSQL aborts the statement with
SQLSTATE `21000` (`cardinality_violation`), the transaction rolls back, and
`upsertMany` rejects — so the test, which expects the call to resolve and store
one row, turns red. This is exactly the failure the `tasks.md` note predicts and
is why the de-duplication must precede the insert.

**Second named mutation — the tie-break is load-bearing.** Change the
de-duplication to keep the *first* occurrence instead of the last. The new
test's body assertion turns red, because the surviving row now holds the first
body rather than the second. This pins keep-last as the rule that matches both
the row-by-row `do update set body = excluded.body` and the in-memory
last-write-wins store.

Together these show the set-based path de-duplicates correctly in both senses it
must: within a page (the new test and its first mutation) and against rows a
prior call already stored (the `'refreshes ...'` test). The performance goal —
one insert round trip regardless of page size — is a structural property of the
rewritten method rather than a timing assertion, and needs no flaky benchmark to
verify; the statement count is visible in the method itself.

## Open decisions

1. **Tie-break on a repeated key: keep last.** Proposed, because it matches both
   adapters today. The alternative worth naming is rejecting a duplicate-within-a-page
   as an internal fault; that is stricter than current behaviour and would fail
   a page a real provider can legitimately return at a boundary, so it is not
   proposed.
2. **Parameter-binding technique** (parallel typed arrays via `unnest` versus
   generated placeholder tuples). Proposed: left to implementation — both fit the
   existing port and neither changes `database.ts`. Called out only so a reviewer
   knows no port change is implied either way.

The exact human decision required: approve flipping `approved: no` to
`approved: yes` for an internal rewrite that (a) keeps the hydration conflict
clause overwrite-on-conflict, column for column, and (b) de-duplicates a page by
`externalId` keeping the last occurrence before a single `INSERT ... ON CONFLICT
DO UPDATE`. Nothing is implemented until that flip.
