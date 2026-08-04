# Blotato Comments

An extensible comment service for a social media scheduling platform.

This repository contains a production-oriented partial implementation of the Blotato Senior Software Engineer take-home assignment. It remains architecture-first: contracts, assumptions, decisions, and implementation boundaries are explicit and tested.

## Project overview

The service will provide a stable REST API for retrieving comments on a published post and replying to a comment across multiple social platforms. Platform-specific APIs, credentials, rate limits, and response formats are kept behind provider interfaces so that the application layer remains independent of any one platform.

This is not intended to be a CRUD wrapper. The design treats external platforms as integration boundaries with different capabilities and failure modes, while keeping the core service readable and small.

## Assignment summary

- Retrieve comments for a published post.
- Reply to an existing comment.
- Support multiple current and future social platforms.
- Expose the capabilities through a versioned REST API.
- Define the database model and implement a PostgreSQL migration boundary without coupling the application to a database client.

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

The source tree contains domain contracts, application use cases, the adaptive provider boundary, deterministic in-memory adapters, Fastify routes, tests, and PostgreSQL migration artifacts. No live social provider SDK is selected.

## Development workflow

Prerequisites: Node.js 22 or newer and pnpm 10 or newer.

```bash
pnpm install
pnpm typecheck
pnpm lint
pnpm format:check
pnpm test
```

## Running the service

Two ways, depending on whether you want a real database.

### With PostgreSQL, via Docker

```bash
docker compose up --build
```

This starts PostgreSQL, applies migrations and seeds two tenants as a one-shot step, then starts the service on port 3000. The service connects as `comments_app`, a role that owns nothing and is not a superuser, so the row-level security policies actually apply to it — see [ADR-0012](docs/decisions/0012-tenant-context-per-operation.md).

### Without a database

```bash
pnpm dev
```

In-memory repositories and the fixture provider, so nothing needs installing. The comment snapshot starts empty either way, so the first read exercises provider-backed hydration rather than seeded data.

```bash
curl 'http://localhost:3000/v2/posts/2b1f8f5c-0d2e-4d64-9d5f-91a0c0f1b002/comments?limit=2' -H 'X-Account-Id: 2b1f8f5c-0d2e-4d64-9d5f-91a0c0f1b001'
```

That returns two comments and a `nextCursor`. Passing the cursor back returns the remaining page; replying uses a comment ID from the response:

```bash
curl -X POST 'http://localhost:3000/v2/comments/beb5d133-e54d-5998-91d0-25f49f24aa7e/replies' -H 'X-Account-Id: 2b1f8f5c-0d2e-4d64-9d5f-91a0c0f1b001' -H 'Idempotency-Key: demo-1' -H 'Content-Type: application/json' -d '{"body":"Thank you!"}'
```

Repeating that request with the same key returns the same reply instead of publishing a second one.

Interactive documentation is at [http://localhost:3000/documentation](http://localhost:3000/documentation), and the OpenAPI 3.1 document at `/openapi.json`. Both are generated from the route schemas rather than maintained by hand, and CI fails if the committed [docs/openapi.json](docs/openapi.json) no longer matches them. Use **Authorize** in the UI to supply the account header, then either operation can be executed against the fixture provider.

## Contribution workflow

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

The assignment permits AI tools and asks how they were used. They were used heavily: for research, drafting specifications, writing implementation code and tests, and keeping documentation aligned with the code. The agent configuration in this repository targets both Claude Code and Codex.

The more useful answer is what the repository does about that. Assistants are fast at producing plausible code and unreliable at knowing when they are wrong, so this project treats agent output as a proposal that has to pass a gate, not as work that is finished when it compiles. The gate is machine-enforced and its history is in the repository, which means a reviewer can check the claim rather than take it on trust.

### The rule agents work under

An agent may read anything, explain anything, and draft a proposal. It may not change business logic, an API, database, or provider contract, a dependency, or an architectural decision unless an approved specification under [specs/](specs/) covers the change. Specifications are created with `approved: no` in their front matter, and agents are forbidden from approving their own work. Only the maintainer flips that field. Architectural changes additionally require an ADR in [docs/decisions/](docs/decisions/), and every commit carries a `Spec: NNN` or `ADR: NNNN` trailer tying the change back to the decision that authorised it.

The most recent milestone is a worked example. An assistant reviewed the codebase and reported that retrieving comments returned an empty list for every post because nothing ever populated the local snapshot, that comment identifiers could not be persisted at all because the adapter produced `platform:externalId` strings for `uuid` columns, and that the cursor implementation contradicted documented assumption A-008. It wrote those findings up as [specs 008 to 010](specs/) and [ADR-0010](docs/decisions/0010-identifier-mapping.md), all marked `approved: no`, and stopped. Nothing was implemented until those files were approved by hand.

Two of the approved decisions turned out to be partly wrong once implemented. Spec-008 required fetching an uncached comment from its provider, which is impossible under ADR-0010's opaque derived identifiers because such an identifier carries no provider coordinates. ADR-0010 specified a `findByExternalId` repository method that no caller needed. Both are recorded as implementation outcomes in the documents themselves rather than quietly skipped, because a specification that silently diverges from the code is worse than no specification.

### What the gate does not do

It does not make the output correct. All three defects above survived every milestone up to the one that fixed them, including the milestones nominally covering tests and production polish, and none was caught by the quality gate: the suite was green throughout, because the tests exercised the same mistaken assumptions the code did. They were found by reading the code against its own documentation. What the gate buys is narrower and still worth having, that decisions are written down before code is written against them, that divergence between decision and implementation is visible, and that every claim in this section can be checked against `specs/`, `docs/decisions/`, and the commit history.

Known limits are stated rather than smoothed over: the PostgreSQL adapter in [postgres.ts](src/repositories/postgres.ts) is reviewed but unverified, since no harness executes it, and [docs/roadmap.md](docs/roadmap.md) tracks that alongside the rest of the outstanding work.

### AI Engineering OS

The governance above is not hand-maintained per assistant. It is compiled by [AI Engineering OS](https://github.com/akin-oz/ai-engineering) (`@akinlabs/ai-engineering`), a separate open-source project of mine that exists because every assistant wants its instructions in a different place and format. Copying a few rules into `CLAUDE.md` and `AGENTS.md` is fine until the rules grow or a second assistant appears, at which point the copies drift and a reviewer has to check the same policy in several files.

Instead, project intent lives once in [.ai/](.ai/) as a manifest, rules, agents, hooks, and commands, and the compiler generates the runtime artifacts for each target. This repository declares three rules, three agents, and both the Claude and Codex targets; `CLAUDE.md`, `AGENTS.md`, `.claude/`, and `.codex/` are all generated from that source and are never edited by hand.

```bash
pnpm ai:sync      # compile .ai/ into the Claude and Codex runtime artifacts
pnpm ai:validate  # validate the .ai/ workspace without generating output
```

CI runs `pnpm ai:validate` alongside typecheck, lint, formatting, and tests, so a drifted or invalid workspace fails the build like any other defect.

## Status

All ten approved specifications are implemented. Retrieving comments for a published post and replying to a comment both work end to end against a provider, demonstrable with the commands above.

Two things are deliberately not done. No live provider SDK is selected, so the runnable adapter is a deterministic fixture and the [capability matrix](docs/provider-capability-matrix.md) records no real platform research yet. The PostgreSQL adapter is written against the approved schema but no harness executes it, so it is a reviewed design rather than working code; the in-memory adapter is the only proven persistence path. [docs/roadmap.md](docs/roadmap.md) tracks both.
