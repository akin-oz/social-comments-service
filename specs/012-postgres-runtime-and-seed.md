---
spec: 012
title: Run the service on PostgreSQL with verified tenant isolation
status: accepted
approved: yes
owner: platform and operations
depends_on:
  - ADR-0012
  - ADR-0009
paths:
  - src/migrate.ts
  - src/seed.ts
  - src/seed-data.ts
  - src/repositories/database.ts
  - migrations/**
  - docker-compose.yml
  - Dockerfile
---

# Spec-012: Run the service on PostgreSQL with verified tenant isolation

## Problem / gap

The repository claims PostgreSQL persistence with row-level security. Neither is real.

`src/repositories/postgres.ts` is written against the approved schema and **no code path constructs it**. There is no database client, no connection configuration, no migration runner, and no composition that selects it, so the SQL in that file has never executed. `docs/roadmap.md` already records it as unverified.

Row-level security is worse than unconfigured, as recorded in ADR-0012: nothing sets `app.account_id`, no transaction boundary exists to hold it, and the table owner bypasses the policies. A reader inspecting the database would see policies enabled and conclude tenants are isolated.

There is also no way to start a database locally. The `Dockerfile` builds the service image, but nothing runs PostgreSQL alongside it, so a reviewer cannot exercise the persistence path at all, and no seed data exists to make an empty database useful.

## Context and assumptions

- ADR-0012 fixes the tenant-context boundary: a `Database` port whose `withTenant` opens a transaction and sets `app.account_id` transaction-locally.
- ADR-0009 keeps vendor selection a delivery decision; this spec provisions PostgreSQL locally and in CI only.
- A-011 makes tenant isolation mandatory.
- Docker and Compose are available locally and GitHub Actions provides service containers, so a real database is reachable in both places.
- The in-memory repositories remain the fast path for unit tests and the zero-dependency demo.

## Scope

### In scope

1. **A PostgreSQL client**: add `pg`, and implement the ADR-0012 `Database` port over a connection pool.
2. **Rewrite `src/repositories/postgres.ts`** onto that port so every query runs inside a tenant-scoped transaction.
3. **Extend the schema** with a non-owner application role and `FORCE ROW LEVEL SECURITY` on the four tenant tables, as a new migration rather than an edit to `001`.
4. **A migration runner** (`pnpm migrate`): applies files from `migrations/` in order, records what it applied, and is safe to re-run. One runner per release, per ADR-0009.
5. **A seed** (`pnpm seed`): two accounts, their social accounts, and published posts, with fixed identifiers so the demo, the README, and the RLS tests all reference the same rows. Re-running it must not duplicate data.
6. **Local orchestration** (`docker-compose.yml`): a PostgreSQL service and the application service, so `docker compose up` yields a working system.
7. **Composition selection**: `DATABASE_URL` present selects the PostgreSQL repositories; absent keeps the in-memory demo, so `pnpm dev` still needs nothing installed.
8. **Integration tests against a real database**, covering the uniqueness constraints, keyset pagination, upsert deduplication, and — the point of the exercise — that a caller scoped to one tenant cannot read another tenant's rows.
9. **CI**: run the integration suite against a PostgreSQL service container.

### Out of scope

- Managed database provisioning, backups, failover, and retention automation, all deferred by ADR-0009.
- A migration framework. An ordered runner with a tracking table is sufficient and keeps the dependency count down.
- Seeding comments. Comments arrive by provider hydration, and seeding them would fake the very path Spec-008 exists to exercise.
- Replacing the in-memory repositories.

## Contract impact

### Persistence port

`SqlExecutor` and `TransactionalSqlExecutor` are replaced by `Database` and `SqlSession` per ADR-0012. This is internal to the persistence layer; no domain, application, or API contract changes, and the repository interfaces in `src/comments/contracts.ts` are untouched.

### Schema

A second migration adds the application role, grants, and `FORCE ROW LEVEL SECURITY`. `001` is not edited: it may already have been applied somewhere, and rewriting applied migrations is how environments diverge.

### Configuration

New environment variables: `DATABASE_URL` selects persistence, and the compose file supplies credentials for local use. Absent configuration keeps today's behaviour exactly.

### Documentation

`docs/database.md` gains the role model and the ownership rule. `docs/operations.md` gains the migration and seed procedure. The README gains the Docker path alongside the existing zero-dependency one.

### Dependencies

`pg` and `@types/pg`. This is the third runtime dependency after Fastify and the swagger plugins.

## Acceptance criteria

1. `docker compose up` starts PostgreSQL and the service, and both documented operations succeed against it.
2. `pnpm migrate` applies every migration in order on an empty database, records them, and is a no-op when run twice.
3. `pnpm seed` populates two tenants with posts, and a second run leaves the data unchanged.
4. With `DATABASE_URL` set, listing comments hydrates from the provider and stores rows in PostgreSQL; a second request is served from those rows.
5. Replying stores the reply and its `reply_operations` row, and a retry with the same idempotency key returns the stored reply without a second provider call.
6. **A caller scoped to tenant A reads zero rows belonging to tenant B**, verified against a real database with the application role, for comments, posts, and reply operations.
7. Isolation survives the repository predicate being removed: a test that queries without an `account_id` predicate, under tenant A's context, still returns no tenant B rows. This is what proves RLS is doing work rather than the predicates alone.
8. The `(social_account_id, external_comment_id)` and `(account_id, idempotency_key)` constraints are exercised and hold.
9. Keyset pagination returns the same sequence from PostgreSQL as from the in-memory adapter.
10. CI runs the integration suite against a service container and fails if any of the above regress.

## Verification plan

- Integration tests connecting to a real PostgreSQL instance, skipped with a clear message when `DATABASE_URL` is absent so the default `pnpm test` stays fast and dependency-free.
- A test that connects as the application role and asserts `current_user` is not the table owner, so criterion 7 cannot pass accidentally.
- Manual: `docker compose up`, `pnpm migrate`, `pnpm seed`, then the README curl commands against the containerised service.
- CI: PostgreSQL service container, migrate, seed, run the integration suite.

## Open decisions

1. ~~**How integration tests reach a database.**~~ **Decided:** an existing instance addressed by `DATABASE_URL`, provided by Compose locally and a service container in CI. `testcontainers` was the alternative and is not adopted, so no additional dev dependency is introduced and a contributor without Docker can still run the default suite.
2. **Whether the integration suite runs by default.** Proposed: skipped unless `DATABASE_URL` is set, keeping `pnpm test` fast, with CI always setting it. The risk is that a developer without Docker never runs them.
3. **Seed shape.** Proposed: two tenants, one social account each, one published post each, no comments. Enough to demonstrate isolation and hydration without inventing provider data.
4. **Whether the application role owns nothing at all.** Proposed: migrations run as the owner, the application connects as a role with only `select, insert, update` on the tenant tables. Stricter than needed for the assignment, and the correct habit.

## Human decision required

Approval requires accepting:

1. Two new dependencies, `pg` and `@types/pg`.
2. A second migration introducing a role and ownership rules, and therefore two sets of database credentials in any deployment.
3. Replacing the persistence-layer executor interfaces per ADR-0012, which requires ADR-0012 to be accepted first.
4. ~~The integration-test strategy.~~ Settled: `DATABASE_URL` against an existing instance, per open decision 1.
