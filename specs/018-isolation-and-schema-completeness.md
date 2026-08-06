---
spec: 018
title: Finish tenant isolation and close the schema gaps behind it
status: accepted
approved: yes
owner: platform and operations
depends_on:
  - ADR-0012
  - Spec-012
---

# Spec-018: Finish tenant isolation and close the schema gaps behind it

## Problem / gap

Tenant isolation is real and proven, but the security reviewer found the perimeter is not closed all the way round, and the data-model reviewer found the schema is missing constraints the application already assumes.

**The service role's attributes are never pinned.** Migration 002 creates `comments_app` only if the name is free. A pre-existing role of that name holding `SUPERUSER` or `BYPASSRLS` silently defeats every policy, and the migration reports success. The whole isolation story rests on that role being ordinary, and nothing asserts it.

**`accounts` has no row-level security** while `comments_app` holds `select` on it. No live query touches the table, so nothing leaks today, but the defence-in-depth argument stops one table short of the tenants it protects.

**The in-memory adapter scopes tenants by string-prefix match** on a composite key. It is presented as a first-class alternative composition with no database policy behind it, and prefix matching is a weaker check than it looks.

**Schema gaps the application compensates for**: no check constraint on `platform`, though the domain has a closed set; unindexed foreign keys on `reply_operations`; and no explicit `ON DELETE` behaviour anywhere, so deletion semantics are whatever PostgreSQL defaults to rather than a decision anyone made.

## Context and assumptions

- A-011 makes tenant isolation mandatory; ADR-0012 established the role separation and the transaction-local tenant context.
- The predicate-removed test proves the policies enforce for `comments` and `posts` today.
- Retention and deletion are an open question already recorded in the operations guide, which is why `ON DELETE` is a decision rather than an oversight to fix silently.
- No production data exists, so constraints can be added without a backfill.

## Scope

### In scope

1. **Pin the service role's attributes unconditionally**: `nosuperuser`, `nobypassrls`, `nocreatedb`, `nocreaterole`, applied whether or not the role already existed.
2. **Assert the attributes in the integration suite** by reading `pg_roles`, so a role that has drifted fails a test rather than silently disabling isolation.
3. **Enable row-level security on `accounts`**, so a tenant can see only its own row and the perimeter covers every table `comments_app` can read.
4. **Extend the predicate-removed proof** beyond `comments` and `posts` to every tenant-scoped table, including `reply_operations` and `social_accounts`.
5. **Replace prefix-matched tenant scoping** in the in-memory adapter with a structure that cannot match across a delimiter.
6. **Add the missing constraints**: a check on `platform`, indexes on the `reply_operations` foreign keys, and explicit `ON DELETE` behaviour chosen deliberately.

### Out of scope

- Retention and deletion automation, still an open operational decision.
- Changing the tenant-context mechanism, which ADR-0012 settled.
- Encrypting or tokenising the credential reference.

## Contract impact

### Persistence

A migration pins the role, enables and forces row-level security on `accounts` with a policy keyed on its own identifier, adds the platform check and the missing indexes, and states `ON DELETE` on the foreign keys.

`ON DELETE` is the one with product meaning. Cascading from a post to its comments matches the snapshot model; restricting protects an audit trail that may need to outlive the post it refers to. `reply_operations` is the harder case, because it is the record of something published under a customer's name.

### Application

The in-memory adapter's internal keying changes. No behaviour visible outside it changes, and the same tests must pass.

## Acceptance criteria

1. Running migrations against a database where `comments_app` already exists with `SUPERUSER` leaves it with neither `SUPERUSER` nor `BYPASSRLS`.
2. An integration test reads `pg_roles` and fails if the service role holds either attribute.
3. A tenant querying `accounts` under its own context sees exactly one row: its own.
4. The predicate-removed proof covers `comments`, `posts`, `social_accounts`, and `reply_operations`.
5. The in-memory adapter cannot match one tenant's rows from another tenant's context, including where an account identifier contains the key delimiter.
6. `platform` rejects a value outside the supported set at the database level.
7. Every foreign key on `reply_operations` is indexed, and every foreign key states its `ON DELETE` behaviour.
8. Existing isolation tests pass unchanged.

## Verification plan

- A migration test that creates a superuser `comments_app` first, migrates, and asserts the attributes were corrected.
- A `pg_roles` assertion in the integration suite.
- The predicate-removed query extended to the two additional tables.
- An in-memory test using an account identifier containing a colon, asserting no cross-tenant match.
- A test asserting an unsupported platform value is rejected by the database, not only by validation.
- `EXPLAIN` on the reply-operation lookups confirming the new indexes are used.

## Open decisions

1. **`ON DELETE` for comments when a post is deleted.** Proposed: cascade, because a comment is a snapshot of that post's conversation and has no meaning without it.
2. **`ON DELETE` for reply operations when a comment is deleted.** Proposed: restrict. The row records something published under a customer's name, and losing it silently on a cascade is worse than an explicit failure. This is a genuine trade against the previous decision's tidiness.
3. **Whether `accounts` needs row-level security at all**, given no query reads it. Proposed: yes. The argument for defence in depth is that the next query is written by someone who assumes the perimeter is complete.
4. **Whether to add `nologin` to any role**, or leave login rights as they are. Proposed: leave them; the migration role needs to log in and the service role does too.

## Human decision required

Approval requires accepting:

1. A migration that alters an existing role's attributes, which changes the privileges of a role an operator may have created deliberately.
2. The `ON DELETE` choices in open decisions 1 and 2, which fix deletion semantics that are currently undefined.
3. Row-level security on `accounts`, adding a policy to a table nothing currently queries.

## Implementation outcome

Acceptance criterion 1 — "running migrations against a database where `comments_app` already exists with `SUPERUSER` leaves it with neither `SUPERUSER` nor `BYPASSRLS`" — holds on a cluster where the migrating role is a superuser, which is the local and CI case. It does **not** hold literally on managed PostgreSQL, and a second delivery-readiness sweep showed why: clearing those attributes requires `SUPERUSER`, which the managed owner role deliberately is not, so the unconditional `alter role` aborted the migration exactly where ADR-0012 says the role separation matters most.

Migration 006 was changed to preserve the _safety property_ the criterion protects while relaxing its _mechanism_: the clear runs when it can and warns when it cannot, and an unconditional assertion — which any role can run, since it only reads `pg_roles` — then refuses to complete the migration if `comments_app` is still elevated. So on every deployment the migration either makes the role ordinary or fails loudly; it never completes with an elevated service role. The role is created without those attributes in the first place (migration 002), so a correctly provisioned managed deployment passes silently. Recorded here rather than silently diverging, in this repository's established practice.
