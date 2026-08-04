# Implementation roadmap

## Milestone 1 — Project initialization

### Goal

Establish a reproducible TypeScript service skeleton and shared engineering conventions.

### Deliverables

- pnpm package and TypeScript configuration.
- Fastify, Vitest, ESLint, and Prettier tooling.
- Repository documentation, assumptions, architecture, and roadmap.
- ADR location and CI quality-gate placeholder.

### Definition of done

The repository installs and passes typecheck, lint, formatting, and test commands without business logic.

## Milestone 2 — Domain model

Status: Complete

### Goal

Define stable comment, post, platform, pagination, and error contracts.

### Deliverables

- Domain types and validation boundaries.
- Typed application commands and results.
- Error taxonomy and capability model.
- Runtime validation for normalized comments, pagination, list queries, and reply commands.
- Focused domain-model tests.

### Definition of done

Contracts are platform-neutral, documented, and covered by focused unit tests.

## Milestone 3 — Platform abstraction

Status: Complete

### Goal

Hide provider APIs behind explicit adapter interfaces.

### Deliverables

- Provider registry and adapter lifecycle.
- Provider-to-domain mapping contracts.
- Capability and rate-limit behavior.

### Definition of done

A provider can be added without changing route semantics, and unsupported operations are explicit.

## Milestone 4 — Repository layer

Status: Complete

### Goal

Persist normalized comments and reply operation state behind interfaces.

### Deliverables

- Database migrations/schema implementation.
- Comment and reply-operation repositories.
- Cursor query strategy and uniqueness constraints.

### Definition of done

Repository behavior is deterministic, transaction boundaries are documented, and integration tests cover constraints.

## Milestone 5 — REST API

Status: Complete

### Goal

Expose the documented read and write operations through Fastify.

### Deliverables

- Request schemas and response serializers.
- Authentication/authorization integration points.
- Error mapping, request IDs, and idempotency handling.

### Definition of done

The API matches `api-design.md`, rejects invalid input, and does not leak provider-specific implementation details.

## Milestone 6 — Tests

Status: Complete

### Goal

Make the service behavior safe to change.

### Deliverables

- Domain unit tests.
- Provider adapter contract tests.
- Repository integration tests.
- API integration tests and failure-path coverage.

### Definition of done

Critical paths and provider failure modes are covered, and the CI quality gate is meaningful.

## Milestone 7 — Documentation

Status: Complete

### Goal

Keep design and operational knowledge usable for reviewers and maintainers.

### Deliverables

- ADRs for material decisions.
- Provider capability matrix.
- Local development and configuration guide.
- API examples and operational notes.

### Definition of done

A new engineer can run the service, understand its boundaries, and add a provider using the docs.

## Milestone 8 — Final polish

Status: Complete

### Goal

Prepare the implementation for production-oriented review.

### Deliverables

- Structured logging and metrics boundaries.
- Timeouts, retries, and rate-limit policy.
- Security and data-retention review.
- Dependency and delivery hygiene.

### Definition of done

The system’s reliability, security, and operational trade-offs are explicit and verified at the appropriate level.

## Milestone 9 — Provider-backed reads and core gaps

Status: In progress — implementation complete, Postgres integration coverage outstanding

### Goal

Make the core assignment requirements work end-to-end and close correctness gaps discovered during review.

### Deliverables

- Spec 008: Provider-backed comment reads with cache-miss semantics and staleness policy.
- ADR: Internal UUID identity with explicit external-ID mapping at adapter boundaries.
- Keyset pagination using the existing `(post_id, published_at, id)` index instead of offset-based cursors.
- Integration test harness with testcontainers to verify Postgres schema, RLS, uniqueness constraints, and cursor behavior.
- Reply-path hardening: concurrent-request race condition documentation or fix, failure-code taxonomy alignment, provider timeouts and rate-limit-aware retry.
- Fixture provider implementation for `createDemoApplication` so the service is runnable without external dependencies.

### Definition of done

`GET /v2/posts/{id}/comments` returns provider comments on first call, `POST /v2/comments/{id}/replies` publishes to a fixture provider, all Postgres code is integration-tested with RLS verified across two tenants, cursors are keyset-based, and `pnpm dev` + curl demonstrates both endpoints working.

### Remaining

Everything above is met except Postgres verification. `src/repositories/postgres.ts` is written against the approved schema but no harness executes it, so its SQL, the `(social_account_id, external_comment_id)` and `(account_id, idempotency_key)` constraints, and the row-level security policies are all unverified. Until the testcontainers harness in `docs/tasks.md` lands, the in-memory adapter is the only proven persistence path.

## Milestone 10 — Submission readiness

Status: Planned

### Goal

Complete governance and documentation final pass for external review.

### Deliverables

- Replace AI usage placeholder in README with honest account of what tools contributed and how work was reviewed.
- Add "Design decisions" summary section to README linking the five core architectural choices to their ADRs.
- Populate provider capability matrix with findings from public API research (YouTube, Facebook Graph, etc.).
- OpenAPI spec generation from Fastify schemas to prevent documentation drift.
- Contract alignment: HTTP 500 errors use `INTERNAL_ERROR` code per api-design.md, auth expectations documented explicitly.

### Definition of done

README clearly explains the reasoning, AI usage is transparent, provider matrix shows real platform research, and schema-sourced OpenAPI schema matches api-design.md.
