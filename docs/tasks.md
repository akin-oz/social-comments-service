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

## Known defects

- [ ] **A fresh first-page request under-reports `hasMore` after a partial hydration.** Listing a post hydrates one provider page and reports `hasMore: true` with a cursor. A later request for the first page, with no cursor, finds those rows in the snapshot, so it never hydrates, and the local page has no further rows and no provider continuation. It answers `hasMore: false` with a null cursor, telling the caller the post has fewer comments than it does. A client following the issued cursor is unaffected; a client restarting pagination, which is what a polling client does, is not. The cause is that Spec-008 triggers hydration on an _empty_ page rather than an _incomplete_ one, so fixing it changes read semantics and needs its own spec. Reproduce with `pnpm dev`: request `?limit=2` twice and compare `pagination.hasMore`.

## Milestone 10: Submission readiness

### Documentation

- [x] Replace README AI usage placeholder with honest account of tool contributions and review process.
- [ ] Add "Design decisions" section to README: modular monolith, provider abstraction, cache-as-snapshot, idempotent replies, tenant isolation + ADR links.
- [ ] Research and populate provider capability matrix (YouTube, Facebook Graph, LinkedIn, Instagram, X) with real API capability findings.
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
