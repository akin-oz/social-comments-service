---
spec: 038
title: Bound snapshot completion by progress and refuse it over a silent restart
status: proposed
approved: no
owner: read path completeness
depends_on:
  - Spec-013
  - Spec-014
  - Spec-021
paths:
  - src/comments/comment-service.ts
  - src/repositories/postgres.ts
  - src/repositories/in-memory.ts
---

# Spec-038: Bound snapshot completion by progress and refuse it over a silent restart

## Problem / gap

Snapshot completion has two defects that the deep-pagination work of Spec-021 came
close to but did not reach. Both live in `CommentService`, in the hydration loop
(`runHydration`) and the single line of `hydrate` that stamps completion. One is a
liveness defect — a large post that can never finish. The other is an honesty defect
— a post reported finished that is not. They share a cause: the loop reasons about
provider calls, and completion is decided by one provider `hasMore` boolean, with no
account of whether the run is actually covering new ground.

### 1. A restart re-walks the same pages forever, so a large post never completes

`runHydration` bounds itself by call count:

```ts
while (
  this.needsHydration(state, request.startingRun, returned, request.limit) &&
  hydrations < MAX_HYDRATIONS_PER_REQUEST // 20
) {
  const next = await this.hydrate(context, post, state);
  ...
}
```

`hydrate` treats a loud `ProviderCursorRejectedError` as expected and restarts the
stream from the beginning (`this.fetchPage(provider, post, null)`), which Spec-014
established and which is safe because upserts deduplicate. The restart is correct.
What is missing is that the restart is not free against this budget: it re-fetches
every page already stored, and each re-fetch counts as one `hydrations`.

Reproduced in shape, not inferred. Twenty-five provider pages, one comment each,
`MAX_HYDRATIONS_PER_REQUEST = 20`, and a provider that accepts a cursor within the
request that issued it but rejects it once it has been stored and reloaded on a later
request — the "added or deleted between requests" invalidation Facebook documents:

```
request 1   provider accepts fresh cursors -> reads pages 0..19 (20 calls)
            stored=20  cursorAt=page20  exhausted=false  syncedAt=null
request 2   stored page-20 cursor rejected -> restart page 0
            -> re-walk pages 0..19 (20 calls, all already stored) -> budget spent
            stored=20  cursorAt=page20  exhausted=false  syncedAt=null
request N   ...identical. Pages 20..24 are never fetched.
```

The run spends its entire budget re-covering pages it already holds, saves a
page-20 continuation it never gets to try, and stops. The next run loads that
continuation, the provider rejects it again, and the restart repeats. `exhausted`
never becomes true and `completedAt` stays null forever. Nothing is lost — the first
twenty are stored — but the last five are unreachable by any number of restarts. The
client is told, correctly, that the run was partial and to start again (Spec-021's
`syncedAt: null` contract); starting again never advances it. This is a livelock, not
a lie, and the bound the run needs is progress, not call count.

### 2. `completedAt` certifies a stream a silent restart never finished

`hydrate` decides completion from one boolean:

```ts
return page.hasMore
  ? { providerCursor: page.nextProviderCursor, exhausted: false, completedAt: null }
  : { providerCursor: null, exhausted: true, completedAt: new Date().toISOString() };
```

`page.hasMore === false` is taken to mean the stream this run was reading reached its
end. The only cursor failure the code anticipates is the loud one — an exception
mapped to `ProviderCursorRejectedError`. But the vendor guidance the stored cursor
rests on documents only that cursors become invalid, not that invalidation is
signalled: Facebook's pagination guide says *"Don't store cursors. Cursors can
quickly become invalid if items are added or deleted"* (recorded in
`docs/provider-capability-matrix.md`), and says nothing that guarantees a stale
cursor is refused rather than accepted and answered from a different position.

So consider a post already hydrated to page 20 across earlier requests, and a fresh
first-page request (`cursor.after === null`, a polling client or a page reload — the
Spec-013 case). `needsHydration` is true, the run resumes from the stored page-20
cursor, and the provider does not raise: it accepts the stale cursor and answers with
the newest page and `hasMore: false`. `hydrate` reads `page.hasMore === false`,
returns `{ exhausted: true, completedAt: now }`, and `saveSnapshotState` commits it —
its compare-and-set matches, because the expected state is exactly the page-20 state
that was stored. Back in `listComments`, `partialRun = startingRun ? !state.exhausted
: cursor.partialRun` is now `false`, so the response carries `snapshot.syncedAt:
<timestamp>` — the contract's promise that the post is fully synchronised — over a
snapshot in which pages 20..24 were never fetched. The completion claim is persisted,
so `hasMore` also collapses to false until the snapshot goes stale, and the hole is
invisible until then.

The service cannot tell this run apart from a legitimate resume, because the provider
gave it nothing to tell them apart with. That is the heart of the gap: acceptance of
a stored cursor does not prove the cursor was honoured, and completion is currently
certified as if it did.

## Context and assumptions

- A-003: the provider is authoritative; the local store is a snapshot.
- Spec-013 persists `provider_cursor`, `provider_exhausted`, and
  `provider_completed_at` on `posts`; `PostSnapshotState` carries their in-memory
  twins. `completedAt` surfaces to the client as `snapshot.syncedAt` (Spec-014).
- Spec-014 made the stored continuation best-effort and handled a *rejected* cursor
  by restarting once and relying on upsert dedup on `(social_account_id,
  external_comment_id)`. It handled the loud failure only.
- Spec-021 made `hasMore: true` with `syncedAt: null` binding: a run served over an
  incomplete snapshot is partial, and the client restarts over the finished snapshot.
  This spec reuses that signal rather than adding a new one.
- `upsertMany` returns the rows read back, both freshly inserted and pre-existing, and
  does not report which were new (`src/comments/contracts.ts`). No progress signal
  exists today.
- The vendor guidance is cited as documentation, not as observed behaviour: no live
  adapter is selected, so the silent-invalidation path is a documented risk this
  service must be honest about, not a measured one.

## Scope

### In scope

1. **Bound hydration progress by new rows, not by call count.** A run must be able to
   advance past pages it already holds after a restart, so a post deeper than the
   budget can reach completion across restarts instead of re-walking pages 0..19
   forever. Provider calls that fetch nothing the snapshot did not already have must
   not consume the budget that governs how far a run reaches.
2. **Keep an absolute ceiling on provider calls per request**, separate from the
   progress budget, so a provider that returns already-stored rows indefinitely — or
   an adversarial one — still terminates the request. Progress governs reach;
   the ceiling guarantees termination.
3. **Refuse to certify completion over an unverified resume.** `exhausted` and
   `completedAt` may be set only for a run that read the stream from its start —
   because it began from `providerCursor: null`, or because a loud
   `ProviderCursorRejectedError` restarted it there. A run whose first provider read
   used a stored cursor the provider *accepted* must not certify completion, because
   acceptance does not prove the cursor was honoured.
4. **Route an uncertifiable run through the existing `syncedAt: null` contract**
   (Spec-021), so the client-visible signal is one it already understands — partial,
   restart — rather than a new field.
5. Apply both behaviours identically to the in-memory and PostgreSQL compositions.
6. State the resulting client obligation in `docs/api-design.md` alongside the
   existing pagination-loop and restart guidance, and record the new bounds in
   `docs/operations.md`.

### Out of scope

- Removing the per-request bound, or completing a snapshot in the background. A-006
  still defers background synchronisation; Spec-021 already refused unbounded provider
  work inside one request.
- Changing keyset ordering, cursor encoding, or the ascending `(publishedAt, id)`
  order (Spec-009, A-008).
- The P2 items adjacent to this one — `partialRun` not being re-evaluated on a
  continuing walk, `completedAt` being stamped at fetch time rather than request time,
  and the unbounded wall-clock on `runHydration`. They are real and stay open; this
  spec touches completion's *conditions*, not its timestamp or its clock.
- Reflecting edits, deletions, or moderation of comments already stored (A-006).

## Contract impact

### API — what `syncedAt` and `hasMore` mean to a client

No field is added or removed, and `additionalProperties: false` is unaffected. Two
meanings tighten:

- **`syncedAt` becomes trustworthy.** A non-null `snapshot.syncedAt` today can be
  stamped over a snapshot a silent restart left a hole in (defect 2). After this spec
  a non-null `syncedAt` is emitted only for a run that read the stream from its start,
  so the completeness it asserts is one the service actually observed. The set of runs
  that report a non-null `syncedAt` therefore *narrows*: a post hydrated across
  requests over a stored cursor reports `syncedAt: null` — partial, restart — until a
  run reads it from the start (which the stale lifetime forces if nothing else does).
  A client that already honours the Spec-021 restart rule needs no change; a client
  that trusted a non-null `syncedAt` was previously sometimes trusting a hole.
- **`hasMore` stops being able to lie on a silent restart.** Because `exhausted` is no
  longer certified over an unverified resume, `hasMore = page.hasMore || !state.exhausted`
  can no longer collapse to false over a snapshot with an unfetched tail.

For defect 1 there is no shape change at all: the deep post that previously reported
`syncedAt: null` forever now reaches a non-null `syncedAt` after enough restarts,
which is the outcome Spec-021 always promised and could not deliver.

### Application

The single expression `hydrations < MAX_HYDRATIONS_PER_REQUEST` splits into two: a
progress budget and an absolute ceiling. `hydrate`'s completion return grows a guard
— it may certify only when the run read from the start. The progress budget needs a
signal `upsertMany` does not emit today (see open decision 1); if that signal is
chosen, `CommentRepository.upsertMany` and both adapters change shape, which reaches
`src/comments/contracts.ts` — a path this spec does not yet claim.

### Persistence

The service-only completion rule (open decision 3, option A) needs no schema change.
The seam-check alternative (option B) persists a boundary marker in `PostSnapshotState`
and therefore adds a column to `posts` and a migration — both outside this spec's
declared `paths`. Which is chosen decides whether the path claim must grow.

## Acceptance criteria

1. A full walk over a post deeper than `MAX_HYDRATIONS_PER_REQUEST`, whose stored
   continuation is rejected on every subsequent request, reaches every comment and a
   non-null `syncedAt` after a bounded number of restarts — never `syncedAt: null`
   forever with comments unreachable.
2. A provider that returns only already-stored rows with `hasMore: true` on every
   call terminates the request at the absolute ceiling and reports the run partial,
   rather than looping.
3. A run whose first provider read resumes a stored cursor the provider *accepts*, and
   which then sees `hasMore: false`, does not set `exhausted`/`completedAt` and returns
   `snapshot.syncedAt: null`.
4. A run that read the stream from `providerCursor: null`, or was restarted there by a
   loud `ProviderCursorRejectedError`, still certifies completion on `hasMore: false`
   and returns a non-null `syncedAt`.
5. A shallow post — fewer pages than the budget — still reports `hasMore: false`,
   `nextCursor: null`, and a non-null `syncedAt` on its first run (the existing
   guarantee, unchanged).
6. The existing loud-rejection restart test (`restarts the stream when the provider
   rejects a stored cursor`) and the Spec-021 deep-walk tests pass unchanged.
7. In-memory and PostgreSQL compositions agree on all of the above; the integration
   test through `createPostgresApplication` covers criteria 1 and 3.
8. `docs/api-design.md` and `docs/operations.md` record the narrowed `syncedAt`
   guarantee and the two new bounds.

## Verification plan

- **Defect 1, as a test.** The twenty-five-page reproduction above with a
  cursor-rejected-across-requests provider, walked repeatedly, asserting the deepest
  comment becomes visible and `syncedAt` becomes non-null. It fails against the current
  implementation, which stalls at twenty and `syncedAt: null`.
- **Defect 2, as a test.** A post hydrated to a stored cursor, then a fresh first-page
  request whose provider accepts the stale cursor and answers `hasMore: false` from the
  newest page. Assert `syncedAt` stays null and `exhausted` is not persisted. It fails
  today, returning a non-null `syncedAt` over a snapshot missing the tail.
- **Termination test.** A provider that never advances, asserting the request ends at
  the ceiling.
- **Regression tests.** The shallow-post completion test (`still reports a shallow post
  complete on its first run`) and the loud-rejection restart test, both unchanged.
- **Integration.** The two failing tests, repeated through `createPostgresApplication`
  against a real database.

### Named failing mutations

Each must turn a test red; each survives today.

- **M1** — revert the loop bound to `hydrations < MAX_HYDRATIONS_PER_REQUEST` counting
  every call (delete the progress budget). Defect-1 test goes red: the walk never
  completes.
- **M2** — feed the progress budget `page.items.length` (rows fetched) instead of rows
  newly inserted, so a re-walk of stored pages still counts as progress. Defect-1 test
  goes red for the same reason.
- **M3** — set the absolute ceiling to `Infinity`. Termination test goes red: the
  request does not end.
- **M4** — restore `hydrate` to certify `{ exhausted: true, completedAt: now }` on any
  `page.hasMore === false` (delete the read-from-start guard). Defect-2 test goes red:
  `syncedAt` is stamped over the hole.
- **M5** — make the read-from-start guard always report "read from start" (certify
  unconditionally). Defect-2 test goes red identically, proving the guard's condition,
  not just its presence, is tested.

## Open decisions

1. **The progress signal.** Proposed: `upsertMany` reports how many rows it newly
   inserted (PostgreSQL via `RETURNING (xmax = 0)`; in-memory by checking `byExternalId`
   before assigning identity), and the progress budget counts only calls that inserted
   at least one new comment. This is exact and cheap, but it changes
   `CommentRepository.upsertMany` and both adapters, reaching `src/comments/contracts.ts`.
   The alternative is a repository `countByPost` probe, equally a contract change and an
   extra query per call. Either way the signal cannot be derived in the service alone,
   because `listByPost` is windowed by `limit` and cannot reveal total growth.
2. **The absolute ceiling.** Proposed: comfortably above the deepest post a single
   restart must re-walk plus the progress budget, so a legitimate restart of a large
   post fits under it. It trades a higher worst-case provider-call count and tail
   latency per request for the ability to finish a large post at all. Too low and
   defect 1 is only half-fixed; too high and a pathological post is expensive.
3. **How to refuse completion over a silent restart — the hard one, because the
   provider gives no signal.**
   - **Option A — read-from-start rule, no new state.** Certify completion only when
     the run's first provider read was from `providerCursor: null`, or was forced there
     by a loud `ProviderCursorRejectedError`. A run that resumed a stored cursor the
     provider accepted never certifies. Fits the declared paths and folds into
     Spec-021's `syncedAt: null` contract. Cost: a post repeatedly resumed over a
     silently-stale cursor reports partial and makes the client restart until the stale
     lifetime (`SNAPSHOT_LIFETIME_SECONDS`, default 300s) forces a from-empty read that
     certifies — bounded busy-restart, deferred honest timestamp.
   - **Option B — overlap / seam check, persisted boundary.** Store the
     `(publishedAt, externalId)` of the last comment at the cursor position in
     `PostSnapshotState`; on resume, verify the returned page connects to it, and
     certify completion even for a resumed stream when it does. More precise and no
     restart storm, but it extends `PostSnapshotState` (`src/comments/contracts.ts`)
     and needs a migration (`migrations/**`) — both outside the declared `paths` — and
     it carries false positives when the boundary comment is legitimately deleted (a
     safe but wasteful restart) and false negatives if the silent restart happens to
     land on the boundary. Detection without a provider signal is inherently heuristic;
     this is the cost.
   Proposed: **A**. It needs no schema change, fits the declared paths, and reuses an
   existing contract signal; B is the more accurate model and the more invasive one.
4. **Whether the two fixes ship together.** They are separable — 1 is liveness, 2 is
   honesty — but both benefit from reasoning about whether a run is covering new ground.
   Proposed: together, since the read-from-start rule (3A) needs no signal 1 does not
   already motivate, and shipping the honesty fix without the liveness fix leaves a
   post that can only ever report partial.

## Human decision required

Approval requires choosing, and accepting:

1. **Option A or B in open decision 3.** This is the load-bearing judgement: A keeps
   the change inside the three declared files and defers the honest completion timestamp
   for silently-flaky posts; B certifies them precisely at the cost of new persisted
   state, a migration, and heuristic false positives. Approving B also approves
   expanding this spec's `paths` to include `src/comments/contracts.ts` and
   `migrations/**`.
2. **The progress signal in open decision 1**, which changes `upsertMany`'s contract
   and therefore also expands `paths` to `src/comments/contracts.ts`.
3. That a non-null `syncedAt` becomes rarer and, in exchange, trustworthy — a
   client-visible tightening of what completeness means, and that the absolute ceiling
   raises the worst-case provider-call count of a single request.
