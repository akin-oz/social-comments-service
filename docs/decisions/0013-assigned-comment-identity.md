---
adr: 0013
title: Assign comment identity instead of deriving it
status: proposed
supersedes: ADR-0010
---

# ADR-0013: Assign comment identity instead of deriving it

## Context

ADR-0010 derives a comment's internal identity as `uuidV5(namespace, "platform:externalId")`. That decision is now known to be wrong in a way that produces a cross-tenant availability defect, and the evidence arrived from three independent directions.

**The derivation grain does not match the constraint grain.** Identity is derived per platform. The uniqueness constraint that governs storage is `(social_account_id, external_comment_id)` — per connected account. Two tenants who connect the same Instagram account, an ordinary agency-and-client arrangement that `social_accounts` deliberately permits, derive the same UUID for the same provider comment. The second insert violates `comments_pkey` rather than the conflict target the upsert names, so it is unhandled: the whole hydration batch rolls back, and row-level security hides the colliding row, leaving the failure undiagnosable from the affected tenant's side.

**The premise was never supported.** ADR-0010 claimed every modelled provider issues platform-unique comment identifiers. Reading the vendor documentation showed only X documents that. YouTube, Facebook, and Instagram state no uniqueness scope, and LinkedIn explicitly warns that the URN it returns "is not a reliable identifier". That correction is already recorded in ADR-0010, but the decision built on the premise was left standing.

**The derivation buys less than it costs.** Its stated benefit was that re-observing a provider comment converges on one row without a lookup. The upsert already achieves that through the unique constraint, and it already returns the resulting row identifier — `upsertComment` executes `returning id` and discards the value.

## Decision

**Stop deriving comment identity. Let the database assign it.**

1. `comments.id` gains `default gen_random_uuid()`. The application no longer computes an identity before insert.
2. `upsertMany` returns the identifiers the database assigned, rather than echoing the input it was given. The `returning id` already present is read instead of discarded.
3. `src/shared/identity.ts` is deleted, along with the derivation of `parentCommentId` from an external parent identifier on read. The parent is resolved by looking up the stored row for `(social_account_id, external_parent_comment_id)`, which is the key that actually identifies it.
4. Identity is scoped exactly where the constraint scopes it: to the connected social account. Two tenants sharing one provider account get two rows, which is correct, because a comment is visible to each of them independently and the audit trail for each is their own.

## Consequences

The collision disappears, because two tenants no longer compute the same primary key. The uniqueness the system relies on becomes a single fact enforced in one place, rather than an application-side derivation that has to agree with a database constraint.

Comment identifiers stop being reproducible from provider data. That is a small security improvement, since a derived identifier over a committed namespace can be confirmed offline by anyone who knows a provider comment id, and it removes the temptation to treat identity as a pure function of provider state.

The costs are real. A stored comment's identity is no longer computable, so any code path that needs an identity before insert must insert first. Existing rows would need rewriting if this were deployed with data, and every outstanding cursor encodes an identity that would no longer resolve.

**This is why the timing matters.** With no live adapter and no production data, the change is an hour and a migration on empty tables. After a live adapter exists it is a full-table migration plus global cursor invalidation, and the collision it prevents will already have happened to somebody.

## Alternatives considered

**Fold the social account into the derivation.** `uuidV5(namespace, "socialAccountId:externalId")` matches the constraint grain and fixes the collision, keeping determinism. Rejected because it retains an application-side derivation that must stay in agreement with a database constraint forever, and the determinism it preserves buys nothing the upsert does not already provide. It is the smaller diff and the weaker design; if this ADR is rejected, this is the fallback that must be adopted instead.

**Keep the derivation and handle the collision.** Catch the unique violation and fall back to a lookup. Rejected as complexity spent defending a decision rather than correcting it, and it leaves the two tenants sharing one row's identity, which the audit trail should not do.

**Do nothing until a live adapter exists.** Rejected because that is precisely the point at which the fix becomes expensive, and the defect becomes real.
