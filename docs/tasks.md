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
- [ ] Add testcontainers integration harness: run Postgres, execute migrations, verify schema.
- [ ] Test Postgres uniqueness constraints: comment deduplication (social_account_id, external_comment_id), idempotency (account_id, idempotency_key).
- [ ] Test RLS across two tenant identities: deny cross-tenant reads, confirm account_id context isolation.

The Postgres repository is written against the approved schema but is still unexercised: no integration harness runs it. Until the three items above are done, treat `src/repositories/postgres.ts` as unverified.

## Milestone 10: Submission readiness

### Documentation

- [ ] Replace README AI usage placeholder with honest account of tool contributions and review process.
- [ ] Add "Design decisions" section to README: modular monolith, provider abstraction, cache-as-snapshot, idempotent replies, tenant isolation + ADR links.
- [ ] Research and populate provider capability matrix (YouTube, Facebook Graph, LinkedIn, Instagram, X) with real API capability findings.
- [x] Verify api-design.md alignment: limit defaults (25), max (100), header-only auth, error code mappings (500 → INTERNAL_ERROR).

### OpenAPI and contracts

- [x] Generate OpenAPI from the Fastify route schemas and serve Swagger UI (Spec-011).
- [x] Commit the generated document and fail CI on drift.
- [x] Clarify in api-design.md that authentication is the X-Account-Id header only.

### Final checks

- [ ] Run `pnpm dev` and curl both endpoints against fixture provider; verify demo works end-to-end.
- [ ] Confirm CI passes: typecheck, lint, format, ai:validate, test.
- [ ] Review commit trailer enforcement: all new commits carry Spec: NNN or ADR: NNNN.
