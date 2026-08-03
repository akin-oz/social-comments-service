---
adr: 0005
title: Hide persistence behind repository interfaces
status: accepted
---

# ADR-0005: Hide persistence behind repository interfaces

## Context

The service needs normalized comment storage and reply-operation state, but the assignment does not require selecting or implementing a database yet. Application behavior should not be coupled to a database client or query language.

## Decision

Define repository interfaces in the comments/application boundary and implement persistence adapters separately. Repositories own normalized reads, writes, deterministic cursor queries, uniqueness constraints, and reply idempotency state; callers do not receive database models or clients.

External providers remain the source of truth. Local persistence is a normalized cache and operational record whose consistency and reconciliation behavior must be explicitly documented.

Tenant isolation is a mandatory persistence invariant. Every tenant-owned entity and repository operation must be scoped to the authenticated account/tenant context. When the selected database supports it, row-level security (RLS) should provide defense in depth at the database boundary. Application-level tenant predicates remain required even with RLS; RLS is not a substitute for correct repository contracts.

The persistence implementation must establish tenant context safely for each transaction, prevent tenant context from being client-controlled, and include cross-tenant isolation tests. RLS policy changes require migration review and must fail closed when tenant context is absent.

## Consequences

Persistence can be tested independently and replaced without changing use cases. Repository transactions, tenant context propagation, cache freshness, retention, and failure recovery must be designed before production use. RLS adds defense in depth but also introduces migration, transaction-context, and local-development complexity. An interface alone does not remove the need for integration tests against the chosen database.

## Alternatives considered

Embedding SQL or an ORM in use cases was rejected because it violates dependency inversion. Treating the local database as the canonical social graph was rejected because provider state remains authoritative. Relying only on application predicates was rejected as insufficient defense in depth for a multi-tenant boundary.
