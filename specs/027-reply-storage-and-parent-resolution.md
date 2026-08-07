---
spec: 027
title: Store a published reply without overwriting, and know when a parent is unsynced
status: implemented
approved: yes
owner: platform-integration
paths:
  - src/comments/**
  - src/repositories/**
  - src/shared/types.ts
  - src/shared/validation.ts
---

# Spec-027: Store a published reply without overwriting, and know when a parent is unsynced

> **Process note.** Implemented in the same session this was written, as a
> deliberate exception by the maintainer.

## Problem

Two findings from the `principal-review` board that meet in the same code.

**P0-2 — `parentCommentId` collapses "no parent" and "parent not yet synced."**
The LEFT JOIN that resolves a parent answers `null` both when the provider named
no parent and when it named one this service has not stored. The reply-depth gate
(ADR-0014) reads that value, so an unresolved parent was treated as a top-level
comment and the reply was permitted — publishing the two-level thread the rule
exists to refuse. Newest-first providers deliver replies before their parents, so
this is the ordinary case on any post large enough to paginate, not a rare one.

**P2 — a published reply could overwrite a customer's comment.** The reply path
shared hydration's upsert, whose conflict clause is
`on conflict … do update set body = excluded.body`. That is correct for
hydration, which is reconciling with the provider and should absorb an edit. It
is wrong for publication: if the provider returns an identifier that already
names a different stored comment, the reply's text is written over a customer's
own comment — content this service does not own and cannot recover.

## Scope

### In scope

1. `Comment` gains `parentUnresolved: boolean`, per [ADR-0016](../docs/decisions/0016-unresolved-parent-is-a-third-state.md).
   The PostgreSQL adapter selects `external_parent_comment_id` alongside the
   resolved `parent.id` and derives the flag; the in-memory adapter mirrors it.
2. The reply-depth gate refuses `parentCommentId !== null || parentUnresolved`.
3. `validateComment` rejects a comment claiming both, which is unrepresentable
   by construction.
4. `CommentRepository.storePublishedReply` replaces `upsertMany` on the reply
   path. It inserts with `on conflict … do nothing`; an existing row holding the
   identical reply is returned unchanged, so the recovery path stays idempotent;
   an existing row holding anything else raises `INTERNAL_ERROR` /
   `reply_not_stored` rather than overwriting it.
5. Tests that can fail, at both adapters:
   - an unsynced parent is refused a reply, and a genuine top-level comment is
     not;
   - the flag clears once the parent arrives;
   - a colliding publish leaves the existing body intact;
   - storing the same reply twice returns the same row.

### Out of scope

- Hydrating on demand to resolve a parent during a reply. The cheap answer and
  the expensive answer agree; see ADR-0016.
- Instagram's silent reattachment, which remains unmodelled and stays assigned
  to domain work by ADR-0014 §4.
- A new `reason` for the collision. It shares `reply_not_stored`, because the
  client's situation and the action it should take are identical and the reason
  vocabulary should not grow a member per internal cause (Spec-017).

## Verification

Reverting the gate to `parentCommentId !== null` makes the unsynced-parent test
resolve instead of rejecting — the two-level thread published. Both collision
tests are exercised against PostgreSQL, where the destructive clause lived.
