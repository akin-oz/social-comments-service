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

## Raised by the second delivery-readiness sweep

Five investigators re-ran the board after the review-board remediation landed. The suite was green, both compositions worked end to end, and tenant isolation held under a live mutation — and they still found one product defect, one broken demo, and a tail of tests that could not fail.

### Closed

- [x] **The README's reply demo returned `COMMENT_NOT_FOUND` for anyone following it verbatim.** It hardcoded an identifier from the era before [ADR-0013](decisions/0013-assigned-comment-identity.md), when identity was derived and therefore predictable. Reproduced on both the pnpm and Docker paths, then fixed to read the identifier out of the list response. The identity and reply paragraphs in the README described the superseded designs too.
- [x] **The pooled-connection isolation test could not fail.** It asserted on a brand-new `pg.Client`, which is empty whatever the code does; flipping `set_config`'s `is_local` flag left it green. It now commits early through the session the port hands out, which is the only place a leaked value is observable.
- [x] **Transaction rollback, both uuid guards, the parent-join scope, the tenant half of the single-flight key, the compare-and-set baseline, `REPLY_LEASE_MS`, the three reachable validator call sites, the bounded join wait, the metrics port, `Retry-After` rounding, and the warn-not-error rule** were all removable or mutable with the suite green. Each now has a test demonstrated red under its mutation. The bounded join wait needed fake timers to discriminate at all, since a plain `await` waits just as long.
- [x] **The fail-closed production guard had no coverage** and lived in a file no test imports and no CI step runs. Extracted to `chooseComposition(env)` and tested.
- [x] **Fixture uniformity, again.** Every seed tenant had one social account, making the parent join's connection scope unreachable. A second Instagram connection for tenant A fixes it — and immediately exposed [Spec-024](../specs/024-connection-scoped-lookups.md).
- [x] **Two integration tests rotted against a persistent compose stack**, failing after roughly fifty runs as rows accumulated, while their own comments claimed re-runnability. They use a post created for the run now.
- [x] **One leg of the RLS proof was vacuous in CI**: the `reply_operations` count ran before any tenant-B operation existed, and CI is always fresh. The row is created in `beforeAll`.
- [x] **The role-drift test raced the composition suite**, elevating a cluster-wide privilege while another file probed isolation. `fileParallelism` is off for the database suites.
- [x] **CI had no drift check for the `.ai/`-generated artefacts.** `ai:validate` checks structural validity, not staleness; an unsynced edit passed every gate. CI now regenerates and diffs them.
- [x] **A literal NUL byte made the largest source file binary** to git and grep, excluding it from text search including secret scans over `git log -p`.
- [x] **Stale documentation**: the ERD was three migrations behind, `database.md` understated the granted snapshot columns and omitted `account_id` from an index it names, the capability matrix still said "revisit ADR-0010", the architecture diagram still called PostgreSQL a future adapter, the README roadmap stopped at milestone 8 of 11, and "review board" was unexplained jargon at first use.
- [x] **Dead code and unshaped logging**: `toFailureReason` had no consumer, the route-scoped public-path allowlist exempted nothing and was a bypass shape waiting for a route, and the listen-failure log was the one call site handing an unshaped error object to the serializer.
- [x] **Install and posture notes** now in the operations guide: the `codeload.github.com` reachability requirement, the five development-only advisories and why they are recorded rather than bumped, the `log_statement=ddl` hazard when the migration sets the service role's password, and why no security response headers are set behind an internal gateway.

### Closed by the four specifications the sweep raised

- [x] **Pagination silently truncated past the hydration budget and reported completion.** Closed by [Spec-021](../specs/021-bounded-pagination-honesty.md), option B. A run that began over an incomplete snapshot is marked partial, the flag rides the cursor because it describes the run rather than the post, and `snapshot.syncedAt` is reported as of the run — so a final page carrying `null` is the documented instruction to start again. The restart is served from the finished snapshot and costs the provider nothing. Raising `MAX_HYDRATIONS_PER_REQUEST` to infinity, reducing `hasMore` to `page.hasMore`, and dropping the flag's propagation each turn tests red.
- [x] **Client-triggered transport errors became 500s with error-level stack traces.** Closed by [Spec-022](../specs/022-transport-and-request-hygiene.md). Any sub-500 status the framework attaches is honoured as the client error it is and logged at warn; the body limit is 64 KB; `X-Request-Id` is generated rather than trusted; an unknown route answers in the documented envelope under `ROUTE_NOT_FOUND`. `FORBIDDEN` is settled as reserved-not-removed, since every authorisation failure here is a 401 or a 404 by design and removing an enum member is what the compatibility policy forbids.
- [x] **The idempotency fingerprint neither provably bound the comment nor resisted guessing.** Closed by [Spec-023](../specs/023-idempotency-binding-integrity.md): HMAC keyed by `IDEMPOTENCY_FINGERPRINT_SECRET`, which production refuses to start without, plus a timing-safe comparison and the replay-against-a-different-parent test that was missing.
- [x] **`findByExternalId` was ambiguous when one tenant has two connections.** Closed by [Spec-024](../specs/024-connection-scoped-lookups.md). It is `findReplyByExternalId` now and takes the sibling comment, which names the connection; the `upsertMany` read-back is scoped the same way.

### Still open

Nothing. The last item is closed by [Spec-025](../specs/025-mapper-output-validation.md): `validateComment` now guards both `toComment` mappers, `ReplyOperation` has the validator its mapper never had — the one that actually shipped broken — and a malformed stored row is reported as `INTERNAL_ERROR` / `stored_record_invalid` at 500 rather than as the caller's mistake. Removing either guard, or reporting the fault as a client error, turns tests red. `validatePagination`'s unreachable call site is kept with its reasoning recorded at the call site.

## Raised by the delivery-readiness review

The repository's own read-only review board swept it before submission. Documentation findings are fixed; the rest are recorded here because they touch code, tests, or migrations and so need a specification under this repository's gate.

The review's method is worth stating: it re-applied real historical defects and confirmed the suite stayed green. That is evidence, not opinion.

### Test gaps — the suite would not catch these regressions

- [x] **The row-cast defect shipped green.** Closed by the PostgreSQL composition test; re-applying the defect now turns the suite red.
- [x] **Nothing ran `CommentService` against PostgreSQL.** Added `tests/api/postgres-composition.integration.test.ts`, which drives routes, service, and repositories against a real database: hydration, cursor round-trip, idempotent replay, key reuse, HTTP-level cross-tenant refusal, and forged-cursor mapping. Re-applying the historical row-cast defect now turns it red, where previously the whole suite stayed green. This also closes the missing HTTP-level cross-tenant case, which the single-tenant demo composition could not express.
- [x] **Five surviving mutations** — closed by [Spec-020](../specs/020-test-integrity.md). Each was re-applied and shown to turn the suite red: the published-status filter, the upsert's `do update set` clause, the parent-derivation branch, `requireCapability(provider, 'list_comments')`, and the platform predicate in both adapters. Three of the five survived on fixture uniformity, so the seed data now carries a YouTube tenant alongside the two Instagram ones and the integration suite creates a draft post and an edited comment.
- [x] **Weak assertions** — closed by [Spec-020](../specs/020-test-integrity.md). The shipped retry policy is now exercised directly rather than only test-local copies; `Retry-After` is asserted on a real response; `passWithNoTests` is off and `tests/suite-integrity.test.ts` spawns a run with a broken glob to prove a zero-test build fails. `internalCommentId` no longer exists, but the pattern it stood for is recorded in [testing.md](testing.md) along with a `rejects.toThrow` assertion written during this work that could not fail and was rewritten so it can.

### Correctness and security

- [x] **A forged cursor produced a 500.** Fixed: a malformed identifier is treated as absent, and the provider token is gone from the public cursor. Whether cursors should be signed remains open and is noted in [Spec-017](../specs/017-client-actionable-errors.md). `docs/api-design.md` says a cursor the service did not issue is rejected; the codec accepts any well-formed base64 JSON, and the decoded keyset reaches PostgreSQL as unvalidated `::timestamptz`/`::uuid` casts, producing a 500 and an error-level log per request. No cross-tenant read is possible — the predicate and RLS both hold. Relatedly, the provider-cursor field in the client cursor is now write-only, since the service reads persisted snapshot state instead, so it leaks upstream tokens for no benefit. Dropping that field and validating the cursor fixes both.
- [x] **The `comments_app` role's attributes are never pinned.** Closed by [Spec-018](../specs/018-isolation-and-schema-completeness.md). Migration 006 pins `nosuperuser nobypassrls nocreatedb nocreaterole` unconditionally on every run, and two integration tests hold it: one reads `pg_roles` under the service connection, the other drifts the role to `SUPERUSER`, applies the pinning statement read out of the migration file itself, and asserts it was corrected.
- [x] **Production failed open to the in-memory demo.** A missing `DATABASE_URL` under `NODE_ENV=production` now stops the process instead of starting a service with no row-level security behind it. A missing or misspelled `DATABASE_URL` under `NODE_ENV=production` starts the demo composition, passes `/health`, and honours any `X-Account-Id` with no row-level security behind it. It should refuse to start.
- [x] **No UUID validation on `X-Account-Id` or path parameters.** A malformed account context is now `401` and a malformed identifier is `404`, verified against PostgreSQL where both previously reached a `::uuid` cast and produced a 500., so a malformed identifier yields 500 where the contract says 404.
- [x] **The unhandled-error log recorded an unprojected error object.** Only the name, message, and stack are logged now, so a driver error cannot carry `detail` or `internalQuery` into the log., so a `pg` `DatabaseError` can carry `detail`, `internalQuery`, and constraint values into logs — the one exception to the otherwise-enforced rule that content never reaches a log record.
- [x] **`accounts` has no row-level security** — closed by [Spec-018](../specs/018-isolation-and-schema-completeness.md). Migration 006 enables and forces it with a policy keyed on the row's own identifier, and the predicate-removed proof now covers all five tenant-scoped tables rather than two. Disabling the policy turns two tests red.
- [x] **The migration runner silently no-opped without `APP_DATABASE_PASSWORD`.** It now refuses, rather than leaving a passwordless login role., leaving a passwordless `LOGIN` role; it should refuse like it does for a missing `DATABASE_URL`.
- [x] **The in-memory adapter scopes tenants by string-prefix match** — closed by [Spec-018](../specs/018-isolation-and-schema-completeness.md). The flattened `accountId:id` key is replaced by a map per tenant, so the boundary is structural rather than a prefix comparison. Reinstating the prefix scan fails a test that uses an account identifier containing the delimiter.

### Smaller

- [x] The Docker image shipped compiled tests; `pnpm build` now uses a build-only project and the image contains `dist/src` alone.
- [x] The README now says the list request must run first, because a reply resolves against the stored snapshot.
- [x] `request_fingerprint` stored the reply body in plain text; it is now a SHA-256 digest, verified by a test asserting the body is absent from the audit trail.
- [x] `src/api/schemas.ts` no longer contradicts itself on provider identifiers: the author identifier is documented as the one provider-issued value the contract exposes.
- [x] `@akinlabs/ai-engineering` was pinned to a mutable git tag. It is now pinned to `0.2.0` from the npm registry, which is immutable and carries an integrity hash, so a clean install resolves the same bytes whenever it runs. That also removed the `codeload.github.com` reachability requirement. The upgrade was not free: 0.2.0 tracks artefact ownership, so the workspace state under `.ai/state/` has to be committed or a fresh clone's first sync refuses; it stopped emitting `.claude/hooks`, which the sync script now copies itself; and `.claude/rules/*.md` are gone, their content still inlined in `CLAUDE.md`.

## Raised by the principal-review board

The board judged the design rather than its compliance. Three of its blocking findings were reproduced by execution, not inferred. The first is fixed; the rest are recorded because each needs a specification.

- [x] **A timed-out reply published up to three duplicates for one idempotency key.** `withTimeout` rejects without cancelling the in-flight request, the resulting error was classified retriable, and reads and writes shared one retry policy — so the service automatically performed the exact duplication the idempotency design exists to prevent. Reproduced at three publications for one key. Fixed under Spec-010: writes now use a policy that never replays an ambiguous failure, while rate limits are still retried because refusal proves the request was not accepted. The regression test asserted three before the fix.
- [x] **The read path made most of a post's comments unreachable.** Fixed under Spec-014: starting a pagination run completes the snapshot, bounded at twenty provider calls, so the run pages something stable. Reproduced at two of six comments returned; now six of six. Specified as [Spec-014](../specs/014-read-path-completeness.md), awaiting approval; it reverses Spec-013's one-page-per-request decision, which is what makes this reachable. Hydration triggers on an under-filled local page while pagination advances a keyset — two different orderings. With a newest-first provider, which is the default for Meta, X, and YouTube, later provider results land behind the caller's cursor and hydration never fires again. Reproduced at four of six comments unreachable by any call sequence. Hydration should be driven by snapshot completeness and loop within a request until the window is satisfiable.
- [x] **Identity was derived at platform grain while the schema enforced it at social-account grain.** Fixed under ADR-0013: the database assigns identity, an adapter produces an `ObservedComment` that has none, and two tenants observing one provider comment now get two rows. Specified as [ADR-0013](decisions/0013-assigned-comment-identity.md), awaiting acceptance; it supersedes ADR-0010 by assigning identity rather than deriving it. Cheap now, a full-table migration plus invalidated cursors once a live adapter exists. Two tenants connecting the same Instagram account derive the same UUID; the second insert raises an unhandled unique violation, rolls back the hydration batch, and row-level security hides the colliding row so the failure cannot be diagnosed from the affected tenant. The board's recommendation is to stop deriving identity: default to `gen_random_uuid()`, return the real row identifiers from the upsert, and delete the derivation. Cheap now; a full-table migration plus invalidated cursors after a live adapter exists.
- [x] **`provider_exhausted` was a one-way latch.** Fixed under Spec-014: completion is timestamped and re-read once it ages past `SNAPSHOT_LIFETIME_SECONDS`, and the response carries `snapshot.syncedAt` so freshness is read rather than assumed. Covered by [Spec-014](../specs/014-read-path-completeness.md), together with the missing freshness field and the unhandled cursor rejection. Once a post is read through, comments posted afterwards are invisible indefinitely with no error, and no response field lets a client reason about staleness. Exhaustion needs a lifetime, and the response needs a snapshot timestamp.
- [x] **A successful publish could be recorded as failed.** Fixed: only a provider failure marks an operation failed. The `unknown` terminal state that would say so precisely is specified in Spec-015. The upsert and completion sit inside the same `try` as the provider call, so a database failure after a confirmed publish routes to `fail()`, and the client is told to retry with a new key. There is also no `unknown` terminal state, so an ambiguous outcome is indistinguishable from a clean rejection.
- [x] **A successful publish could be recorded as failed.** Fixed under Spec-010: only a provider failure can mark the operation failed. A storage failure after a confirmed publish now leaves the operation pending and logs `comments.reply.orphaned`, so a later request is told the work is in flight rather than invited to repeat it. The regression test asserted `failed` before the fix.
- [x] **The in-memory claim granted one key to two concurrent callers.** Fixed under Spec-010: the claim now tests and sets against a synchronous key index with nothing awaited in between, which is what the unique constraint does in PostgreSQL. Reproduced at `claimed: true, true` before the fix.
- [x] **A crash between claim and completion poisons the idempotency key permanently** — closed by [Spec-015](../specs/015-reply-operation-lifecycle.md), together with the missing `unknown` terminal state. A claim is now held under a two-minute lease, and an expired lease is resolved to `unknown` rather than retried, since expiry does not prove the provider was never reached. `unknown` is a fourth terminal state with its own error code, so a client can tell "definitely not published, use a new key" from "possibly published, do not retry". The one recoverable case — reply published and stored, completion lost — self-heals against the stored reply without contacting the provider. Four mutations of the new logic each turn the suite red.
- [x] **The in-memory claim was check-then-act across an `await`.** Fixed with a synchronous key index; reproduced at `claimed: true, true` before the fix. and grants one key to two concurrent callers; the existing concurrency test issues its callers sequentially, so it passes. The PostgreSQL implementation is correct.
- [x] **The provider port has no room for a credential.** Closed by [Spec-016](../specs/016-provider-authorization-context.md). `PublishedPost` now carries the `SocialConnection` it was published through, the PostgreSQL repository selects it from the `social_accounts` join that was already there, and both provider operations receive it. One adapter instance per platform still serves every tenant; the connection travels with the call, and the adapter refuses a call that arrives without one or with another platform's. The reference names a secret and never reaches a response, a log, or an error message.
- [x] **`IDEMPOTENCY_CONFLICT` carries several meanings a client can only distinguish by reading prose** — closed by [Spec-017](../specs/017-client-actionable-errors.md). Every error now carries a required, globally unique `reason`, and the four idempotency situations produce four distinct reasons. `docs/api-design.md` states the action each code and reason asks for, and the `/v2` compatibility policy that additive change depends on. `Retry-After` and the `nextCursor`/`hasMore` relationship are expressed in the OpenAPI document rather than only in prose. The unenforced reply-depth invariant was closed by [ADR-0014](decisions/0014-reply-depth.md).

Cursor rejection handling, dropping the provider token from the public cursor, exercising the PostgreSQL composition, and bounding every database call and the HTTP server are done. Provider load amplification is closed by [Spec-019](../specs/019-provider-load-protection.md): hydration is single-flight per replica, so a burst of K readers on a cold post costs one provider read rather than K, and snapshot advances are compare-and-set so a stale writer cannot move the continuation backwards. One item remains open and is deliberately not solved: the model cannot represent a reply whose resolved parent differs from the requested one — which Instagram does silently — recorded in [ADR-0014](decisions/0014-reply-depth.md) as belonging to the domain-model work.

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
