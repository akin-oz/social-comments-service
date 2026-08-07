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

### Raised by a second board pass, and closed

The readiness board was run again after those fixes landed, on a fresh database, applying its mutations against the live cluster. It confirmed the security HIGHs were addressed and the mutations still kill — but found one incomplete fix and a cluster of record-keeping gaps, all now closed:

- [x] **The forged-cursor guard was too lenient.** The first fix rejected only cursor positions that `Date.parse` cannot parse, and `Date.parse` accepts far more than `::timestamptz` — `2026`, `2026-02-30T00:00:00.000Z`, `CANARY 2026` all parsed yet still reached the cast and 500'd with the attacker value in the log. Replaced with `isIssuedTimestamp`, a strict round-trip against the exact ISO instant the service issues, in both the codec and the repository. Verified live in production mode across every variant: 400, no error-level record, no attacker value logged. The lenient check now fails three test layers.
- [x] **Spec-022 and Spec-018 scope divergences were unrecorded.** The edge validations folded under Spec-022 (cursor, reply-body, idempotency-key, docs toggle) and migration 006's managed-PostgreSQL relaxation of Spec-018's acceptance criterion 1 now carry `Implementation outcome` notes in their specs, matching this repository's practice for ADR-0010/0012/Spec-008.
- [x] **A fourth self-contradicting `tasks.md` item** — the forged-cursor bullet still described the 500 in the present tense — rewritten to the closed state. Two duplicated principal-review entries, each an old pre-fix report glued beside its fix, deduplicated.

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

- [x] **A forged cursor produced a 500.** Closed under [Spec-022](../specs/022-transport-and-request-hygiene.md). Both halves of the decoded keyset are validated before any typed cast: the id against `isUuid`, the position against the exact ISO instant the service issues (`isIssuedTimestamp`, a strict round-trip rather than `Date.parse`, since Date.parse accepts `2026`, `2026-02-30T00:00:00.000Z`, and other values `::timestamptz` rejects). A cursor the service did not issue is now `INVALID_CURSOR` (400) at decode and mirrored in the repository, verified live in production mode: the attacker value never reaches a 500 or a log field. The provider token is also gone from the public cursor (Spec-014). No cross-tenant read was ever possible — the predicate and RLS both held throughout.
- [x] **The `comments_app` role's attributes are never pinned.** Closed by [Spec-018](../specs/018-isolation-and-schema-completeness.md). Migration 006 pins `nosuperuser nobypassrls nocreatedb nocreaterole` unconditionally on every run, and two integration tests hold it: one reads `pg_roles` under the service connection, the other drifts the role to `SUPERUSER`, applies the pinning statement read out of the migration file itself, and asserts it was corrected.
- [x] **Production failed open to the in-memory demo.** A missing `DATABASE_URL` under `NODE_ENV=production` now stops the process instead of starting a service with no row-level security behind it. A missing or misspelled `DATABASE_URL` under `NODE_ENV=production` starts the demo composition, passes `/health`, and honours any `X-Account-Id` with no row-level security behind it. It should refuse to start.
- [x] **No UUID validation on `X-Account-Id` or path parameters.** A malformed account context is now `401` and a malformed identifier is `404`, verified against PostgreSQL where both previously reached a `::uuid` cast and produced a 500.
- [x] **The unhandled-error log recorded an unprojected error object.** Only the name, message, and stack are logged now, so a driver error cannot carry `detail` or `internalQuery` into the log.
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
- [x] **A successful publish could be recorded as failed.** Fixed: only a provider failure marks an operation failed. The `unknown` terminal state that says so precisely was added by [Spec-015](../specs/015-reply-operation-lifecycle.md) (migration 007): a timeout after send, a crash after a confirmed publish, and an expired lease all resolve to `unknown` with its own error code, distinct from the `failed` a provider refusal produces.
- [x] **The in-memory claim granted one key to two concurrent callers.** Fixed under Spec-010: the claim now tests and sets against a synchronous key index with nothing awaited in between, which is what the unique constraint does in PostgreSQL. Reproduced at `claimed: true, true` before the fix.
- [x] **A crash between claim and completion poisons the idempotency key permanently** — closed by [Spec-015](../specs/015-reply-operation-lifecycle.md), together with the missing `unknown` terminal state. A claim is now held under a two-minute lease, and an expired lease is resolved to `unknown` rather than retried, since expiry does not prove the provider was never reached. `unknown` is a fourth terminal state with its own error code, so a client can tell "definitely not published, use a new key" from "possibly published, do not retry". The one recoverable case — reply published and stored, completion lost — self-heals against the stored reply without contacting the provider. Four mutations of the new logic each turn the suite red.
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
- [x] Confirm CI passes on GitHub Actions. The workflow provisions a PostgreSQL service container and runs migrate, seed, and the full suite; it has passed green on GitHub Actions across milestones 9–12. (The two most recent runs are red for reasons outside the repository: one on a format-check the next commit fixed, and one that never acquired a runner during a declared GitHub Actions outage — see the Status note in the README.)
- [x] Review commit trailer enforcement. Five commits carry no `Spec: NNN` or `ADR: NNNN` trailer: three from before the gate existed (the initial scaffold, the commit that introduced the governance tooling, and one CI version bump), and two that postdate it — `74c6a81` and `96f3052`, both settings changes typed directly in a terminal. The gate was a `PreToolUse` Bash hook and nothing else, so it only ever applied inside a Claude Code session. Closed below.

## Raised by the third delivery-readiness sweep

Five read-only investigators, run in parallel at commit `74c6a81`. Two were empirical rather than read-only: security stood up a scratch PostgreSQL container and deleted the tenant predicates itself, and test-integrity applied 70 mutations to a scratch copy and re-ran the suite after each. 45 of the 70 turned the suite red; the items below are what survived, plus what the other three found.

### Closed

- [x] **A hand edit to a generated file broke CI, and three claims with it.** `.claude/settings.json` is compiled from `.ai/templates/claude-settings.json`; `74c6a81` added an `env` block to the artefact and not the source, so the drift gate — which runs first — failed and typecheck, lint, tests, and the rest never ran for that commit. Fixed by `96f3052`, which promoted the setting into the template so source and artefact agree. The README's "the latest run on `main` is green" and "never edited by hand" are true again.
- [x] **The commit-trailer rule had no enforcement outside a Claude Code session** — `.git/hooks/` was empty, `core.hooksPath` unset, and CI inspected no messages, which is how both untrailered commits above landed. The rule now lives in `scripts/check-commit-message.sh`, called by a committed `commit-msg` hook that `pnpm install` activates via `core.hooksPath`, and by a CI job that checks every commit a push adds. Replayed over `37f96d7..96f3052`, the job fails on exactly the two offending commits and passes the other three.
- [x] **`src/server.ts` was executed by nothing.** The fail-closed production guard is decided in a well-tested place (`chooseComposition`) and actuated in an untested one: deleting `process.exit(1)` left the suite green while a misspelled `DATABASE_URL` would boot the in-memory composition in production — passing health checks, accepting any account, no RLS behind it. `tests/api/server.test.ts` now spawns the entry point and asserts exit code 1 for both refusals. Verified: removing the exit turns it red.
- [x] **Nothing asserted that the 52 database-backed tests actually ran.** Deleting the `env:` block from the workflow made every tenant-isolation proof skip silently while CI stayed green. `tests/suite-integrity.test.ts` now asserts both DSNs are present whenever `CI` is set.
- [x] **CI never ran `pnpm build`, and never exercised the Docker path.** The `dist/src/server.js` the Dockerfile launches was never produced in the pipeline, and no workflow ran `docker build` or `compose up` — the gap most likely to reintroduce the "built one path, verified another" defect this project's history records. A build step now checks the three emitted entry points, and a `docker` job builds the image, brings the documented stack up, and walks the README's requests against it, including a cross-tenant read that must return 404.
- [x] **Widening `provesRejection` survived the suite** — the highest-consequence surviving mutation. Rewritten as `code !== 'PROVIDER_UNAVAILABLE'`, an upstream 502 records `failed` rather than `unknown`, telling the client to retry with a new key, which is how a second reply gets published under a customer's name. Only the two codes the source comment names had tests; a third now covers `ProviderError` on the reply path.
- [x] **The idempotency fingerprint had no golden vector.** Switching SHA-256 to SHA-512 passed every test, because each computed its expected value with the function under test. The digest is persisted in `reply_operations.request_fingerprint`, so an algorithm change silently invalidates every in-flight idempotency key across a rolling deploy. One pinned hex value now fixes it from outside.
- [x] **The shipped retry budget was asserted with checks that could not fail.** `> 0` and `> 1` let `timeoutMs` go 20s→200s and `maxDelayMs` 5s→600s. Upper bounds now hold `timeoutMs` below the request timeout and cap the backoff ladder.
- [x] **The lease-outlives-the-request invariant rested on two separately-pinned numbers**, one a hand-copied literal in the test and the other unasserted anywhere. `REQUEST_TIMEOUT_MS` is now exported from `src/index.ts`, used by the Fastify config, and asserted against the observed lease — raising the timeout past the lease now fails.
- [x] **RLS fail-closed behaviour was claimed in `docs/operations.md` and tested nowhere.** A test now connects as the service role without going through `withTenant` and asserts all five tenant-scoped tables return zero rows. Verified against a policy rewritten to treat an unset tenant as unrestricted: it reports 49 rows instead of 0.
- [x] **`provider.call.retried` is documented as the earliest warning of provider trouble and was asserted nowhere** — every adapter retry test constructed the adapter without a logger, so the whole `onRetry` wiring could be deleted. Now pinned, including the platform, operation, failure code, and delay.
- [x] **A log comment overstated what it did.** `src/api/routes.ts` was prefaced "Only the shape is logged" while emitting `errorMessage` and `stack`. The dangerous driver fields (`detail`, `internalQuery`, `constraint`) were correctly excluded; the comment now says what is kept, and why an unhandled 500 keeps it.
- [x] **The README structure diagram omitted every entry point** — `src/index.ts`, `server.ts`, `migrate.ts`, `openapi.ts`, and `seed.ts` are now listed.

### Still open, and deliberately so

- [ ] **The `X-Account-Id` header is unauthenticated.** A caller presenting another tenant's published UUID gets that tenant's comments. This is assumption [A-001](assumptions.md), disclosed in the README, `docs/api-design.md`, and `docs/assumptions.md`; row-level security faithfully enforces whichever tenant the caller declares and does not claim otherwise. It needs no code change — it needs to stay conscious, and a real deployment puts an authenticating gateway ahead of the service. Note the live demo was not probed by the sweep; statements about it are inferences from `fly.toml` and the README.
- [ ] **`src/migrate.ts` writes the service role's password as a DDL literal.** Correctly escaped, but a server with `log_statement = ddl` writes it to the PostgreSQL log. Already disclosed with the correct remediation in [operations.md](operations.md).
- [ ] **No rate limiting**, while one cold list request can make up to twenty provider calls. Needs a spec.
- [ ] **`additionalProperties: false` strips rather than rejects** — `{"body":"ok","isAdmin":true}` returns 201 with the extra discarded. Not a leak, but it reads as "reject" and behaves as "drop". Changing it is an API contract change and needs a spec.
- [ ] The in-flight hydration key is tested white-box via `Reflect.get` rather than behaviourally.
- [ ] `docs/tasks.md`'s reconciliation is traceable but not a one-glance check.

### What held up

No secret is committed anywhere in the tree or in history. Cross-tenant reads returned zero rows on all five tables with the predicates deleted, cross-tenant writes returned `42501`, and the service role cannot escalate out of RLS. A canary comment body, author name, idempotency key, fingerprint secret, and database password produced zero hits across 400+ debug-level log records. The `packageManager` pin matches CI exactly, migrations and seed are genuinely idempotent, and the README's curl walkthrough matches the seed data. Exactly one false claim was found across the README, all of `docs/`, 25 specs, and 14 ADRs — the CI-status sentence, itself a consequence of the drift break above.

## Raised by the principal-review board, and closed

The board's report is a critique rather than a gate, and it states that nothing
in it had been implemented. It has been now — P0 and P1 both, in one session, at
the maintainer's explicit direction and **ahead of the spec gate rather than
behind it**. The specs and ADRs below were written alongside the code as records
of what was decided, not as approvals obtained before it. That is a deliberate
exception to the rule in `CLAUDE.md`, taken with the trade understood, and the
commit history shows it either way.

### P0

- [x] **The "never replays a write" policy replayed a publish three times on a 429.** `retryDelayFor` answered the rate-limit branch before consulting `shouldRetry`, so the write policy's `shouldRetry: () => false` was unreachable for a 429. Measured at three publishes for one idempotency key — three replies under a customer's name, with `recordPublished` keeping only the last `externalId` so the first two were orphaned. Compounded by `provesRejection` recording a rate limit as `failed`, which answers the retry `idempotency_key_failed` — _retry with a new key_ — and publishes a fourth. Both halves closed by [Spec-026](../specs/026-write-path-rate-limit-safety.md) and [ADR-0015](decisions/0015-rate-limit-does-not-prove-refusal.md). Untested for two compounding reasons, both now fixed: every reply rate-limit test used a `Retry-After` above `maxDelayMs`, and the service harness ran a policy with `maxAttempts: 1` that could not retry anything.
- [x] **`parentCommentId` collapsed "no parent" and "parent not yet synced."** A LEFT JOIN miss and a genuine top-level comment both produced null, and the reply-depth gate read that value — so a reply to an unsynced-parent comment published the two-level thread ADR-0014 refuses. Systematic rather than rare: newest-first providers deliver replies before their parents. Closed by [Spec-027](../specs/027-reply-storage-and-parent-resolution.md) and [ADR-0016](decisions/0016-unresolved-parent-is-a-third-state.md), which carries `parentUnresolved` through both adapters and refuses a reply to it.
- [x] **Migrations added constraints without `NOT VALID`, and two indexes did not serve their keys.** Closed by [Spec-031](../specs/031-index-and-constraint-safety.md) and migration 008: `reply_operations_comment_idx` reordered to `(comment_id, account_id)` so the referential-integrity check can use it, `posts_account_idx` added for the cascading key that had none, and the `ADD … NOT VALID` + `VALIDATE CONSTRAINT` convention recorded for every later constraint change.
- [ ] **The service tests do not exercise the identifier shape the PostgreSQL adapter enforces.** Fixtures use `id: 'post-1'`; the adapter guards with `isUuid` and returns null otherwise. Open — it needs branded `CommentId`/`PostId` validated at the API edge, which is a domain-model change of its own. The related half is closed: `author.profileUrl` is contracted and populated but has no column, so the adapters disagree on contracted data.
- [ ] **Hydration is fused into the HTTP read path.** `inFlight` is private to `CommentService` and reachable only through `listComments`, so the webhook ingest and background sync A-006 defers cannot reach the loop without calling a read for its side effects. Open: extracting a `SnapshotHydrator` behind a `SingleFlight` port is near-free now and a read-path rewrite later, but it is a structural change with no defect behind it today.

### P1

- [x] **A joining reader inherited the originator's failure.** The joined promise was raced with no catch, so one provider failure became K 503s while every joiner held a serviceable snapshot. Closed by [Spec-029](../specs/029-hydration-join-isolation.md), with a `hydration_join_failed` counter and a test that fails against the old code with all four callers rejected.
- [x] **`complete` erased the record that a client was told `unknown`.** No transition checked the status it was leaving, so a late writer overwrote a terminal outcome and nulled its failure code — the runbook query then returned nothing while the customer who raised the ticket still held it. Closed by [Spec-028](../specs/028-operation-transition-guards.md). `complete` accepts `pending` and `unknown` and preserves `failure_code`; `fail` and `recordPublished` accept only `pending`.
- [x] **The lease was justified by arithmetic that did not hold.** Fastify's `requestTimeout` destroys the socket without stopping the handler, so the request timeout was never the bound. Closed by [Spec-033](../specs/033-lease-derived-from-real-budget.md): the lease is asserted against the real post-claim budget — one provider publish plus three database calls — and lowering it to 60s now fails the suite. The board's 115s figure assumed a three-attempt retry ladder that ADR-0015 removed; the real worst case is 65s.
- [x] **Capability was enforced by the caller, never by the provider that declares it.** Closed by [Spec-030](../specs/030-adapter-enforced-capabilities.md); the call-site check stays as the cheaper failure.
- [x] **A published reply could overwrite a customer's comment.** The reply path shared hydration's `do update set body = excluded.body`. Closed by [Spec-027](../specs/027-reply-storage-and-parent-resolution.md): `storePublishedReply` inserts with `do nothing`, returns an identical existing row so recovery stays idempotent, and refuses anything else rather than overwriting it. Listed P2 by the board; treated as higher because it destroys content the service does not own.
- [x] **The automated half of the spec gate had never gated anything.** `guard-spec-gate.sh` asked whether _any_ spec in the repository was approved; all 25 were, so it passed unconditionally and the `ask` branch had been unreachable since 2026-08-02. Closed by [Spec-032](../specs/032-spec-gate-path-claims.md): specs declare the paths they claim and the hook evaluates the claim. It now returns `ask` for `.claude/settings.json` — the hand edit that broke CI at `74c6a81`.
- [x] **The restart-on-`syncedAt: null` rule was absent from the machine-readable contract.** A generated client never restarted and silently shipped a truncated list. The rule is now in the field description, so it reaches codegen.
- [ ] **`reply_operations` index ordering, `posts.account_id`, and `upsertMany`'s row-by-row insert** — the first two are closed above; the set-based rewrite of `upsertMany` is open. Up to 100 sequential round trips per page against a 30s budget, and the fix needs de-duplication first because PostgreSQL rejects self-conflicting rows in one `ON CONFLICT DO UPDATE`.
- [ ] **A large post whose stored cursor is rejected can never complete.** Hydration is bounded by call count, not by new rows, so a run re-walks pages 1–20 forever and never reaches 21. Open.
- [ ] **`completedAt` claims completeness over a resumed stream**, and only loud cursor invalidation is handled — Meta's documented failure mode is silent. Open.
- [ ] **`unknown` is terminal with no exit**, and no log record carries the operation id while the runbook's triage query returns operation ids. Open.
- [ ] **Comment deletion has no representation**, and Instagram's silent reattachment is unmodelled (ADR-0014 §4). Open, both domain-model work.
- [ ] **`reason` is one flat enum shared API-wide**, and there is no `GET /v2/comments/{id}`. Open.

### P2

Recorded, not closed, except the reply-upsert overwrite above which was
reclassified. The remaining items — the header-less 429 backoff floor, the
unbounded wall-clock on `runHydration`, the unset pool `max`, `toFailureCode`
mapping driver failures to `PROVIDER_ERROR`, `partialRun` not being
re-evaluated, `completedAt` stamped early, unbounded retention, and the naming
and size observations about `src/index.ts` — are in the board's report and stay
open.
