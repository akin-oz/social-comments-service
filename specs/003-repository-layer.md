---
spec: 003
title: Implement normalized comment repositories
status: approved
approved: yes
owner: persistence adapter
depends_on:
  - ADR-0001
  - ADR-0005
  - Spec-001
---

# Spec 003: Implement normalized comment repositories

## Problem / gap

The database model is documented, but normalized comments and reply-operation state are not persisted behind repository interfaces.

## Scope

- Select and document the database technology through an ADR or this spec before implementation.
- Implement migrations for the entities in `docs/database.md`.
- Implement comment reads with deterministic opaque cursor pagination.
- Implement comment upsert/deduplication by provider identity.
- Implement reply-operation persistence with account-scoped idempotency keys.
- Add tenant/account scoping to every tenant-owned entity, repository method, and query.
- Implement and test RLS policies when supported by the selected database, with fail-closed behavior when tenant context is missing.
- Establish tenant context from trusted authenticated request context inside the transaction; never accept it as an untrusted client query/body field.
- Add repository integration tests for constraints, pagination, and transaction behavior.

## Out of scope

Provider SDK calls, HTTP routes, OAuth, webhook synchronization, production retention automation, and arbitrary raw provider payload storage.

## Acceptance criteria

- [ ] ADR-0005, ADR-0002, ADR-0003, and the domain-model spec are accepted.
- [ ] Schema entities and constraints match `docs/database.md`.
- [ ] Repository interfaces do not expose database client types.
- [ ] Every repository operation requires or derives a trusted tenant/account scope.
- [ ] Cross-tenant reads and writes are rejected by both repository behavior and database policy tests.
- [ ] RLS policies, migration behavior, and local-development setup are documented when the selected database supports RLS.
- [ ] Cursor ordering is deterministic and documented.
- [ ] Duplicate provider comments are handled safely.
- [ ] Idempotency keys cannot create duplicate reply operations within their scope.
- [ ] Integration tests cover successful and failure transactions.

## Verification

Run migrations against a disposable test database, verify RLS/policy behavior with at least two tenants, run repository integration tests, typecheck, lint, and the complete suite.
