---
spec: 009
title: Keyset pagination using deterministic sort order
status: accepted
approved: yes
owner: data-access
---

# Spec-009: Keyset pagination using deterministic sort order

## Problem / Gap

The current implementation uses offset-based pagination by encoding a numeric offset in the cursor. This contradicts **A-008** which states "The service uses opaque cursors so it can preserve provider pagination semantics and avoid unstable offset paging over changing external data."

Offset-based pagination is unstable:

- If a comment is added or removed between requests, the offset becomes misaligned.
- The example in [api-design.md](../../docs/api-design.md) shows `{"offset":25}` base64-encoded, which reveals pagination semantics.
- Keyset pagination (cursor based on `(published_at, id)`) is stable and deterministic.

The database schema already has the ideal index: `comments_post_cursor_idx on comments (account_id, post_id, published_at, id)` ([001_initial_schema.sql:44](../../migrations/001_initial_schema.sql:44)).

## Context and assumptions

- Comments are ordered by `(published_at, id)` deterministically.
- The cursor is opaque; clients must not decode or construct it.
- Ordering is stable even if comments are added/updated outside the paginated window.
- A-008 governs pagination semantics: opaque cursors that preserve provider semantics over changing data.

## Scope

### In scope

1. Replace offset encoding in both `InMemoryCommentRepository` and `PostgresCommentRepository`.
2. Encode cursor as an opaque string containing the last-seen `(published_at, id)` values (e.g., base64-encoded JSON `{"publishedAt":"2026-08-01T10:00:00.000Z","id":"comment_abc123"}`).
3. Decode cursor on the next request to start from the keyset boundary instead of an offset.
4. Return `hasMore` and `nextCursor` correctly without fetching `limit + 1` rows.

### Out of scope

- Cursor versioning (if the sort key changes, old cursors are invalidated; future migration can handle this).
- Bidirectional pagination (backward cursors); initial implementation is forward-only.

## Contract impact

### API (no user-visible change)

Cursors remain opaque and base64-encoded. The endpoint contract is unchanged; only the implementation details of cursor construction change.

### Repositories (minor change)

- `decodeCursor(cursor)` changes from returning an offset to returning `{publishedAt: string, id: string}`.
- `encodeCursor(lastPublishedAt, lastId)` encodes the keyset instead of a number.
- Query logic changes from `OFFSET x LIMIT y` to `WHERE (published_at, id) > (?, ?) LIMIT y`.

## Acceptance criteria

1. A cursor returned from page 1 successfully fetches page 2 when comments are added to page 1 (no skips or duplicates).
2. Cursors remain stable when the sort key does not change (deterministic re-execution).
3. The implementation uses the existing `comments_post_cursor_idx` index for efficient keyset scans (verified by query plan).
4. Cursors are fully opaque; a base64 decode does not expose `publishedAt` values to a naive client (format can be verified to be opaque).
5. Both in-memory and Postgres implementations use the same cursor semantics.

## Verification plan

### Unit tests

- Test pagination with 50 comments: first request with `limit=10` returns 10, cursor is valid, second request with cursor returns next 10.
- Test comment insertion during pagination: a new comment before the current window does not affect subsequent cursors.
- Test boundary: cursor after last item returns `hasMore: false` and `null` cursor.

### Integration tests (Milestone 10)

- Postgres keyset pagination with fixture provider fetching multiple pages.
- Verify query plan uses the index (via `EXPLAIN`).

## Open decisions

1. **Cursor format**: Should we use base64-JSON (`{"publishedAt":"...","id":"..."}`), base64-concatenation (`ts-id`), or a binary encoding? _Proposed: base64-JSON for debuggability under obscured inspection (debugger can base64-decode); client code will never decode it._
2. **Comparison operator**: Should `(published_at, id) > (?,?)` use strict greater-than or `>=` with a flag to skip the boundary? _Proposed: Strict `>` to avoid duplicates on re-fetch of the same cursor._
3. **Direction**: Should forward cursors and backward cursors be distinct, or only support forward? _Proposed: Forward only; backward pagination can be added if needed._

## Human decision required

Approval requires:

1. Confirmation that keyset pagination (returning `limit + 1` rows to compute `hasMore`, discarding the overflow) is acceptable instead of the current approach.
2. Agreement on cursor encoding (base64-JSON is recommended for debuggability).
3. Confirmation that provider pagination will be mapped to local keyset pagination (via provider-adapter cursor translation if needed).
