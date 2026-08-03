---
adr: 0008
title: Treat design and operational documentation as maintained artifacts
status: accepted
---

# ADR-0008: Treat design and operational documentation as maintained artifacts

## Context

The service crosses several ownership and integration boundaries. Reviewers and maintainers need to understand assumptions, contracts, decisions, provider differences, and operational behavior without reconstructing intent from source code.

## Decision

Keep architecture, assumptions, API, database, roadmap, task tracking, ADRs, and provider capability documentation in the repository. Material implementation changes must update the relevant document or explicitly explain why no documentation change is needed.

Use the AI governance workflow to nudge documentation updates and keep source-of-truth documents separate from generated runtime files.

## Consequences

Documentation becomes part of the definition of done and requires maintenance. The project gains reviewability and onboarding value, at the cost of requiring discipline to prevent stale prose.

## Alternatives considered

Relying on code comments or external wikis alone was rejected because they are disconnected from change review and repository history.
