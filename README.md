# Blotato Comments

An extensible comment service for a social media scheduling platform.

This repository is the starting point for the Blotato Senior Software Engineer take-home assignment. It is intentionally architecture-first: the initial commit documents the problem, boundaries, assumptions, and implementation path before business logic is introduced.

## Project overview

The service will provide a stable REST API for retrieving comments on a published post and replying to a comment across multiple social platforms. Platform-specific APIs, credentials, rate limits, and response formats are kept behind provider interfaces so that the application layer remains independent of any one platform.

This is not intended to be a CRUD wrapper. The design treats external platforms as integration boundaries with different capabilities and failure modes, while keeping the core service readable and small.

## Assignment summary

- Retrieve comments for a published post.
- Reply to an existing comment.
- Support multiple current and future social platforms.
- Expose the capabilities through a versioned REST API.
- Define the database model and implementation roadmap without introducing database code yet.

## Architecture philosophy

- Prefer a modular monolith over premature distributed systems.
- Keep domain-facing interfaces independent from Fastify, persistence, and provider SDKs.
- Depend inward on contracts; let infrastructure implement those contracts.
- Normalize the API around platform-neutral concepts while preserving provider identifiers and metadata.
- Make assumptions and trade-offs explicit in documentation and ADRs.
- Add complexity only when a concrete requirement justifies it.

See [architecture](docs/architecture.md), [assumptions](docs/assumptions.md), and [database design](docs/database.md) for the initial decisions.

## Repository structure

```text
.
├── README.md
├── docs/
│   ├── architecture.md
│   ├── assumptions.md
│   ├── api-design.md
│   ├── database.md
│   ├── roadmap.md
│   ├── decisions/
│   │   └── README.md
│   └── diagrams/
├── src/
│   ├── api/
│   ├── comments/
│   ├── platforms/
│   ├── shared/
│   └── index.ts
├── tests/
└── .github/
```

The source tree contains contracts and placeholders only at this stage. It does not contain business logic or a database implementation.

## Development workflow

Prerequisites: Node.js 22 or newer and pnpm 10 or newer.

```bash
pnpm install
pnpm typecheck
pnpm lint
pnpm format:check
pnpm test
```

The expected workflow is:

1. Update the relevant plan or assumption before changing design-sensitive behavior.
2. Record significant decisions as ADRs in `docs/decisions/`.
3. Implement one roadmap milestone at a time behind stable interfaces.
4. Add unit and integration tests with each behavior change.
5. Run the full quality gate before opening a pull request.

## Roadmap summary

1. Initialize project tooling and conventions.
2. Define domain models and error contracts.
3. Introduce the platform provider abstraction.
4. Implement persistence behind repositories.
5. Expose the versioned REST API.
6. Add unit, integration, and contract coverage.
7. Complete operational and design documentation.
8. Polish validation, observability, and delivery concerns.

The detailed definition of done for each milestone is in [roadmap.md](docs/roadmap.md).

## AI usage disclosure

> Placeholder: document which AI tools were used, what they contributed, and how generated work was reviewed before submission.

AI assistance must remain subordinate to engineering judgment. Requirements, assumptions, design decisions, and verification should be reviewable by a human.

## AI engineering governance

The `.ai/` directory is the source of truth for agent rules, agents, hooks, and commands. Generated `CLAUDE.md`, `AGENTS.md`, `.claude/`, and `.codex/` outputs must not be edited directly.

Agents may inspect the repository and draft proposals, but they must not change business logic, API/database/provider contracts, dependencies, or architecture without an applicable human-approved spec under `specs/`. Architectural changes also require an ADR under `docs/decisions/`. Proposed specs begin with `approved: no`; agents are not allowed to approve them.

```bash
  pnpm ai:sync      # compile .ai/ into complete Claude and Codex outputs
pnpm ai:validate  # validate the .ai/ workspace
```

Commit hooks require a `Spec: NNN` or `ADR: NNNN` trailer and reject verification bypasses.

## Status

Project initialization. Business logic is deliberately not implemented yet.
