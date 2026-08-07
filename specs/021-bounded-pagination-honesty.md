---
spec: 021
title: Stop a bounded pagination run reporting completion it did not reach
status: accepted
approved: yes
owner: api
depends_on:
  - Spec-009
  - Spec-014
paths:
  - src/comments/**
  - src/api/**
---

# Spec-021: Stop a bounded pagination run reporting completion it did not reach

## Problem / gap

A full cursor walk over a post whose provider stream is deeper than the hydration bound returns a fraction of the comments and then reports that there are no more.

Reproduced, not inferred. Sixty comments, a newest-first provider returning one per page, the default `limit: 25`:

```
requests=3  providerCalls=60  distinctSeen=20 of 60  finalCursorNull=true
```

Every one of the sixty was fetched and stored. The client saw twenty and was told the run was over. A second walk, started fresh against the now-complete snapshot, returns all sixty — so nothing is lost from the database, only from that run.

The mechanism is the one Spec-014 was written to fix, returning at a scale its fixture never reached:

1. A starting run completes the snapshot first, because provider order is newest-first and this API's order is ascending `publishedAt`. That is the invariant: **a run pages a snapshot that does not move underneath it.**
2. `MAX_HYDRATIONS_PER_REQUEST = 20` bounds that completion, so a post deeper than twenty provider pages starts its run over a snapshot holding only the twenty _newest_ comments.
3. The cursor advances through those twenty. Later hydrations then backfill comments that are _older_, so they land behind the cursor and are unreachable for the rest of the run.
4. When the stream finally exhausts, `hasMore = page.hasMore || !state.exhausted` evaluates false, `nextCursor` is null, and the run ends.

The bound is right; breaking the invariant silently is not. `snapshot.syncedAt` is `null` throughout, which is the only signal a client gets, and nothing in the contract says a null `syncedAt` invalidates the run.

The test that should have caught it uses three provider pages against a bound of twenty, so both `MAX_HYDRATIONS_PER_REQUEST = Infinity` and `hasMore = page.hasMore` survive as mutations.

## Context and assumptions

- Spec-014 established that starting a run completes the snapshot, and bounded that completion deliberately to keep one request from becoming unbounded work.
- A-008 prefers cursor pagination; Spec-009 makes the cursor a keyset over `(publishedAt, id)`.
- Providers really do return newest-first: Meta, X, and YouTube all do. This is the ordinary case, not an edge case.
- Nothing is lost from persistence. The defect is confined to the run in progress.

## Scope

### In scope

1. **A run must never report completion over a snapshot that is not complete.** `hasMore` must stay true while the provider stream is unexhausted, and the response must remain resumable.
2. **A run started over an incomplete snapshot must be able to reach every comment**, or must say plainly that it cannot and what the client should do instead.
3. **Make the fixture deeper than the bound**, so the guard is reachable at all. Three pages against a bound of twenty tests nothing about the bound.
4. **Kill both mutations**: raising the bound to infinity, and reducing `hasMore` to `page.hasMore`.
5. State the resulting client obligation in `docs/api-design.md` alongside the existing pagination-loop guidance.

### Out of scope

- Removing the bound. Unbounded provider work inside one request is what Spec-014 refused, for the same reasons.
- Changing the cursor encoding or the ascending order. Both are settled by Spec-009 and A-008.
- Background hydration that completes a snapshot outside a request. That would remove the case entirely and needs its own spec; A-006 already defers background synchronisation.

## Contract impact

### API

This is where the decision bites, and the options are not equivalent.

**Option A — keep the run resumable and let it finish the backfill.** While the snapshot is incomplete, `hasMore` stays true and the cursor keeps its position; each request hydrates further and eventually the older comments become reachable. Problem: they are _behind_ the cursor, so they never are. This does not work without also rewinding the cursor, which duplicates items already returned.

**Option B — a run over an incomplete snapshot is explicitly partial, and the client restarts.** `hasMore` stays true until the snapshot is exhausted, and the response says the run is over a snapshot still being read. When the snapshot completes, the client starts again from no cursor and sees everything. Costs a restart; never lies. The reproduction above shows the restart already works.

**Option C — do not begin a run until the snapshot is complete.** The first request either completes the snapshot or answers with an explicit "not ready" state, and only then does paging begin. Cleanest semantics, worst first-read latency for a large post, and it introduces a state the API does not currently have.

Proposed: **B**. It preserves the existing shape, requires no new state, and the behaviour it needs — a restart over a complete snapshot returning everything — is already demonstrated.

Whichever is chosen, the pagination fields change meaning at the margin, so this is a contract change even though no field is added or removed.

### Application

`hasMore` and the cursor decision move out of a single boolean expression, because the incomplete-snapshot case has to be distinguishable from the ordinary end of a page.

## Acceptance criteria

1. A full cursor walk over a post deeper than the hydration bound returns every comment, or terminates with an explicit signal that the run was partial and must be restarted — never with `hasMore: false` and comments unreturned.
2. `hasMore` is false only when the provider stream is exhausted **and** the local page is the last one.
3. Raising `MAX_HYDRATIONS_PER_REQUEST` to infinity fails a test.
4. Reducing `hasMore` to `page.hasMore` fails a test.
5. A fixture exists with more provider pages than the bound, and the walk over it is asserted end to end.
6. `docs/api-design.md` states what a client must do when a run is served over an incomplete snapshot.
7. The existing shallow-post behaviour is unchanged.

## Verification plan

- The reproduction above, as a test: sixty comments, one per provider page, newest-first, asserting the walk sees all sixty. It fails against the current implementation, returning twenty.
- A test asserting `hasMore` is true at the moment the bound is hit.
- The two mutations, each shown to turn the suite red.
- A test that a shallow post — fewer pages than the bound — still reports `hasMore: false` exactly once, so the fix does not make every run claim to be incomplete forever.

## Open decisions

1. **Which of A, B, C.** Proposed B, for the reasons above. C is the most honest model and the most disruptive; A does not actually work.
2. **How a partial run announces itself.** Proposed: `hasMore: true` with `snapshot.syncedAt: null` is already the signal, and the contract simply has to say it is binding. The alternative is a new field, which is more discoverable and adds surface.
3. **Whether the bound should be higher.** Twenty provider pages at a hundred comments each is two thousand comments, which is a large post but not an unusual one. Raising it trades first-read latency for fewer partial runs and does not remove the case.
4. **Whether a post whose stream never exhausts within any reasonable budget needs a different answer entirely** — for example newest-first delivery, which matches what a human wants from a comment feed and sidesteps the ordering problem.

## Human decision required

Approval requires accepting:

1. That a client may have to restart a pagination run over a very large post, which is new client-visible behaviour.
2. The option chosen in open decision 1, which is a genuine product judgement about what pagination means over a snapshot the service is still filling.
3. That the bound stays, so very large posts are served partially rather than slowly.
