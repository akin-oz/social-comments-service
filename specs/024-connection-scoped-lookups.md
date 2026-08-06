---
spec: 024
title: Scope provider-identifier lookups to the connection that issued them
status: accepted
approved: yes
owner: platform-integration
depends_on:
  - ADR-0013
  - Spec-015
  - Spec-016
---

# Spec-024: Scope provider-identifier lookups to the connection that issued them

## Problem / gap

Uniqueness of a provider comment identifier is scoped to a social account — `unique (social_account_id, external_comment_id)` — because ADR-0013 established that no vendor guarantees more than that. One lookup ignores that scope.

`CommentRepository.findByExternalId` queries `where c.account_id = $1 and c.external_comment_id = $2` and takes the first row. A tenant with two connections on one platform can hold two rows with the same provider identifier, legitimately, and the query is then ambiguous — it returns whichever row the planner produces first.

That method exists for one purpose: Spec-015's reconciliation, which resolves a pending reply operation against the comment its `external_reply_id` names. Under two connections it can resolve to a comment published through a _different_ connection, and mark the operation completed against the wrong reply. The blast radius is small and the failure is silent, which is the bad combination.

It was invisible until now for a structural reason worth recording: every seed tenant had exactly one social account, so the ambiguity could not arise in any fixture. Adding a second connection for the parent-join test surfaced it immediately — the test passed on the first run and failed on the second, because which row came back changed.

The same shape appears in `upsertMany`'s read-back, which selects `where c.account_id = $1 and c.external_comment_id = any($2)`. That one is currently safe because the observations in a batch all come from one provider call and therefore one connection, but nothing in the query says so.

## Context and assumptions

- ADR-0013: identity is assigned; deduplication keys on `(social_account_id, external_comment_id)`.
- Spec-016: every provider call carries the `SocialConnection` it acts as, so the caller of a reconciliation already knows the right connection or can reach it.
- One tenant with several connections on one platform is the ordinary agency arrangement the schema deliberately permits — the same case ADR-0013 cites for two tenants sharing one account.
- No production data exists, and no live adapter, so no wrong reconciliation has occurred.

## Scope

### In scope

1. **Scope `findByExternalId` by social account**, so it can return at most the one row the uniqueness constraint guarantees.
2. **Give the reconciliation path the connection it needs.** A reply operation knows its parent comment, and the parent's `social_account_id` is the connection the reply went out through.
3. **Scope the `upsertMany` read-back** the same way, so the guarantee is stated in the query rather than inferred from the caller.
4. **Keep a fixture with two connections under one tenant**, so both predicates stay reachable.
5. Mutation-check both: dropping either scope must turn a test red.

### Out of scope

- Changing the uniqueness constraint, which ADR-0013 settled and vendor documentation supports.
- The parent-join predicate, which is already correctly scoped and now has a killing test.
- Exposing the social account on the API. Spec-016 deliberately keeps it below the boundary.

## Contract impact

### Application

`CommentRepository.findByExternalId` gains the social account, or is replaced by a lookup that takes the operation and resolves the connection itself. The second is narrower and harder to misuse.

### Persistence

No migration. The index that serves the constraint already serves the scoped query.

### Domain

None visible. The change is entirely inside the repository boundary.

## Acceptance criteria

1. A tenant holding the same provider comment identifier under two connections resolves each to its own row, deterministically.
2. Reconciling a reply operation resolves against the connection the reply was published through, never another.
3. Dropping the social-account scope from `findByExternalId` fails a test.
4. Dropping it from the `upsertMany` read-back fails a test.
5. Repeated runs against a database that already holds rows give the same answer.
6. Every existing reconciliation test still passes.

## Verification plan

- An integration test creating the same provider identifier under both of tenant A's connections and asserting each resolves to its own row. It fails against the current unscoped query, non-deterministically — so it must be run repeatedly, or forced by asserting the specific expected row.
- A reconciliation test where the wrong-connection comment exists, asserting the operation completes against the right one.
- Both mutations, each shown to turn the suite red.

## Open decisions

1. **Widen the signature or narrow the method.** Proposed: narrow it — replace `findByExternalId(context, externalId)` with a reconciliation-shaped lookup that takes the operation, so a caller cannot supply the wrong connection. Widening is a smaller diff and keeps a general-purpose method that is easy to misuse again.
2. **Where the connection comes from during reconciliation.** Proposed: the parent comment's `social_account_id`, resolved in the same query. The alternative is recording the connection on the reply operation, which is more explicit and adds a column.
3. **Whether the `upsertMany` read-back needs it at all**, given its caller only ever passes one connection's observations. Proposed: yes. "Safe because of how it happens to be called" is what the parent-join predicate looked like before a fixture made it reachable.

## Human decision required

Approval requires accepting:

1. A repository interface change, in a method added only recently by Spec-015 and used in one place.
2. That this is a correctness fix for a case no current deployment can hit, prioritised because the fixture that revealed it now exists and will keep revealing it.
