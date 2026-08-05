# Blotato Comments

An extensible comment service for a social media scheduling platform.

This repository implements the Blotato Senior Software Engineer take-home assignment. Both required operations — retrieving comments for a published post and replying to a comment — work end to end: on PostgreSQL with verified tenant isolation, and on in-memory adapters so the service runs with nothing installed. No live social platform SDK is selected; a deterministic fixture provider stands behind the same contract a real one would implement.

## Project overview

The service will provide a stable REST API for retrieving comments on a published post and replying to a comment across multiple social platforms. Platform-specific APIs, credentials, rate limits, and response formats are kept behind provider interfaces so that the application layer remains independent of any one platform.

This is not intended to be a CRUD wrapper. The design treats external platforms as integration boundaries with different capabilities and failure modes, while keeping the core service readable and small.

## Assignment summary

- Retrieve comments for a published post.
- Reply to an existing comment.
- Support multiple current and future social platforms.
- Expose the capabilities through a versioned REST API.
- Define the database model and implement a PostgreSQL migration boundary without coupling the application to a database client.

### What the brief asked for, and where it is

| Asked for                      | Where                                                                                                           |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------- |
| Database schema                | [docs/database.md](docs/database.md) for the model, [migrations/](migrations/) for the SQL                      |
| API design                     | [docs/api-design.md](docs/api-design.md), with [docs/openapi.json](docs/openapi.json) generated from the routes |
| Relevant TypeScript code       | [src/](src/) — start at [comment-service.ts](src/comments/comment-service.ts), the two operations in one file   |
| Explanation of major decisions | [Design decisions](#design-decisions) below, seven of them with their costs                                     |
| Documented assumptions         | [docs/assumptions.md](docs/assumptions.md), eleven numbered and referenced from the code                        |
| How AI tools were used         | [AI usage disclosure](#ai-usage-disclosure) below                                                               |

## Design decisions

Seven decisions shaped this service. Each is stated with what it cost, because a decision without a cost is usually a decision that was never made. The linked ADR or specification carries the full argument, including the alternatives that were rejected.

**Platform differences are made explicit, never emulated.** Every provider sits behind one adapter interface and declares which operations it supports. A platform that cannot perform an operation produces a typed `UNSUPPORTED_CAPABILITY` error rather than the service quietly faking it, because emulating a missing capability converts a platform difference into a data problem that surfaces much later and far from its cause. Adding a platform means writing an adapter, wiring credentials, and recording its capabilities — no route, use case, or schema changes. The cost is a layer of indirection between the service and every provider, worth paying only because the brief says more platforms are coming. See [ADR-0004](docs/decisions/0004-platform-abstraction.md) and the [capability matrix](docs/provider-capability-matrix.md).

**The database is a snapshot of an authoritative source, not the system of record.** Providers own comments; this service stores what it has observed. A read serves from the snapshot and fetches from the provider when the snapshot cannot fill the page, and each post records how much of its provider stream has been read, so pagination can distinguish an exhausted provider from one that was never asked. Treating the database as the source of truth would make every read cheap and every answer potentially wrong. The cost is that a comment edited or deleted upstream stays as last observed until webhook ingestion exists, which is deferred deliberately. See [Spec-008](specs/008-provider-backed-reads.md), [Spec-013](specs/013-snapshot-completeness.md), and assumption A-003.

**Comment identity is a service-owned UUID derived from the provider's identifier.** Identities are computed as a version 5 UUID over `(platform, externalId)`, so observing the same provider comment twice converges on one row without a lookup, and provider identifiers never reach an API client. The obvious alternative, exposing `platform:externalId` directly, leaks provider structure into the public contract and makes a provider's identifier scheme impossible to change without rewriting stored data. The cost is an assumption that provider comment identifiers are unique within a platform; violating it collides on the primary key, so it is stated rather than hoped for. See [ADR-0010](docs/decisions/0010-identifier-mapping.md).

**Pagination is keyset-based behind opaque cursors.** Cursors encode the last returned `(publishedAt, id)` pair rather than an offset, because offset paging over data that changes underneath the caller produces duplicates and gaps — and comments arriving mid-pagination is the normal case here, not an edge case. Clients cannot decode or construct cursors, which keeps the encoding free to change. The cost is forward-only paging, which no requirement contradicts. See [Spec-009](specs/009-keyset-pagination.md) and assumption A-008.

**Replies are at-most-once, and a failed attempt is terminal.** A reply claims its idempotency key by inserting a row, so concurrent requests cannot both reach the provider, and a retry returns the reply already published instead of publishing a second one. When an attempt fails, that key is finished: the outcome at the provider may be genuinely unknown after a timeout, so retrying under the same key could duplicate a real published reply. A client that wants to try again supplies a new key and thereby says so explicitly. This is the deliberate choice of a duplicate-free system over a self-healing one, which is the right way round for content posted under someone else's name. See [Spec-010](specs/010-reply-path-reliability.md) and assumption A-009.

**Tenant isolation is enforced twice, in the query and in the database.** Every repository query filters by account, and PostgreSQL row-level security independently rejects rows belonging to another tenant. Either alone is a single point of failure: one forgotten predicate is an unbounded leak, and policies can be weakened by a later migration. Making this real required more than enabling the policies — PostgreSQL exempts superusers and a table's owner, so the service connects as a role that is neither, and the isolation is verified against a live database with the query predicate deliberately removed. The cost is two sets of credentials in every environment. See [ADR-0012](docs/decisions/0012-tenant-context-per-operation.md) and assumption A-011.

**Dependencies point inward, so infrastructure stays replaceable.** The application layer depends on ports — provider, repository, logger, metrics — and never on Fastify, `pg`, or a logging library. That is what lets the same service run on in-memory repositories with a fixture provider for tests and on PostgreSQL for real, and it is why the observability work could add structured events without the domain learning what a log is. The cost is more interfaces than a CRUD wrapper needs, which is the price of the platform boundary being the point of the exercise. See [ADR-0002](docs/decisions/0002-architecture-style.md) and [architecture](docs/architecture.md).

### What was deliberately not built

Judgement shows as much in what is absent. There are no microservices, queues, event sourcing, or CQRS: the two required operations are synchronous, and a modular monolith is the smallest thing that satisfies them ([ADR-0002](docs/decisions/0002-architecture-style.md), [ADR-0009](docs/decisions/0009-production-polish.md)). There is no webhook ingestion or background synchronisation, so reads stay on demand (A-006). No live provider SDK is selected; a deterministic fixture provider stands in, because inventing one platform's behaviour would prove less about the abstraction than keeping every provider behind the same contract. Authentication is assumed to happen upstream and the tenant arrives in a header (A-001). Each of these is an assumption in [docs/assumptions.md](docs/assumptions.md), so changing one is a documented decision rather than a surprise.

### Where the reasoning lives

[docs/assumptions.md](docs/assumptions.md) states what the design takes for granted, [docs/decisions/](docs/decisions/) holds the architectural decisions, and [specs/](specs/) holds the change proposals that had to be approved before implementation. Where implementation contradicted an approved document — three of them so far — the document records the correction rather than quietly diverging, so a specification and the code it governs can be trusted to agree. [docs/api-design.md](docs/api-design.md) and [docs/database.md](docs/database.md) remain the contract references, and [docs/openapi.json](docs/openapi.json) is generated from the routes so the two cannot drift unnoticed.

## Repository structure

```text
.
├── docs/                 # contracts, assumptions, operations, generated OpenAPI
│   └── decisions/        # accepted architectural decisions (ADRs)
├── specs/                # change proposals, approved before implementation
├── migrations/           # ordered SQL, applied by one runner per release
├── src/
│   ├── api/              # Fastify routes, schemas, error mapping
│   ├── comments/         # domain contracts and application use cases
│   ├── platforms/        # provider adapters behind one interface
│   ├── repositories/     # in-memory and PostgreSQL persistence
│   └── shared/           # identity, cursors, errors, observability ports
├── tests/
└── docker-compose.yml    # PostgreSQL, migrate and seed, then the service
```

Dependencies point inward: `api` and `repositories` depend on `comments`, never the reverse, and nothing in `comments` imports Fastify, `pg`, or a logging library.

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

That returns comments and a `nextCursor`. Passing the cursor back returns the remaining pages. Replying uses a comment ID **from that response** — the identifier below is the demo's first comment, and the list request must have run first, because a reply resolves against the stored snapshot:

```bash
curl -X POST 'http://localhost:3000/v2/comments/beb5d133-e54d-5998-91d0-25f49f24aa7e/replies' -H 'X-Account-Id: 2b1f8f5c-0d2e-4d64-9d5f-91a0c0f1b001' -H 'Idempotency-Key: demo-1' -H 'Content-Type: application/json' -d '{"body":"Thank you!"}'
```

Repeating that request with the same key returns the same reply instead of publishing a second one.

Interactive documentation is at [http://localhost:3000/documentation](http://localhost:3000/documentation), and the OpenAPI 3.1 document at `/openapi.json`. Both are generated from the route schemas rather than maintained by hand, and CI fails if the committed [docs/openapi.json](docs/openapi.json) no longer matches them. Use **Authorize** in the UI to supply the account header, then either operation can be executed against the fixture provider.

Documentation endpoints are served when `ENABLE_API_DOCS` is set and are off by default when `NODE_ENV=production`, so a deployed service does not publish its own schema. The container image sets `NODE_ENV=production`, so the Compose stack opts back in explicitly; `pnpm dev` has them on without configuration.

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

The detailed definition of done for each milestone is in [roadmap.md](docs/roadmap.md), and [operations.md](docs/operations.md) covers observability, database roles, migrations, and failure handling.

## AI usage disclosure

The assignment permits AI tools and asks how they were used. They were used heavily: for research, drafting specifications, writing implementation code and tests, and keeping documentation aligned with the code. The agent configuration in this repository targets both Claude Code and Codex.

The more useful answer is what the repository does about that. Assistants are fast at producing plausible code and unreliable at knowing when they are wrong, so this project treats agent output as a proposal that has to pass a gate, not as work that is finished when it compiles. The gate is machine-enforced and its history is in the repository, which means a reviewer can check the claim rather than take it on trust.

### The rule agents work under

An agent may read anything, explain anything, and draft a proposal. It may not change business logic, an API, database, or provider contract, a dependency, or an architectural decision unless an approved specification under [specs/](specs/) covers the change. Specifications are created with `approved: no` in their front matter, and agents are forbidden from approving their own work. Only the maintainer flips that field. Architectural changes additionally require an ADR in [docs/decisions/](docs/decisions/), and every commit carries a `Spec: NNN` or `ADR: NNNN` trailer tying the change back to the decision that authorised it.

The most recent milestone is a worked example. An assistant reviewed the codebase and reported that retrieving comments returned an empty list for every post because nothing ever populated the local snapshot, that comment identifiers could not be persisted at all because the adapter produced `platform:externalId` strings for `uuid` columns, and that the cursor implementation contradicted documented assumption A-008. It wrote those findings up as [specs 008 to 010](specs/) and [ADR-0010](docs/decisions/0010-identifier-mapping.md), all marked `approved: no`, and stopped. Nothing was implemented until those files were approved by hand.

Several approved decisions turned out to be partly wrong once implemented. Spec-008 required fetching an uncached comment from its provider, which is impossible under ADR-0010's opaque derived identifiers because such an identifier carries no provider coordinates. ADR-0010 specified a `findByExternalId` method no caller needed, and claimed an identifier-uniqueness property that only one of five vendors documents. ADR-0012 overstated what `FORCE ROW LEVEL SECURITY` protects against. Three documents now carry an implementation-outcome section recording the correction rather than quietly diverging, because a specification that contradicts the code is worse than no specification.

### What the gate does not do

It does not make the output correct. All three defects above survived every milestone up to the one that fixed them, including the milestones nominally covering tests and production polish, and none was caught by the quality gate: the suite was green throughout, because the tests exercised the same mistaken assumptions the code did. They were found by reading the code against its own documentation. What the gate buys is narrower and still worth having, that decisions are written down before code is written against them, that divergence between decision and implementation is visible, and that every claim in this section can be checked against `specs/`, `docs/decisions/`, and the commit history.

Known limits are stated rather than smoothed over, and [docs/roadmap.md](docs/roadmap.md) and [docs/tasks.md](docs/tasks.md) track the outstanding work — including the findings from this repository's own readiness review, which are recorded whether or not they have been fixed.

### AI Engineering OS

The governance above is not hand-maintained per assistant. It is compiled by [AI Engineering OS](https://github.com/akin-oz/ai-engineering) (`@akinlabs/ai-engineering`), a separate open-source project of mine that exists because every assistant wants its instructions in a different place and format. Copying a few rules into `CLAUDE.md` and `AGENTS.md` is fine until the rules grow or a second assistant appears, at which point the copies drift and a reviewer has to check the same policy in several files.

Instead, project intent lives once in [.ai/](.ai/) as a manifest, rules, agents, hooks, and commands, and the compiler generates the runtime artifacts for each target. This repository declares three rules, thirteen agents, two read-only review teams, and both the Claude and Codex targets; `CLAUDE.md`, `AGENTS.md`, `.claude/`, and `.codex/` are all generated from that source and are never edited by hand.

```bash
pnpm ai:sync      # compile .ai/ into the Claude and Codex runtime artifacts
pnpm ai:validate  # validate the .ai/ workspace without generating output
```

CI runs `pnpm ai:validate` alongside typecheck, lint, formatting, and tests, so a drifted or invalid workspace fails the build like any other defect.

## Status

All thirteen approved specifications are implemented. Retrieving comments for a published post and replying to a comment both work end to end, on PostgreSQL and on in-memory adapters, demonstrable with the commands above.

The PostgreSQL adapter is exercised against a real database. Tenant isolation is proven by a test that removes the repository's own `account_id` predicate and confirms another tenant's rows stay invisible, and CI runs that suite against a PostgreSQL service container.

One thing is deliberately not done: no live provider SDK is selected, so the runnable adapter is a deterministic fixture. The [capability matrix](docs/provider-capability-matrix.md) records what the five real platforms document, from vendor documentation rather than integration testing. [docs/roadmap.md](docs/roadmap.md) tracks what remains.
