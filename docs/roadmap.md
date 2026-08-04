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

Status: Complete

### Goal

Make the core assignment requirements work end-to-end and close correctness gaps discovered during review.

### Deliverables

| Deliverable                                                           | Spec / ADR | State |
| --------------------------------------------------------------------- | ---------- | ----- |
| Provider-backed reads with cache-miss hydration                       | Spec 008   | Done  |
| Internal UUID identity with external-ID mapping at adapter boundaries | ADR 0010   | Done  |
| Keyset pagination over the `(post_id, published_at, id)` index        | Spec 009   | Done  |
| Reply-path hardening: timeouts, rate limits, idempotency claim        | Spec 010   | Done  |
| Fixture provider so the service runs without external dependencies    | Spec 008   | Done  |
| PostgreSQL runtime, RLS verification, Docker, and seed                | Spec 012   | Done  |

### Definition of done

`GET /v2/posts/{id}/comments` returns provider comments on first call, `POST /v2/comments/{id}/replies` publishes to a fixture provider, all Postgres code is integration-tested with RLS verified across two tenants, cursors are keyset-based, and `pnpm dev` + curl demonstrates both endpoints working.

### Remaining

Nothing. PostgreSQL persistence runs, tenant isolation is verified against a real database across two tenants, and `docker compose up` yields a working system.

Two implementation outcomes diverge from their approved text and are recorded in the documents themselves: Spec-008 acceptance criterion 3 is unreachable under ADR-0010 identifiers, and ADR-0012 overstated what `FORCE ROW LEVEL SECURITY` protects against.

## Milestone 10 — Submission readiness

Status: In progress

### Goal

Make the repository answer the assignment brief directly, for a reviewer reading it cold.

### Deliverables

| Deliverable                                                            | State       | Blocks submission |
| ---------------------------------------------------------------------- | ----------- | ----------------- |
| Contract alignment: limits, header auth, `INTERNAL_ERROR`, cursor docs | Done        | —                 |
| AI usage disclosure replacing the README placeholder                   | Done        | —                 |
| "Design decisions" summary in the README linking to the ADRs           | Done        | —                 |
| Provider capability matrix populated from public API research          | Not started | No                |
| OpenAPI generated from the Fastify schemas                             | Done        | —                 |

### Definition of done

A reviewer can read the README and see what was built, which decisions were made and why, what was assumed, and how AI was used, without opening ten ADRs to assemble it.

### Submission readiness

The brief asks for four things: a database schema, an API design, relevant TypeScript code, and an explanation of major design decisions, plus a description of AI usage and documented assumptions.

Schema, API design, code, assumptions, and the AI disclosure are all present, and the two required operations work end to end against both the in-memory and PostgreSQL compositions. Two gaps remain, neither of them in the implementation:

Nothing blocks submission. The README now states the seven decisions that shaped the service, what each cost, and what was deliberately left out, with links into the ADRs and specifications for depth.

One improvement remains and is not a blocker: the capability matrix records no research into real platforms. The provider abstraction's justification is that platforms differ, and the matrix does not yet show where. It is the cheapest remaining way to ground that argument in evidence rather than assertion.
