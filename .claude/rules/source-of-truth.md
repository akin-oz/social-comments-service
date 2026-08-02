# Source of truth

The repository has explicit sources of truth:

- `docs/api-design.md` governs the public REST contract until an approved API spec supersedes it.
- `docs/database.md` governs the initial persistence model until an approved database spec supersedes it.
- `docs/architecture.md` governs dependency direction, modular boundaries, and provider abstraction.
- `docs/assumptions.md` governs system assumptions; changing an assumption requires an ADR or approved spec.
- `docs/roadmap.md` and `docs/tasks.md` govern sequencing and implementation scope.
- `docs/decisions/` contains accepted architectural decisions.
- `specs/` contains change-specific proposals and approved implementation specifications.

Do not invent endpoints, fields, persistence behavior, provider capabilities, retries, authorization behavior, or error semantics. If the source of truth is insufficient, stop and request a spec or ADR.

Domain-facing code must remain independent of Fastify, database clients, and provider SDKs. Platform-specific behavior belongs behind `src/platforms/` interfaces.
