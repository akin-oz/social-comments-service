---
spec: 001
title: Implement the platform-neutral comment domain model
status: approved
approved: yes
owner: src/comments and src/shared
depends_on:
  - ADR-0001
---

# Spec 001: Implement the platform-neutral comment domain model

## Problem / gap

ADR-0001 defines the domain-model direction, but the repository currently contains only initial type and interface placeholders. The application needs explicit domain contracts before persistence, platform adapters, or REST handlers can be implemented safely.

## Context and assumptions

- ADR-0001 must be accepted before implementation begins.
- Authentication, account ownership, OAuth, and provider credential management exist outside this service.
- External platforms remain the source of truth for provider comments and replies.
- Replies are one level deep in the first implementation.
- Provider-specific SDK types and payloads remain outside the domain layer.
- The existing API and database documents remain the governing design references.

## Scope

### In scope

Update the domain-facing contracts in:

- `src/shared/types.ts`
- `src/comments/contracts.ts`
- `src/comments/comment-service.ts`
- `src/platforms/provider-registry.ts`

Add focused domain tests under:

- `tests/comments/`

Define or finalize:

- `Platform` as a controlled platform identifier.
- `Comment` and `ExternalAuthor` normalized representations.
- Cursor pagination and deterministic page metadata.
- Comment listing query/result contracts.
- Reply command contract with required idempotency key.
- Repository and provider interfaces.
- Typed error categories for unsupported capabilities and invalid domain requests, if needed by the finalized contracts.

### Out of scope

- Database schema implementation or migrations.
- Provider SDK integrations or HTTP calls.
- Fastify route handlers and request validation schemas.
- Authentication, authorization, OAuth, credential storage, or tenant resolution.
- Comment synchronization, webhooks, retries, rate-limit handling, or background jobs.
- Business logic that calls repositories or platform providers.
- Arbitrary provider payload storage, attachments, reactions, moderation state, or nested conversation trees.

## Contract impact

This spec establishes internal TypeScript contracts only. It must not change the public REST contract beyond making the types described in `docs/api-design.md` representable.

The domain contract must not import from Fastify, a database library, a provider SDK, or an infrastructure module. The provider registry may depend on the provider interface, but provider implementations must remain outside this spec.

Any field that is not required by ADR-0001, `docs/api-design.md`, or `docs/database.md` must be treated as an open decision rather than invented during implementation.

## Acceptance criteria

- [x] ADR-0001 is accepted by a human maintainer.
- [ ] The normalized `Comment` model includes stable internal identity, post identity, platform, author, body, parent relationship, and timestamps.
- [ ] Optional fields are used only where absence is part of the documented contract.
- [ ] Pagination uses opaque cursors and exposes `nextCursor` plus `hasMore`.
- [ ] Reply commands require a non-empty idempotency key.
- [ ] Repository and provider interfaces are explicit about input and output types.
- [ ] Provider-specific SDK types do not appear in `src/shared/` or `src/comments/`.
- [ ] The domain contracts do not contain network, persistence, or transport implementation.
- [ ] Tests cover valid comment construction/shape, root comments versus replies, pagination metadata, and command contract validation where validation is introduced.
- [ ] `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, and `pnpm test` pass.
- [ ] `docs/tasks.md` and the roadmap milestone status are updated after implementation.

## Verification plan

1. Review the implementation against ADR-0001 and the relevant API/database documents.
2. Run the typecheck and lint gates to verify dependency direction and strict types.
3. Run focused domain tests, then the complete test suite.
4. Run `pnpm ai:validate` and confirm generated AI artifacts are unchanged unless the governance source changed.
5. Run the read-only `architecture-guardian` and `contract-guardian` reviews.

## Open decisions

- Should `Platform` remain a compile-time union or move to a runtime-validated registry as providers expand?
- Should domain validation be implemented as constructors/functions or remain at the API boundary for this milestone?
- Which timestamp precision and serialization rules must repository adapters guarantee?
- Should provider external identifiers be part of the domain contract now or remain persistence/provider-adapter details?

## Approval gate

ADR-0001 and this spec have been approved by the human maintainer. Implementation remains limited to the scope and acceptance criteria above.
