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
- [ ] Generate and commit the dependency lockfile after the package manager is available.

## Domain and integration design

- [ ] Finalize normalized domain types and typed error taxonomy.
- [ ] Define provider capability matrix.
- [ ] Define account, post, and authorization context contracts.
- [ ] Decide whether local reads are cache-first or provider-first for each operation.

## Implementation

- [ ] Implement the first provider adapter behind the platform contract.
- [ ] Implement persistence repositories and migrations.
- [ ] Implement application use cases.
- [ ] Implement Fastify schemas, routes, and error mapping.
- [ ] Add idempotency storage and retry policy.

## Verification and delivery

- [ ] Add unit, contract, integration, and API tests.
- [ ] Add structured logging and request correlation.
- [ ] Document operational limits, retention, and failure recovery.
- [ ] Tighten CI to use `pnpm install --frozen-lockfile`.
