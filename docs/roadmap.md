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

### Goal

Define stable comment, post, platform, pagination, and error contracts.

### Deliverables

- Domain types and validation boundaries.
- Typed application commands and results.
- Error taxonomy and capability model.

### Definition of done

Contracts are platform-neutral, documented, and covered by focused unit tests.

## Milestone 3 — Platform abstraction

### Goal

Hide provider APIs behind explicit adapter interfaces.

### Deliverables

- Provider registry and adapter lifecycle.
- Provider-to-domain mapping contracts.
- Capability and rate-limit behavior.

### Definition of done

A provider can be added without changing route semantics, and unsupported operations are explicit.

## Milestone 4 — Repository layer

### Goal

Persist normalized comments and reply operation state behind interfaces.

### Deliverables

- Database migrations/schema implementation.
- Comment and reply-operation repositories.
- Cursor query strategy and uniqueness constraints.

### Definition of done

Repository behavior is deterministic, transaction boundaries are documented, and integration tests cover constraints.

## Milestone 5 — REST API

### Goal

Expose the documented read and write operations through Fastify.

### Deliverables

- Request schemas and response serializers.
- Authentication/authorization integration points.
- Error mapping, request IDs, and idempotency handling.

### Definition of done

The API matches `api-design.md`, rejects invalid input, and does not leak provider-specific implementation details.

## Milestone 6 — Tests

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

### Goal

Prepare the implementation for production-oriented review.

### Deliverables

- Structured logging and metrics boundaries.
- Timeouts, retries, and rate-limit policy.
- Security and data-retention review.
- Dependency and delivery hygiene.

### Definition of done

The system’s reliability, security, and operational trade-offs are explicit and verified at the appropriate level.
