# ADR-0016: An unresolved parent is a third state, not a missing one

- **Status:** accepted
- **Date:** 2026-08-07
- **Extends:** [ADR-0014](0014-reply-depth.md)
- **Related:** [ADR-0013](0013-assigned-comment-identity.md), [Spec-027](../../specs/027-reply-storage-and-parent-resolution.md)

> **Process note.** Implemented in the same session it was written, as a
> deliberate exception by the maintainer. See the note in [ADR-0015](0015-rate-limit-does-not-prove-refusal.md).

## Context

`Comment.parentCommentId` is resolved by a LEFT JOIN from the comment's
`external_parent_comment_id` onto the stored comment holding that provider
identifier. The join answers `null` in two entirely different situations:

- the provider named no parent — a genuine top-level comment;
- the provider named a parent that this service has not stored yet.

ADR-0014 gates the reply path on that value: a comment with a parent is itself a
reply, and replying to it would build a two-level thread the model cannot
express. Reading the join's `null` as "no parent" meant the second situation was
treated as the first, and the reply was permitted.

This is not a rare interleaving. The capability matrix records Meta, X, and
YouTube as returning comments newest-first, and the read path depends on that
fact. A reply is newer than the comment it answers, so replies systematically
arrive in _earlier_ provider pages than their parents. Against the twenty-call
hydration bound, an unresolved parent is the ordinary state of any post large
enough to paginate — not an edge case.

The consequences differ by platform. On X and Facebook, which the matrix records
as nesting arbitrarily deep, the two-level thread is published and persists. On
Instagram the provider silently reattaches the reply to the top-level comment,
so the snapshot and the provider disagree about where the reply lives until the
next hydration corrects it.

## Decision

**Carry the distinction into the domain, and treat "unresolved" as ineligible
for a reply.**

`Comment` gains `parentUnresolved: boolean`, true only when the provider named a
parent and no stored row holds that identifier. The disambiguating value already
existed on the row — `external_parent_comment_id` — and simply was not selected;
this decision selects it and states what it means.

The reply-depth gate becomes `parentCommentId !== null || parentUnresolved`.

A comment whose parent is unresolved _is_ a reply. The service does not know
which reply, but it does not need to: the question the gate asks is whether this
comment is already one level down, and the provider has answered that.

## Why not resolve the parent instead

Hydrating on demand to find the parent was considered and rejected. It turns a
validation check into a provider call on the write path, it can fail, and it can
be slow — and the answer it returns does not change the outcome, because either
way the comment is a reply and either way the request is refused. The cheap
answer and the expensive answer agree.

## Consequences

- Both adapters must compute the flag identically, or the demo composition and
  the shipped one enforce different rules. The PostgreSQL adapter derives it
  from the selected `external_parent_comment_id`; the in-memory adapter mirrors
  the join's miss. Integration tests pin both, including that the flag clears
  once the parent arrives.
- `validateComment` rejects a comment claiming both a resolved and an unresolved
  parent, which is unrepresentable by construction and therefore an adapter bug
  if it appears.
- Some replies to genuinely top-level comments are refused while their post is
  still hydrating, if the provider named a parent this service has not yet seen.
  This is the deliberate direction of the trade: refusing a valid reply is
  recoverable by retrying after hydration completes; publishing an invalid one
  is not.
- The flag is internal. It does not appear in the API response, because it
  describes the service's own sync state rather than anything true of the
  comment at the provider.

## What this still does not model

A reply whose _resolved_ parent differs from the _requested_ one — Instagram's
silent reattachment — remains unrepresentable. ADR-0014 §4 assigned that to
domain-model work and it stays there: this decision fixes which comments may be
replied to, not what happens to a reply after the provider moves it.
