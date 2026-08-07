---
spec: 008
title: Provider-backed comment reads with cache-miss strategy
status: accepted
approved: yes
owner: platform-integration
paths:
  - src/comments/**
  - src/platforms/**
---

# Spec-008: Provider-backed comment reads with cache-miss strategy

## Problem / Gap

The current implementation stores comments locally but never fetches them from providers. This violates the core assignment requirement: "Retrieve comments for a published post."

- `GET /v2/posts/{postId}/comments` always returns empty unless comments were seeded or stored via a reply operation.
- `POST /v2/comments/{commentId}/replies` requires the target comment to exist locally, making it impossible to reply to any comment not already in the local cache.
- There is no documented cache-miss strategy or freshness policy.

This makes the service unusable for its primary use case without external ingestion webhooks (which are explicitly out of scope per A-006).

## Context and assumptions

- **A-003**: External platforms are authoritative; local persistence is a normalized cache and operational record.
- **A-006**: Webhook synchronization is out of scope; the initial assignment covers on-demand retrieval.
- The provider registry and adapter contracts already exist; platform adapters implement `listComments(query: ListCommentsQuery)`.
- The repository layer supports upsert and cursor-based pagination.

## Scope

### In scope

1. **Cache-miss fetching**: When a client requests comments for a post not yet cached, fetch from the provider adapter.
2. **Upsert and deduplication**: Store normalized provider comments in the local repository; subsequent requests return cached copies.
3. **Reply-to-unknown-comment fix**: Before checking if a comment exists locally, attempt to fetch it from the provider if not found.
4. **Cursor handling**: Provider cursors may differ from local cursors; the implementation must preserve provider pagination while supporting multi-call cursors over the normalized cache.
5. **Error mapping**: Provider failures (unavailable, rate-limited, unsupported) map to documented API errors.

### Out of scope

- Background synchronization or webhook ingestion.
- Staleness eviction or TTL-based cache invalidation.
- Concurrent comment updates from the provider during pagination (handled by deterministic snapshot isolation).
- Multi-tenant provider account selection (existing post resolution already associates a platform and social account).

## Contract impact

### API (no change)

`GET /v2/posts/{postId}/comments` and `POST /v2/comments/{commentId}/replies` endpoints remain unchanged. The implementation now fetches from the provider on cache miss.

### Domain / Repositories (minimal change)

- `CommentRepository.listByPost(context, query)` unchanged signature; first call may populate the cache from the provider.
- `CommentRepository.findById(context, commentId)` unchanged signature; may trigger a provider fetch if not cached locally.

### Adapter / Platform layer (no change)

Provider adapters already implement `listComments()` and `replyToComment()`. The comment service now calls them on cache miss.

## Acceptance criteria

1. When `GET /v2/posts/{postId}/comments?limit=25` is called for a post with no cached comments:
   - The service calls the provider adapter's `listComments()` with the post's external ID.
   - Returned comments are validated and upserted into the local repository.
   - The response returns the fetched and stored comments with a normalized cursor.
2. A second call to the same endpoint without a cursor returns the same set of comments from the local cache without calling the provider again.
3. When `POST /v2/comments/{commentId}/replies` is called with a comment ID not in local cache:
   - The service attempts to fetch the comment from the provider (by resolving the comment's post and platform).
   - If found, the comment is upserted and the reply proceeds.
   - If not found on the provider, a 404 is returned.
4. Provider errors (rate limit, unavailable, unsupported operation) map to documented error codes and HTTP status.
5. Pagination over provider results preserves ordering (deterministic sort by published_at, id) when returning cached normalized comments.

## Verification plan

### Unit tests

- Mock provider that returns a list of comments; verify upsert is called and comments are stored.
- Test cache hit: second call does not invoke the provider.
- Test reply-to-unknown-comment: provider fetch succeeds, comment is stored, reply proceeds.

### Integration tests (Milestone 10)

- Postgres-backed repository with fixture provider; verify comments are stored and cursor pagination works across provider pages.
- Test multi-tenant isolation: account A fetches comments, account B does not see them.

### Manual verification

- Run `pnpm dev` with fixture provider.
- `curl http://localhost:3000/v2/posts/post_123/comments -H 'X-Account-Id: account-1'` returns fixture comments.
- `curl -X POST http://localhost:3000/v2/comments/comment_456/replies -H 'X-Account-Id: account-1' -H 'Idempotency-Key: key-1' -d '{"body": "test"}'` replies to a cached comment.

## Open decisions

1. **Staleness policy**: Should cached comments be refetched after a time limit, or always returned from cache until explicitly invalidated? _Proposed: Always return from cache; staleness is a later concern for webhook sync or explicit invalidation endpoints._
2. **Multi-page fetches**: If a provider pages large result sets, should the first call fetch all pages or only the first? _Proposed: Fetch only the requested page; clients can paginate further via cursors._
3. **Provider-side vs. local sorting**: If the provider returns comments unsorted, should we sort locally before storing? _Proposed: Sort by (published_at, id) when storing to ensure deterministic cursor pagination._

## Human decision required

Approval requires confirmation:

1. The cache-miss strategy (fetch on first request, cache thereafter) is acceptable until webhook sync is added.
2. Provider failures during the read path should return the documented error codes and not expose provider SDK details.
3. Reply-to-unknown-comment may incur an additional provider call; this is acceptable for correctness.

## Implementation outcome

**Acceptance criterion 2 was superseded by Spec-013.** It required a repeat request to be served from the cache "without calling the provider again", and implementing that literally meant hydration fired only on an empty page. A post whose provider stream is longer than one page then reported `hasMore: false` to any caller that did not carry a cursor, understating how many comments it had. Hydration now fires on an incomplete page while the stream is not exhausted, so a repeat request may call the provider until the snapshot for that post is complete. The intent of the criterion survives: a fully synchronised post costs no provider traffic.

Acceptance criteria 1, 2, 4, and 5 are implemented as written, and the open decisions were resolved as proposed.

Acceptance criterion 3 could not be implemented as written, and this section records what was built instead. Under ADR-0010 a comment identifier is an opaque service-owned UUID derived by one-way hash, so a bare identifier that is absent from the snapshot cannot be translated back into the provider coordinates (post plus external comment id) needed to fetch it. The "fetch the comment from the provider" branch has no reachable input.

What the criterion was protecting against is nevertheless fixed. The original defect was that nothing ever populated the snapshot, so a reply could not find its parent even after a client had listed the post's comments. Listing now hydrates the snapshot, which is the only way a client obtains a comment identifier, so the ordinary flow — list, then reply — works end to end. An identifier the service never issued is answered with `COMMENT_NOT_FOUND`, which is criterion 3's stated fallback.

Making the unreachable branch reachable would require encoding provider coordinates into the public identifier, contradicting ADR-0010's rationale, or accepting provider identifiers on the reply route, which is an API contract change. Neither is in this spec's scope; either would need a new spec.
