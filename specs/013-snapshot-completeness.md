---
spec: 013
title: Track snapshot completeness so pagination stops lying about more results
status: accepted
approved: yes
owner: platform-integration
depends_on:
  - Spec-008
  - Spec-009
paths:
  - src/comments/**
  - src/repositories/**
  - migrations/**
---

# Spec-013: Track snapshot completeness so pagination stops lying about more results

## Problem / gap

A caller that restarts pagination is told a post has fewer comments than it does.

Listing a post with `?limit=2` hydrates one provider page, stores two comments, and answers `hasMore: true` with a cursor carrying the provider's continuation token. Requesting the first page again, with no cursor, finds those two rows in the snapshot. Hydration does not trigger, because it fires only on an empty page. The local page has no further rows and no continuation was supplied, so the response is `hasMore: false` with a null cursor — while the provider still holds a third comment.

Observed on the running service:

```text
GET ?limit=2            -> 2 comments, hasMore true   (hydrated)
GET ?limit=2  (again)   -> 2 comments, hasMore false  (served from snapshot)
```

The cause is visible in one line of `CommentService.listComments`:

```ts
const hasMore = last !== undefined && (page.hasMore || providerCursor !== null);
```

`providerCursor` originates only from the incoming cursor. A fresh request has none, so the expression cannot distinguish _the provider is exhausted_ from _nobody told me where the provider got to_. Whether upstream has more is knowledge the service acquires during hydration and then throws away, keeping it only inside a cursor handed to one client.

A client that follows the issued cursor is unaffected. A client that re-requests the first page — which is what a polling client does, and what a fresh page load does — silently sees a truncated post.

## Context and assumptions

- A-003: the provider is authoritative; the local store is a snapshot.
- Spec-008 resolved staleness as "always return from cache", and its acceptance criterion 2 requires a repeat request to be served without calling the provider again. That criterion is what this spec revises.
- Spec-009 keyset pagination is unaffected; ordering and cursor encoding stay as they are.
- The `(social_account_id, external_comment_id)` constraint makes repeated hydration idempotent, so fetching a provider page twice is harmless.

## Scope

### In scope

1. **Persist what hydration learns** about a post's provider stream: the continuation token for the next unfetched page, and whether the stream has been read to its end.
2. **Trigger hydration on an incomplete page rather than an empty one**, while the stream is not known to be exhausted.
3. **Derive `hasMore` from snapshot completeness** instead of from whatever cursor the caller happened to supply.
4. Apply the same behaviour to the in-memory and PostgreSQL repositories, with a migration for the latter.
5. Cover the reported defect with a regression test at the service level and through the API.

### Out of scope

- Refreshing comments already stored. A comment edited or deleted at the provider stays as last observed; that is webhook territory (A-006) and unchanged here.
- Background or scheduled synchronisation. Hydration stays request-driven.
- Changing cursor encoding or ordering.

## Contract impact

### API

No shape changes. `hasMore` and `nextCursor` become correct for a caller that starts pagination fresh. This is a behaviour fix, and any client that inferred a post's size from a first-page `hasMore: false` was being given wrong information.

### Spec-008 revision

Acceptance criterion 2 of Spec-008 is amended. A repeat request no longer avoids the provider unconditionally; it avoids the provider once the snapshot for that post is complete. The intent behind that criterion — that steady-state reads cost no provider traffic — is preserved, because a fully synchronised post is served entirely from the snapshot. The difference is that the steady state is reached after the post has been read through, rather than after its first page.

### Persistence

A post gains synchronisation state: the next provider cursor and an exhausted flag. Whether this lives in columns on `posts` or in a separate table is an open decision below.

## Acceptance criteria

1. Requesting the first page twice returns the same `hasMore` both times, for a post whose provider stream is longer than one page.
2. Paging to the end of a post, then requesting the first page again, reports `hasMore` consistently with the number of comments that exist.
3. Once a post's stream is exhausted, further reads make no provider calls, verified by counting them.
4. A post whose provider stream is shorter than the requested limit reports `hasMore: false` and makes no repeat provider calls.
5. Hydration remains idempotent: fetching the same provider page twice stores each comment once.
6. Two concurrent first-page requests do not produce duplicate rows or a corrupted cursor.
7. Existing Spec-008, 009, and 010 tests pass unchanged, except the one asserting that a repeat request never calls the provider, which is amended to assert it once the snapshot is complete.

## Verification plan

- A service test reproducing the reported sequence: two identical first-page requests, asserting equal `hasMore`.
- A test walking a multi-page post to exhaustion, then re-requesting page one.
- A provider call counter asserting reads stop hitting the provider once exhausted.
- An integration test against PostgreSQL covering the persisted state and its migration.
- Manual: `docker compose up`, then `?limit=2` twice, comparing `pagination.hasMore`.

## Open decisions

1. **Where synchronisation state lives.** Proposed: columns on `posts` (`provider_cursor`, `provider_exhausted`), since it is one row per post and needs no join. A separate `post_sync_state` table keeps `posts` closer to the host platform's own model, at the cost of a join on every read.
2. **How much to fetch per request.** Proposed: one provider page per request, so a caller with `limit=25` against a provider that pages in 10 may receive 10 and `hasMore: true`. Fetching repeatedly until the page is filled gives better responses at the cost of unbounded provider calls inside one request.
3. **Concurrency on the stored cursor.** Two simultaneous requests may both hydrate from the same position. Proposed: accept it, because upserts dedupe and both advance to the same next cursor. The alternative is a row lock, which serialises reads of the same post.
4. **The cheaper alternative to all of this.** Always hydrate the first page when no cursor is supplied, and keep no state. It fixes the defect in a few lines and makes reads fresher, but costs one provider call per fresh listing forever, which is a poor trade against a rate-limited social API. Recommended only if the persisted state is judged too much machinery for the assignment.

## Human decision required

Approval requires accepting:

1. That Spec-008 acceptance criterion 2 is revised: a repeat request may call the provider until the post's snapshot is complete.
2. A migration adding synchronisation state to `posts`, or the separate table in open decision 1.
3. The per-request fetch bound in open decision 2, since it determines whether a page can come back shorter than the requested limit.
4. Whether to implement this at all, rather than the few-line alternative in open decision 4.
