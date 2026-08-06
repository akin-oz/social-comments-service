---
spec: 025
title: Make the domain validator guard the mappers it was written for
status: proposed
approved: no
owner: platform and persistence
depends_on:
  - Spec-005
  - Spec-017
  - Spec-020
---

# Spec-025: Make the domain validator guard the mappers it was written for

## Problem / gap

`validateComment` states what a valid `Comment` is, is unit-tested, and is called by nothing in `src/`. It is a definition with no enforcement — the shape of thing this repository has repeatedly found and corrected, recorded as such in [testing.md](../docs/testing.md) and left for a spec rather than deleted or quietly wired in.

The defect class it would catch is not hypothetical here. Every comment reaching a client passes through one of two `toComment` mappers, one per repository adapter, and a mapper that silently produces wrong values is exactly what shipped before: `toOperation` cast a snake_case row to a camelCase type, so every field read as `undefined`, every idempotent retry looked like a different request, and the suite stayed green through the whole milestone. The comment mapper has no such guard either, and neither does the operation mapper that actually failed.

So the question is not whether the guard is worth having. It is what it should do when it fires, and that turns out to be the hard part.

**Wiring it in naively would blame the client for a service defect.** `DomainValidationError` is mapped by the route error handler to `INVALID_REQUEST` with `request_validation_failed` and a `400`. That mapping is correct for its current callers — the query, the reply command, the provider observation — which all validate something a client or a provider supplied. A malformed _stored row_ is none of those. Throwing the same error type from a repository would tell the caller its request was invalid while the actual fault is in this service's data or its mapper, log it at warn, and hide a real defect behind a client error. That is worse than the current state of no validation at all.

## Context and assumptions

- Spec-005 governs test strategy; Spec-020 established that a guard nothing can kill under mutation is worth recording rather than pretending about.
- ADR-0011 governs log levels: a fault the service did not anticipate is an error, and a client mistake is a warning.
- Spec-017 established the code-and-reason taxonomy and the rule that a client branches on values rather than prose.
- Reads return at most 100 comments per page, so per-row validation is a few hundred field checks on a path that has already done a database round trip. Cost is not the deciding factor.
- No production data exists, so no stored row is known to be malformed today.

## Scope

### In scope

1. **Validate a `Comment` where it is constructed**, at the two `toComment` mappers, so every comment leaving a repository has been checked once regardless of which query produced it.
2. **Fail as a service fault, not a client fault.** A malformed row must produce a `500` with an internal reason and an error-level log naming the row, not a `400` telling the caller to fix its request.
3. **Decide the same question for `ReplyOperation`**, whose mapper is the one that actually shipped broken and which has no validator at all.
4. **Resolve `validatePagination`'s unreachable call site** in the same pass: either keep it with the reasoning recorded at the call site, or remove it. Leaving an assertion that no test can kill and no comment explains is the state Spec-020 exists to end.
5. Mutation-check the new guards: removing each must turn a test red.

### Out of scope

- Validating provider observations, which `validateObservedComment` already does at the adapter boundary and which has a killing test.
- Changing `validateComment`'s field rules. What a valid comment is has not changed.
- Runtime schema validation of database rows in general. This is one guard at one choke point, not a persistence-layer type system.

## Contract impact

### API

A malformed stored row becomes a `500` where today it becomes a serialized response with wrong values — or, more likely, a serialization failure whose shape depends on which field is wrong. Either way this is new observable behaviour on a path that should never execute.

One new reason under `INTERNAL_ERROR` for a mapper that produced an invalid comment. Additive, and permitted under the `/v2` compatibility policy.

### Application

A repository can now fail a read for a reason unrelated to the query. That is the intended trade and it has a real cost: **one malformed row makes the page containing it unreadable**, and with keyset pagination that means the run cannot advance past it. See open decisions.

### Domain

None. `validateComment` is unchanged; it simply acquires callers.

## Acceptance criteria

1. Every `Comment` returned by either repository adapter has passed `validateComment`.
2. A row that produces an invalid comment yields a `500` with an internal reason, never a `400`.
3. The failure is logged at error level with enough to find the row, and without the comment body or author display name (ADR-0011).
4. Removing the guard from either adapter fails a test.
5. The historical mapper defect — a row cast rather than mapped, so every field reads as `undefined` — is caught by the guard, demonstrated against a deliberately broken mapper.
6. `validatePagination`'s call site either has a killing test or a comment stating why it cannot have one.
7. Reads of well-formed data are unchanged, including the number of database round trips.

## Verification plan

- A unit test per adapter with a deliberately broken mapper, asserting the typed failure rather than a malformed response.
- A test asserting the failure surfaces as `500`, not `400` — the specific mistake this spec exists to avoid.
- A log test asserting the record is at error level and contains neither body nor display name.
- Mutation: removing each call must turn a test red.
- If the reply-operation guard is in scope after open decision 3, the same set for it, driven by re-applying the row-cast defect.

## Open decisions

1. **Throw, or skip the row and continue.** Proposed: throw. A short page served silently is a gap a client cannot detect, and this repository's recurring failure is precisely that — data quietly missing while the response looks complete. The cost is real and is the reason this is a decision: one bad row blocks the page, and under keyset pagination it blocks every page after it too, so a single corrupt comment can make the rest of a post unreachable. Skipping and counting the skips is the opposite trade: available, lossy, and observable only to whoever reads the metric.
2. **Which error type.** Proposed: a distinct error rather than `DomainValidationError`, because the existing type carries a `400` mapping that is right for its current callers and wrong for this one. Re-mapping `DomainValidationError` by call site would make one type mean two things depending on where it was thrown, which is the ambiguity Spec-017 removed from `IDEMPOTENCY_CONFLICT`.
3. **Whether `ReplyOperation` gets the same treatment.** Proposed: yes. Its mapper is the one that actually shipped broken, it has no validator to call, and writing one is the larger part of the work — which is why it is a decision and not an assumption.
4. **Whether to keep `validatePagination`'s call site.** Proposed: keep, with the reasoning at the call site. It guards an invariant the service constructs in one expression and therefore cannot currently violate; it costs nothing and would catch a future edit that separates the two. Removing it is defensible on the grounds that unreachable code is not free to read.

## Human decision required

Approval requires accepting:

1. That a malformed stored row makes a page of comments unavailable rather than served with wrong values — and that under keyset pagination this can block the remainder of a post. This is the substance of open decision 1 and the reason the spec exists rather than a patch.
2. A new error type and reason, and with them the position that a service-side data fault is a `500` even though it is discovered while serving a client request.
3. The scope of open decision 3: whether this covers comments only, or the reply-operation mapper whose failure motivated the whole guard.
