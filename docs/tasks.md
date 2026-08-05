# Task tracker

This is the implementation backlog for the assignment. The roadmap explains milestone outcomes; this file tracks the next concrete slices of work.

## Status legend

- `[ ]` Planned
- `[-]` In progress
- `[x]` Complete

## Initialization

- [x] Create pnpm/TypeScript/Fastify/Vitest/ESLint/Prettier project configuration.
- [x] Document architecture, assumptions, API design, database model, and roadmap.
- [x] Add ADR placeholder and pull request quality checklist.
- [x] Add contract-only source placeholders with no business logic.
- [x] Generate and commit the dependency lockfile after the package manager is available.

## Domain and integration design

- [x] Finalize normalized domain types and typed error taxonomy.
- [x] Define provider capability matrix.
- [x] Define account, post, and authorization context contracts.
- [x] Decide whether local reads are cache-first or provider-first for each operation.

## Implementation

- [x] Implement the adaptive provider adapter behind the platform contract.
- [x] Implement persistence repository contracts, an in-memory adapter, and PostgreSQL migration.
- [x] Implement application use cases.
- [x] Implement Fastify schemas, routes, and error mapping.
- [x] Add idempotency storage and retry policy.

## Verification and delivery

- [x] Add unit, contract, integration, and API tests.
- [x] Add structured logging and request correlation (ADR-0011: logger port, `event` names, `RequestContext`, redaction, metrics bound to the logger).
- [x] Document operational limits, retention, and failure recovery.
- [x] Tighten CI to use `pnpm install --frozen-lockfile`.

## Milestone 9: Provider-backed reads and core gaps

### Specification and design

- [x] Draft Spec 008: Provider-backed comment reads with cache-miss and staleness semantics.
- [x] Draft ADR: Internal UUID identity mapping at adapter boundaries (uuid ← → platform:externalId).
- [x] Draft Spec 009: Keyset pagination using (post_id, published_at, id) index, replace offset encoding.
- [x] Draft Spec 010: Reply-path reliability — concurrent idempotency race handling, failure-code alignment, provider timeouts and Retry-After awareness.

### Implementation

- [x] Implement provider-backed reads in CommentService: hydrate the snapshot on a cache miss and serve later requests locally.
- [x] Fix adapter identifier mapping: derive internal UUIDs, send the provider its own identifiers.
- [x] Fix Postgres upsert: store provider identifiers in their own columns; derive the parent identity on read.
- [x] Implement keyset cursor encoding/decoding shared by both repositories.
- [x] Add provider timeouts and rate-limit-aware retry (honour Retry-After, surface guidance beyond the budget).
- [x] Implement concurrent idempotency-key protection (claim on insert; only the claimant calls the provider).
- [x] Align failure-code capture: store taxonomy codes, not error names.
- [x] Implement fixture provider (deterministic ProviderClient) and register it in createDemoApplication.
- [x] Serialize API responses explicitly so provider identifiers cannot leak.

### Testing

- [x] Test cursor pagination: keyset ordering, stability when an earlier comment arrives, boundary cases.
- [x] Test provider-backed read path: empty snapshot hydrates, repeat request serves locally.
- [x] Test reply path: publish, replay, key reuse, terminal failure, unsupported capability.
- [x] Test provider call policy: timeout, transient retry, rate-limit guidance inside and beyond budget.
- [x] Test fixture provider end to end through the API routes.
- [x] Add a PostgreSQL integration harness via DATABASE_URL, with Compose locally and a CI service container (Spec-012).
- [x] Test Postgres uniqueness constraints: comment deduplication and idempotency-key claim.
- [x] Test RLS across two tenants, including a query with the account predicate removed.

The PostgreSQL repository is now exercised against a real database. Running it surfaced three defects that had been invisible: `posts` has no `platform` column so every comment query referenced a column that does not exist, reply-operation rows were cast rather than mapped so every snake_case field read as `undefined` and broke idempotent retries, and neither the Docker build nor `docker compose` had ever succeeded.

## Raised by provider research

Reading the vendor documentation surfaced three items that need a decision before a live adapter is written. Each changes an approved document, so each needs an ADR or spec rather than a quiet edit.

- [x] **Comment identity needed correcting.** Resolved by ADR-0013, which supersedes ADR-0010 and assigns identity rather than folding the social account into a derivation.
- [x] **Assumption A-005 does not hold for X.** Closed by [ADR-0014](decisions/0014-reply-depth.md). One level is now stated as this service's normalisation rather than a claim about platforms, and it is enforced: replying to a comment that is itself a reply is refused with `REPLY_DEPTH_EXCEEDED` (422). Neutralising the check turns two tests red. Instagram's silent reattachment of a reply-to-a-reply remains unmodelled and is recorded in the capability matrix.
- [x] **Spec-013 persisted provider cursors, which Meta documents against.** Spec-014 keeps the stored continuation but treats it as best-effort: a rejected cursor restarts the stream, and the public cursor no longer carries a provider token at all.

## Raised by the delivery-readiness review

The repository's own read-only review board swept it before submission. Documentation findings are fixed; the rest are recorded here because they touch code, tests, or migrations and so need a specification under this repository's gate.

The review's method is worth stating: it re-applied real historical defects and confirmed the suite stayed green. That is evidence, not opinion.

### Test gaps — the suite would not catch these regressions

- [x] **The row-cast defect shipped green.** Closed by the PostgreSQL composition test; re-applying the defect now turns the suite red.
- [x] **Nothing ran `CommentService` against PostgreSQL.** Added `tests/api/postgres-composition.integration.test.ts`, which drives routes, service, and repositories against a real database: hydration, cursor round-trip, idempotent replay, key reuse, HTTP-level cross-tenant refusal, and forged-cursor mapping. Re-applying the historical row-cast defect now turns it red, where previously the whole suite stayed green. This also closes the missing HTTP-level cross-tenant case, which the single-tenant demo composition could not express.
- [ ] **Five surviving mutations** — the HTTP-level cross-tenant case is closed. Specified as [Spec-020](../specs/020-test-integrity.md).: no HTTP-level cross-tenant test (the demo composition has one tenant, so the case is inexpressible); `p.status = 'published'` is mutable to `is not null`; the upsert's `do update set` clause can be gutted; the parent-derivation branch is untested and is the one path that could leak a raw provider identifier; `requireCapability(provider, 'list_comments')` is deletable; platform predicates are neutralizable because every fixture is `instagram`.
- [ ] **Weak assertions** — specified as [Spec-020](../specs/020-test-integrity.md): the production retry branch never runs; the Spec-013 hydration trigger is mutable to the exact form the code comment explains is wrong; `internalCommentId` has no golden vector, so tests compute expectations with the function under test; `Retry-After` is never asserted; `passWithNoTests: true` with no coverage gate means a broken glob yields a green build with zero tests.

### Correctness and security

- [x] **A forged cursor produced a 500.** Fixed: a malformed identifier is treated as absent, and the provider token is gone from the public cursor. Whether cursors should be signed remains open and is noted in [Spec-017](../specs/017-client-actionable-errors.md). `docs/api-design.md` says a cursor the service did not issue is rejected; the codec accepts any well-formed base64 JSON, and the decoded keyset reaches PostgreSQL as unvalidated `::timestamptz`/`::uuid` casts, producing a 500 and an error-level log per request. No cross-tenant read is possible — the predicate and RLS both hold. Relatedly, the provider-cursor field in the client cursor is now write-only, since the service reads persisted snapshot state instead, so it leaks upstream tokens for no benefit. Dropping that field and validating the cursor fixes both.
- [ ] **The `comments_app` role's attributes are never pinned.** Specified as [Spec-018](../specs/018-isolation-and-schema-completeness.md). Migration 002 skips role creation if the name already exists, so a pre-existing `comments_app` holding `SUPERUSER` or `BYPASSRLS` silently defeats every policy. An unconditional `alter role … nosuperuser nobypassrls` plus a `pg_roles` assertion in the integration test closes it.
- [x] **Production failed open to the in-memory demo.** A missing `DATABASE_URL` under `NODE_ENV=production` now stops the process instead of starting a service with no row-level security behind it. A missing or misspelled `DATABASE_URL` under `NODE_ENV=production` starts the demo composition, passes `/health`, and honours any `X-Account-Id` with no row-level security behind it. It should refuse to start.
- [x] **No UUID validation on `X-Account-Id` or path parameters.** A malformed account context is now `401` and a malformed identifier is `404`, verified against PostgreSQL where both previously reached a `::uuid` cast and produced a 500., so a malformed identifier yields 500 where the contract says 404.
- [x] **The unhandled-error log recorded an unprojected error object.** Only the name, message, and stack are logged now, so a driver error cannot carry `detail` or `internalQuery` into the log., so a `pg` `DatabaseError` can carry `detail`, `internalQuery`, and constraint values into logs — the one exception to the otherwise-enforced rule that content never reaches a log record.
- [ ] **`accounts` has no row-level security** — specified as [Spec-018](../specs/018-isolation-and-schema-completeness.md). while `comments_app` holds `select` on it. No live query touches it, but the defence-in-depth story stops one table short.
- [x] **The migration runner silently no-opped without `APP_DATABASE_PASSWORD`.** It now refuses, rather than leaving a passwordless login role., leaving a passwordless `LOGIN` role; it should refuse like it does for a missing `DATABASE_URL`.
- [ ] **The in-memory adapter scopes tenants by string-prefix match** — specified as [Spec-018](../specs/018-isolation-and-schema-completeness.md)., which is presented as a first-class alternative with no database policy behind it.

### Smaller

- [x] The Docker image shipped compiled tests; `pnpm build` now uses a build-only project and the image contains `dist/src` alone.
- [x] The README now says the list request must run first, because a reply resolves against the stored snapshot.
- [x] `request_fingerprint` stored the reply body in plain text; it is now a SHA-256 digest, verified by a test asserting the body is absent from the audit trail.
- [x] `src/api/schemas.ts` no longer contradicts itself on provider identifiers: the author identifier is documented as the one provider-issued value the contract exposes.
- [ ] `@akinlabs/ai-engineering` is pinned to a mutable git tag, so a clean install is not reproducible across time.

## Raised by the principal-review board

The board judged the design rather than its compliance. Three of its blocking findings were reproduced by execution, not inferred. The first is fixed; the rest are recorded because each needs a specification.

- [x] **A timed-out reply published up to three duplicates for one idempotency key.** `withTimeout` rejects without cancelling the in-flight request, the resulting error was classified retriable, and reads and writes shared one retry policy — so the service automatically performed the exact duplication the idempotency design exists to prevent. Reproduced at three publications for one key. Fixed under Spec-010: writes now use a policy that never replays an ambiguous failure, while rate limits are still retried because refusal proves the request was not accepted. The regression test asserted three before the fix.
- [x] **The read path made most of a post's comments unreachable.** Fixed under Spec-014: starting a pagination run completes the snapshot, bounded at twenty provider calls, so the run pages something stable. Reproduced at two of six comments returned; now six of six. Specified as [Spec-014](../specs/014-read-path-completeness.md), awaiting approval; it reverses Spec-013's one-page-per-request decision, which is what makes this reachable. Hydration triggers on an under-filled local page while pagination advances a keyset — two different orderings. With a newest-first provider, which is the default for Meta, X, and YouTube, later provider results land behind the caller's cursor and hydration never fires again. Reproduced at four of six comments unreachable by any call sequence. Hydration should be driven by snapshot completeness and loop within a request until the window is satisfiable.
- [x] **Identity was derived at platform grain while the schema enforced it at social-account grain.** Fixed under ADR-0013: the database assigns identity, an adapter produces an `ObservedComment` that has none, and two tenants observing one provider comment now get two rows. Specified as [ADR-0013](decisions/0013-assigned-comment-identity.md), awaiting acceptance; it supersedes ADR-0010 by assigning identity rather than deriving it. Cheap now, a full-table migration plus invalidated cursors once a live adapter exists. Two tenants connecting the same Instagram account derive the same UUID; the second insert raises an unhandled unique violation, rolls back the hydration batch, and row-level security hides the colliding row so the failure cannot be diagnosed from the affected tenant. The board's recommendation is to stop deriving identity: default to `gen_random_uuid()`, return the real row identifiers from the upsert, and delete the derivation. Cheap now; a full-table migration plus invalidated cursors after a live adapter exists.
- [x] **`provider_exhausted` was a one-way latch.** Fixed under Spec-014: completion is timestamped and re-read once it ages past `SNAPSHOT_LIFETIME_SECONDS`, and the response carries `snapshot.syncedAt` so freshness is read rather than assumed. Covered by [Spec-014](../specs/014-read-path-completeness.md), together with the missing freshness field and the unhandled cursor rejection. Once a post is read through, comments posted afterwards are invisible indefinitely with no error, and no response field lets a client reason about staleness. Exhaustion needs a lifetime, and the response needs a snapshot timestamp.
- [x] **A successful publish could be recorded as failed.** Fixed: only a provider failure marks an operation failed. The `unknown` terminal state that would say so precisely is specified in Spec-015. The upsert and completion sit inside the same `try` as the provider call, so a database failure after a confirmed publish routes to `fail()`, and the client is told to retry with a new key. There is also no `unknown` terminal state, so an ambiguous outcome is indistinguishable from a clean rejection.
- [x] **A successful publish could be recorded as failed.** Fixed under Spec-010: only a provider failure can mark the operation failed. A storage failure after a confirmed publish now leaves the operation pending and logs `comments.reply.orphaned`, so a later request is told the work is in flight rather than invited to repeat it. The regression test asserted `failed` before the fix.
- [x] **The in-memory claim granted one key to two concurrent callers.** Fixed under Spec-010: the claim now tests and sets against a synchronous key index with nothing awaited in between, which is what the unique constraint does in PostgreSQL. Reproduced at `claimed: true, true` before the fix.
- [ ] **A crash between claim and completion poisons the idempotency key permanently** — specified as [Spec-015](../specs/015-reply-operation-lifecycle.md), together with the missing `unknown` terminal state., leaving a pending row only the dead process could resolve. A rolling deploy mid-request is enough. The claim needs a lease.
- [x] **The in-memory claim was check-then-act across an `await`.** Fixed with a synchronous key index; reproduced at `claimed: true, true` before the fix. and grants one key to two concurrent callers; the existing concurrency test issues its callers sequentially, so it passes. The PostgreSQL implementation is correct.
- [x] **The provider port has no room for a credential.** Closed by [Spec-016](../specs/016-provider-authorization-context.md). `PublishedPost` now carries the `SocialConnection` it was published through, the PostgreSQL repository selects it from the `social_accounts` join that was already there, and both provider operations receive it. One adapter instance per platform still serves every tenant; the connection travels with the call, and the adapter refuses a call that arrives without one or with another platform's. The reference names a secret and never reaches a response, a log, or an error message.
- [ ] **`IDEMPOTENCY_CONFLICT` carries several meanings a client can only distinguish by reading prose** — specified as [Spec-017](../specs/017-client-actionable-errors.md). The unenforced reply-depth invariant is [ADR-0014](decisions/0014-reply-depth.md).

Cursor rejection handling, dropping the provider token from the public cursor, exercising the PostgreSQL composition, and bounding every database call and the HTTP server are done. Two remain and are specified: provider load amplification is [Spec-019](../specs/019-provider-load-protection.md), and the model's inability to represent a reply whose resolved parent differs from the requested one — which Instagram does silently — is called out in [ADR-0014](decisions/0014-reply-depth.md) as belonging to the domain-model work rather than being solved there.

## Known defects

- [x] **A fresh first-page request under-reported `hasMore` after a partial hydration.** A caller that restarted pagination was told a post held fewer comments than it did, because hydration fired only on an empty page and `hasMore` was derived from whatever cursor the caller happened to supply. Fixed under Spec-013: a post now records how much of its provider stream has been read, hydration fires on an incomplete page while the stream is not exhausted, and `hasMore` comes from snapshot completeness. Verified against PostgreSQL, and the regression tests fail against the previous logic.

## Milestone 10: Submission readiness

### Documentation

- [x] Replace README AI usage placeholder with honest account of tool contributions and review process.
- [x] Add a "Design decisions" section to the README: seven decisions with their costs, what was deliberately not built, and links to the governing ADRs and specs.
- [x] Research and populate the provider capability matrix from official vendor documentation for YouTube, Facebook, Instagram, LinkedIn, and X, with citations.
- [x] Verify api-design.md alignment: limit defaults (25), max (100), header-only auth, error code mappings (500 → INTERNAL_ERROR).

### OpenAPI and contracts

- [x] Generate OpenAPI from the Fastify route schemas and serve Swagger UI (Spec-011).
- [x] Commit the generated document and fail CI on drift.
- [x] Clarify in api-design.md that authentication is the X-Account-Id header only.

### Final checks

- [x] Run `pnpm dev` and curl both endpoints against the fixture provider, and `docker compose up` against PostgreSQL.
- [x] Confirm every CI step passes locally: typecheck, lint, format, `ai:validate`, tests, and the OpenAPI drift check.
- [ ] Confirm CI passes on GitHub Actions. The workflow now provisions a PostgreSQL service container and runs migrate and seed; those steps have only been exercised locally.
- [x] Review commit trailer enforcement. Every commit carries a `Spec: NNN` or `ADR: NNNN` trailer except three from before the gate existed: the initial scaffold, the commit that introduced the governance tooling itself, and one CI version bump.
