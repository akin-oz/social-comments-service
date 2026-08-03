---
adr: 0002
title: Use a modular monolith with lightweight hexagonal boundaries and vertical use cases
status: accepted
---

# ADR-0002: Use a modular monolith with lightweight hexagonal boundaries and vertical use cases

## Context

The service has a small initial scope—retrieving comments and replying to comments—but it crosses meaningful boundaries: REST transport, application behavior, persistence, and multiple social-platform APIs.

The project needs enough structure to protect contracts and dependency direction without introducing ceremony that obscures a straightforward service.

## Decision

Use a modular monolith organized around the `comments` capability, with lightweight hexagonal boundaries and vertical use cases.

Hexagonal architecture will be applied selectively:

```text
REST adapter → application use case → ports → adapters
                                           ├── platform APIs
                                           └── persistence
```

The application and domain layers depend on ports. Fastify, provider SDKs, database clients, and other infrastructure implement those ports. Provider-specific adaptation remains in the adaptive platform layer defined by ADR-0003.

Within the `comments` module, behavior may be organized as vertical use-case slices such as `list-comments` and `reply-to-comment`. Each slice owns its application contract, orchestration, tests, and relevant errors while sharing only deliberately stable domain and port contracts.

This is intentionally lightweight DDD. We will use domain language, explicit contracts, and isolated invariants where useful, but will not introduce aggregates, domain events, bounded-context ceremony, CQRS, event sourcing, or value-object abstractions without a demonstrated requirement and a new decision.

## Consequences

The architecture keeps external dependencies replaceable, makes use-case ownership visible, and supports contract-first development. Tests can target domain, use-case, and adapter boundaries independently.

The project will have more files and explicit interfaces than a direct CRUD implementation. The team must resist creating abstractions that do not protect a real boundary or invariant.

## Alternatives considered

### Flat CRUD-style modules

Rejected because provider and persistence concerns would quickly leak into handlers and make future integrations harder to isolate.

### Full tactical DDD

Rejected as disproportionate to the current domain size and assignment scope.

### Microservices

Rejected because there is no current operational or organizational requirement for deployment separation.

## Implementation boundary

This ADR establishes structure, not feature behavior. It does not authorize provider integration, persistence implementation, route implementation, or new domain rules. Those remain governed by their respective approved specifications.
