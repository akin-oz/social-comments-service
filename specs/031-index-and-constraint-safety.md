---
spec: 031
title: Index the lookups that exist, and stop writing blocking constraint changes
status: implemented
approved: yes
owner: platform-integration
paths:
  - migrations/**
---

# Spec-031: Index the lookups that exist, and stop writing blocking constraint changes

> **Process note.** Implemented in the same session this was written, as a
> deliberate exception by the maintainer.

## Problem

Raised as P0-3 and P1 by the `principal-review` board. Nothing here is visible
today, and all of it is what the deferred retention work would hit first.

1. **`reply_operations_comment_idx (account_id, comment_id)` is ordered backwards
   for the key it serves.** The index exists for the foreign key on `comment_id`
   alone, and PostgreSQL's referential-integrity check runs
   `where comment_id = $1` with no account predicate — it is enforcing a
   constraint, not answering a tenant's query. A composite index is only usable
   for a lookup constraining its leading column, so the check fell back to a
   sequential scan of `reply_operations` on every comment delete.
2. **`posts.account_id` has no supporting index** despite a cascading foreign
   key, so deleting a tenant sequentially scans `posts`. The other three
   cascading keys got this treatment in migration 006; this one was missed.
3. **Migrations 006 and 007 add constraints without `NOT VALID`.** PostgreSQL
   then validates by scanning the whole referencing table under
   `ACCESS EXCLUSIVE`, blocking every read and write — including `listByPost`
   and `upsertMany` — for the duration. Safe when it ran, because the tables
   were nearly empty. Unsafe as the template for the next constraint change on
   `comments`, the one table with unbounded growth.

## Scope

### In scope

1. Migration 008 reorders the index to `(comment_id, account_id)`, which serves
   the RI check and still serves any `(account_id, comment_id)` lookup.
2. Migration 008 adds `posts_account_idx`.
3. Migration 008 records the convention every later constraint change follows:
   `ADD … NOT VALID`, then `VALIDATE CONSTRAINT` in a separate statement. The
   first takes a brief lock and skips the scan; the second takes only
   `SHARE UPDATE EXCLUSIVE`, which readers and writers pass through.

### Out of scope

- `CREATE INDEX CONCURRENTLY`. `src/migrate.ts` wraps each file in one
  transaction, which is what makes a failed migration leave nothing behind, and
  concurrent index builds cannot run inside a transaction block. Both indexes
  here are small enough for a plain build; an index on `comments` at scale needs
  a runner that can opt out of the wrapping transaction, recorded in
  [roadmap.md](../docs/roadmap.md).
- Retroactively rewriting migrations 006 and 007. They have run; rewriting
  applied migrations is worse than the problem.

## Verification

Migration applied and re-applied against a scratch PostgreSQL 16; the second run
reports the schema already up to date. Both indexes confirmed present.
