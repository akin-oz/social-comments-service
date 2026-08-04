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

- [ ] **Comment identity may need the social account folded in (ADR-0010).** Only X documents globally unique comment identifiers; the other four vendors either do not state a uniqueness scope or, in LinkedIn's case, warn that the returned URN is unreliable. The database constraint is already per social account, so only the derived UUID carries the weaker assumption.
- [ ] **Assumption A-005 does not hold for X.** Replies are one level deep on Instagram and YouTube, two on LinkedIn, and arbitrarily deep on X, which has no comment object at all. Normalising X to one level is defensible but lossy, and the assumption does not currently say so.
- [ ] **Spec-013 persists provider cursors, which Meta documents against.** Facebook and Instagram both state that cursors must not be stored, because they are invalidated when the item they point at is deleted. A stored continuation is therefore best-effort and an adapter must tolerate its rejection, most likely by restarting the stream.

## Raised by the delivery-readiness review

The repository's own read-only review board swept it before submission. Documentation findings are fixed; the rest are recorded here because they touch code, tests, or migrations and so need a specification under this repository's gate.

The review's method is worth stating: it re-applied real historical defects and confirmed the suite stayed green. That is evidence, not opinion.

### Test gaps — the suite would not catch these regressions

- [ ] **The row-cast defect ships green.** Re-applying the exact bug that `src/repositories/postgres.ts` documents as fixed leaves all tests passing. The integration test reads back only `claimed` and `operation.id`; `requestFingerprint`, `completedAt`, and six other mapped fields are never asserted.
- [x] **Nothing ran `CommentService` against PostgreSQL.** Added `tests/api/postgres-composition.integration.test.ts`, which drives routes, service, and repositories against a real database: hydration, cursor round-trip, idempotent replay, key reuse, HTTP-level cross-tenant refusal, and forged-cursor mapping. Re-applying the historical row-cast defect now turns it red, where previously the whole suite stayed green. This also closes the missing HTTP-level cross-tenant case, which the single-tenant demo composition could not express.
- [ ] ~~Nothing runs `CommentService` against PostgreSQL~~ (superseded by the line above) The integration suite drives the three repositories directly, so the wired composition — fingerprint comparison, cursor round-trip, error mapping over real rows — has never executed against a real database. One `app.inject` test through `createPostgresApplication` covering list, reply, same-key retry, and conflicting-key 409 would have caught all three historical defects.
- [ ] **Six surviving mutations in tenant and correctness paths**: no HTTP-level cross-tenant test (the demo composition has one tenant, so the case is inexpressible); `p.status = 'published'` is mutable to `is not null`; the upsert's `do update set` clause can be gutted; the parent-derivation branch is untested and is the one path that could leak a raw provider identifier; `requireCapability(provider, 'list_comments')` is deletable; platform predicates are neutralizable because every fixture is `instagram`.
- [ ] **Weak assertions**: the production retry branch never runs; the Spec-013 hydration trigger is mutable to the exact form the code comment explains is wrong; `internalCommentId` has no golden vector, so tests compute expectations with the function under test; `Retry-After` is never asserted; `passWithNoTests: true` with no coverage gate means a broken glob yields a green build with zero tests.

### Correctness and security

- [ ] **Cursor forgery: `INVALID_CURSOR` does not do what the contract promises.** `docs/api-design.md` says a cursor the service did not issue is rejected; the codec accepts any well-formed base64 JSON, and the decoded keyset reaches PostgreSQL as unvalidated `::timestamptz`/`::uuid` casts, producing a 500 and an error-level log per request. No cross-tenant read is possible — the predicate and RLS both hold. Relatedly, the provider-cursor field in the client cursor is now write-only, since the service reads persisted snapshot state instead, so it leaks upstream tokens for no benefit. Dropping that field and validating the cursor fixes both.
- [ ] **The `comments_app` role's attributes are never pinned.** Migration 002 skips role creation if the name already exists, so a pre-existing `comments_app` holding `SUPERUSER` or `BYPASSRLS` silently defeats every policy. An unconditional `alter role … nosuperuser nobypassrls` plus a `pg_roles` assertion in the integration test closes it.
- [ ] **Production fails open to the in-memory demo.** A missing or misspelled `DATABASE_URL` under `NODE_ENV=production` starts the demo composition, passes `/health`, and honours any `X-Account-Id` with no row-level security behind it. It should refuse to start.
- [ ] **No UUID validation on `X-Account-Id` or path parameters**, so a malformed identifier yields 500 where the contract says 404.
- [ ] **The unhandled-error log records an unprojected error object**, so a `pg` `DatabaseError` can carry `detail`, `internalQuery`, and constraint values into logs — the one exception to the otherwise-enforced rule that content never reaches a log record.
- [ ] **`accounts` has no row-level security** while `comments_app` holds `select` on it. No live query touches it, but the defence-in-depth story stops one table short.
- [ ] **The migration runner silently no-ops without `APP_DATABASE_PASSWORD`**, leaving a passwordless `LOGIN` role; it should refuse like it does for a missing `DATABASE_URL`.
- [ ] **The in-memory adapter scopes tenants by string-prefix match**, which is presented as a first-class alternative with no database policy behind it.

### Smaller

- [ ] The Docker image ships compiled tests, because `tsconfig.json` includes `tests/` in the build output.
- [ ] The reply `curl` in the README 404s if run standalone; the list request must run first in the same session to populate the snapshot.
- [ ] `request_fingerprint` stores the reply body in plain text; hashing it would serve the same purpose.
- [ ] `src/api/schemas.ts` contradicts itself on whether provider identifiers are exposed.
- [ ] `@akinlabs/ai-engineering` is pinned to a mutable git tag.

## Raised by the principal-review board

The board judged the design rather than its compliance. Three of its blocking findings were reproduced by execution, not inferred. The first is fixed; the rest are recorded because each needs a specification.

- [x] **A timed-out reply published up to three duplicates for one idempotency key.** `withTimeout` rejects without cancelling the in-flight request, the resulting error was classified retriable, and reads and writes shared one retry policy — so the service automatically performed the exact duplication the idempotency design exists to prevent. Reproduced at three publications for one key. Fixed under Spec-010: writes now use a policy that never replays an ambiguous failure, while rate limits are still retried because refusal proves the request was not accepted. The regression test asserted three before the fix.
- [ ] **The read path can make most of a post's comments permanently unreachable.** Specified as [Spec-014](../specs/014-read-path-completeness.md), awaiting approval; it reverses Spec-013's one-page-per-request decision, which is what makes this reachable. Hydration triggers on an under-filled local page while pagination advances a keyset — two different orderings. With a newest-first provider, which is the default for Meta, X, and YouTube, later provider results land behind the caller's cursor and hydration never fires again. Reproduced at four of six comments unreachable by any call sequence. Hydration should be driven by snapshot completeness and loop within a request until the window is satisfiable.
- [ ] **Identity is derived at platform grain while the schema enforces it at social-account grain.** Specified as [ADR-0013](decisions/0013-assigned-comment-identity.md), awaiting acceptance; it supersedes ADR-0010 by assigning identity rather than deriving it. Cheap now, a full-table migration plus invalidated cursors once a live adapter exists. Two tenants connecting the same Instagram account derive the same UUID; the second insert raises an unhandled unique violation, rolls back the hydration batch, and row-level security hides the colliding row so the failure cannot be diagnosed from the affected tenant. The board's recommendation is to stop deriving identity: default to `gen_random_uuid()`, return the real row identifiers from the upsert, and delete the derivation. Cheap now; a full-table migration plus invalidated cursors after a live adapter exists.
- [ ] **`provider_exhausted` is a one-way latch with no reset.** Covered by [Spec-014](../specs/014-read-path-completeness.md), together with the missing freshness field and the unhandled cursor rejection. Once a post is read through, comments posted afterwards are invisible indefinitely with no error, and no response field lets a client reason about staleness. Exhaustion needs a lifetime, and the response needs a snapshot timestamp.
- [ ] **A successful publish can be recorded as failed.** The upsert and completion sit inside the same `try` as the provider call, so a database failure after a confirmed publish routes to `fail()`, and the client is told to retry with a new key. There is also no `unknown` terminal state, so an ambiguous outcome is indistinguishable from a clean rejection.
- [x] **A successful publish could be recorded as failed.** Fixed under Spec-010: only a provider failure can mark the operation failed. A storage failure after a confirmed publish now leaves the operation pending and logs `comments.reply.orphaned`, so a later request is told the work is in flight rather than invited to repeat it. The regression test asserted `failed` before the fix.
- [x] **The in-memory claim granted one key to two concurrent callers.** Fixed under Spec-010: the claim now tests and sets against a synchronous key index with nothing awaited in between, which is what the unique constraint does in PostgreSQL. Reproduced at `claimed: true, true` before the fix.
- [ ] **A crash between claim and completion poisons the idempotency key permanently**, leaving a pending row only the dead process could resolve. A rolling deploy mid-request is enough. The claim needs a lease.
- [ ] **The in-memory claim is check-then-act across an `await`** and grants one key to two concurrent callers; the existing concurrency test issues its callers sequentially, so it passes. The PostgreSQL implementation is correct.
- [ ] **The provider port has no room for a credential.** One adapter instance per platform is shared across tenants, and `PublishedPost` carries no social account, so A-002's authorised provider context has nowhere to go. A field on two interfaces today; a change to a widely depended-on domain type later.
- [ ] **`IDEMPOTENCY_CONFLICT` carries three meanings a client can only distinguish by reading prose**, and A-005's one-level-reply invariant is enforced nowhere in code.

Beyond these, the board raised: no timeout on any database call or on the HTTP server; no single-flight on cold-post hydration, so concurrent readers amplify provider load; the stored provider cursor still has no rejection handling despite the capability matrix naming both the risk and the remedy; the public cursor still encodes a provider token the service now ignores; only the in-memory composition is behaviourally exercised; and the model cannot represent a reply whose resolved parent differs from the requested one, which Instagram does silently.

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
