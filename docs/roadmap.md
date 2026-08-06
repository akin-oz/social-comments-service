# Implementation roadmap

## Milestone 1 — Project initialization

### Goal

Establish a reproducible TypeScript service skeleton and shared engineering conventions.

### Deliverables

- pnpm package and TypeScript configuration.
- Fastify, Vitest, ESLint, and Prettier tooling.
- Repository documentation, assumptions, architecture, and roadmap.
- ADR location and CI quality-gate placeholder.

### Definition of done

The repository installs and passes typecheck, lint, formatting, and test commands without business logic.

## Milestone 2 — Domain model

Status: Complete

### Goal

Define stable comment, post, platform, pagination, and error contracts.

### Deliverables

- Domain types and validation boundaries.
- Typed application commands and results.
- Error taxonomy and capability model.
- Runtime validation for normalized comments, pagination, list queries, and reply commands.
- Focused domain-model tests.

### Definition of done

Contracts are platform-neutral, documented, and covered by focused unit tests.

## Milestone 3 — Platform abstraction

Status: Complete

### Goal

Hide provider APIs behind explicit adapter interfaces.

### Deliverables

- Provider registry and adapter lifecycle.
- Provider-to-domain mapping contracts.
- Capability and rate-limit behavior.

### Definition of done

A provider can be added without changing route semantics, and unsupported operations are explicit.

## Milestone 4 — Repository layer

Status: Complete

### Goal

Persist normalized comments and reply operation state behind interfaces.

### Deliverables

- Database migrations/schema implementation.
- Comment and reply-operation repositories.
- Cursor query strategy and uniqueness constraints.

### Definition of done

Repository behavior is deterministic, transaction boundaries are documented, and integration tests cover constraints.

## Milestone 5 — REST API

Status: Complete

### Goal

Expose the documented read and write operations through Fastify.

### Deliverables

- Request schemas and response serializers.
- Authentication/authorization integration points.
- Error mapping, request IDs, and idempotency handling.

### Definition of done

The API matches `api-design.md`, rejects invalid input, and does not leak provider-specific implementation details.

## Milestone 6 — Tests

Status: Complete

### Goal

Make the service behavior safe to change.

### Deliverables

- Domain unit tests.
- Provider adapter contract tests.
- Repository integration tests.
- API integration tests and failure-path coverage.

### Definition of done

Critical paths and provider failure modes are covered, and the CI quality gate is meaningful.

## Milestone 7 — Documentation

Status: Complete

### Goal

Keep design and operational knowledge usable for reviewers and maintainers.

### Deliverables

- ADRs for material decisions.
- Provider capability matrix.
- Local development and configuration guide.
- API examples and operational notes.

### Definition of done

A new engineer can run the service, understand its boundaries, and add a provider using the docs.

## Milestone 8 — Final polish

Status: Complete

### Goal

Prepare the implementation for production-oriented review.

### Deliverables

- Structured logging and metrics boundaries.
- Timeouts, retries, and rate-limit policy.
- Security and data-retention review.
- Dependency and delivery hygiene.

### Definition of done

The system’s reliability, security, and operational trade-offs are explicit and verified at the appropriate level.

## Milestone 9 — Provider-backed reads and core gaps

Status: Complete

### Goal

Make the core assignment requirements work end-to-end and close correctness gaps discovered during review.

### Deliverables

| Deliverable                                                           | Spec / ADR | State |
| --------------------------------------------------------------------- | ---------- | ----- |
| Provider-backed reads with cache-miss hydration                       | Spec 008   | Done  |
| Internal UUID identity with external-ID mapping at adapter boundaries | ADR 0010   | Done  |
| Keyset pagination over the `(post_id, published_at, id)` index        | Spec 009   | Done  |
| Reply-path hardening: timeouts, rate limits, idempotency claim        | Spec 010   | Done  |
| Fixture provider so the service runs without external dependencies    | Spec 008   | Done  |
| PostgreSQL runtime, RLS verification, Docker, and seed                | Spec 012   | Done  |

### Definition of done

`GET /v2/posts/{id}/comments` returns provider comments on first call, `POST /v2/comments/{id}/replies` publishes to a fixture provider, all Postgres code is integration-tested with RLS verified across two tenants, cursors are keyset-based, and `pnpm dev` + curl demonstrates both endpoints working.

### Remaining

Nothing. PostgreSQL persistence runs, tenant isolation is verified against a real database across two tenants, and `docker compose up` yields a working system.

Two implementation outcomes diverge from their approved text and are recorded in the documents themselves: Spec-008 acceptance criterion 3 is unreachable under ADR-0010 identifiers, and ADR-0012 overstated what `FORCE ROW LEVEL SECURITY` protects against.

## Milestone 10 — Submission readiness

Status: Done

### Goal

Make the repository answer the assignment brief directly, for a reviewer reading it cold.

### Deliverables

| Deliverable                                                            | State | Blocks submission |
| ---------------------------------------------------------------------- | ----- | ----------------- |
| Contract alignment: limits, header auth, `INTERNAL_ERROR`, cursor docs | Done  | —                 |
| AI usage disclosure replacing the README placeholder                   | Done  | —                 |
| "Design decisions" summary in the README linking to the ADRs           | Done  | —                 |
| Provider capability matrix populated from public API research          | Done  | —                 |
| OpenAPI generated from the Fastify schemas                             | Done  | —                 |

### Definition of done

A reviewer can read the README and see what was built, which decisions were made and why, what was assumed, and how AI was used, without opening ten ADRs to assemble it.

### Submission readiness

The brief asks for four things: a database schema, an API design, relevant TypeScript code, and an explanation of major design decisions, plus a description of AI usage and documented assumptions.

Schema, API design, code, assumptions, and the AI disclosure are all present, and the two required operations work end to end against both the in-memory and PostgreSQL compositions. Two gaps remain, neither of them in the implementation:

Nothing blocks submission. The README now states the seven decisions that shaped the service, what each cost, and what was deliberately left out, with links into the ADRs and specifications for depth.

The capability matrix is grounded in vendor documentation for all five platforms, which both justifies the provider abstraction and raised three items. All three are now closed: ADR-0013 replaced the identifier derivation with assigned identity, Spec-014 made the stored provider cursor best-effort with a restart on rejection, and ADR-0014 turned A-005 from an assumption about platforms into an enforced normalisation of this service's own.

## Milestone 12 — Second delivery-readiness sweep

Status: Done

### Goal

Re-run the readiness board against the remediated repository, and close what it finds.

### What it found

The suite was green at 161 tests, both compositions served real HTTP, and tenant isolation held under a live mutation. It still found one product defect, one broken demo, and a long tail of tests that could not fail.

| Finding                                                         | Closed by | Proved by                                                           |
| --------------------------------------------------------------- | --------- | ------------------------------------------------------------------- |
| A deep cursor walk returned 20 of 60 and reported completion    | Spec-021  | The reproduction is a test; three mutations of the fix turn it red  |
| Oversized bodies and bad JSON became 500s with stack traces     | Spec-022  | Both asserted at 4xx with nothing reaching error level              |
| `X-Request-Id` trusted verbatim into every log record           | Spec-022  | A 229-character value no longer reaches the response                |
| The fingerprint did not provably bind the comment               | Spec-023  | One key replayed against two parents now conflicts                  |
| The fingerprint was a dictionary oracle for short bodies        | Spec-023  | HMAC; the digest cannot be recomputed without the secret            |
| `findByExternalId` ambiguous under two connections              | Spec-024  | The wrong-connection row exists and is not the one resolved         |
| Fourteen service and persistence behaviours mutable while green | Spec-020  | Each re-applied and shown red, including the pooled-connection leak |
| The README's reply demo 404'd verbatim                          | —         | Run against Docker, end to end, before and after                    |
| No CI drift check for the generated `.ai/` artefacts            | —         | `pnpm ai:sync && git diff --exit-code` added                        |

### Definition of done

Every finding closed with a demonstrated failing mutation, or recorded as a deliberate limitation with its reasoning.

The last of them, `validateComment` being defined and tested but wired into nothing, is closed by [Spec-025](../specs/025-mapper-output-validation.md): both `toComment` mappers now guard their output, `ReplyOperation` has the validator its mapper never had, and the failure is reported as a service fault rather than a client one. One deliberate limitation remains — `validatePagination`'s call site is an unreachable defensive assertion no test can kill — kept with its reasoning at the call site rather than given a test that would only re-test the validator.

## Milestone 11 — Review-board findings

Status: Done

### Goal

Close what two read-only review boards found by re-applying real defects, rather than by reading for style.

### What was found and what happened

Eighteen items. Five were already fixed and double-counted across the two reports, which is itself worth recording: a backlog that reports closed work as open is the same claim decay the boards exist to catch. The remaining thirteen were closed under seven approved documents.

| Finding                                                       | Closed by | Proved by                                                                 |
| ------------------------------------------------------------- | --------- | ------------------------------------------------------------------------- |
| A crash between claim and completion poisoned the key forever | Spec-015  | Four mutations of the lease and recovery logic each turn the suite red    |
| `pending` meant both "in flight" and "outcome unknown"        | Spec-015  | A timeout after send is now `unknown`, a rate limit stays `failed`        |
| The provider port had nowhere to carry a credential           | Spec-016  | Two tenants on one platform reach the provider with different connections |
| `IDEMPOTENCY_CONFLICT` was three situations behind one code   | Spec-017  | Four distinct reasons, asserted; the enum cannot drift from the schema    |
| `Retry-After` and the cursor rule lived only in prose         | Spec-017  | Both now in the generated document, both asserted                         |
| The service role's attributes were never pinned               | Spec-018  | A test drifts the role to `SUPERUSER` and asserts the migration fixes it  |
| `accounts` had no row-level security                          | Spec-018  | The predicate-removed proof covers all five tenant-scoped tables          |
| The in-memory adapter scoped tenants by prefix match          | Spec-018  | An account identifier containing the delimiter cannot cross the boundary  |
| Deletion semantics and the platform constraint were undefined | Spec-018  | Stated in migration 006 and in `docs/database.md`                         |
| Concurrent readers multiplied provider load                   | Spec-019  | Five concurrent cold reads now cost the provider traffic of one           |
| Five test mutations survived a green suite                    | Spec-020  | Each re-applied and shown to turn the suite red                           |
| A broken test glob produced a green build running zero tests  | Spec-020  | A spawned run with a deliberately broken glob must fail                   |
| A-005 was documented but unenforced                           | ADR-0014  | Replying to a reply is refused; neutralising the check fails two tests    |

### Definition of done

Every finding either closed with a demonstrated failing mutation, or recorded as a deliberate limitation with its reasoning. Two limitations are recorded rather than fixed: single-flight deduplication is per replica, and the model still cannot represent a reply whose resolved parent differs from the requested one, which Instagram does silently.
