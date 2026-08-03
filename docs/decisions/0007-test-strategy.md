---
adr: 0007
title: Layer tests around contracts and failure boundaries
status: accepted
---

# ADR-0007: Layer tests around contracts and failure boundaries

## Context

The system crosses domain, persistence, HTTP, and external-provider boundaries. A single end-to-end suite would be slow and poorly diagnostic, while unit tests alone would miss contract integration failures.

## Decision

Use Vitest with focused layers: domain unit tests, provider contract/mapping tests, repository integration tests, and Fastify API integration tests. Test failure paths and capability differences as first-class behavior.

Every implementation spec defines its verification plan. The CI quality gate runs typecheck, lint, formatting, and tests; generated AI artifacts are validated separately.

## Consequences

Failures should be localized and test feedback should remain fast. Test doubles must represent provider contracts without becoming a second undocumented implementation. Integration tests require controlled fixtures and explicit external-service boundaries.

## Alternatives considered

Only end-to-end tests were rejected for slow, fragile feedback. Only unit tests were rejected because they cannot verify persistence constraints, route mappings, or adapter contracts.
