# API design

The API is versioned from the start because provider integrations and normalized representations will evolve.

Base path: `/v2`

## Machine-readable contract

`docs/openapi.json` is an OpenAPI 3.1 document generated from the Fastify route schemas (Spec-011), so it describes what the routes implement rather than what was intended. CI regenerates it and fails on any difference, which is what keeps this document and the code from drifting apart.

This document remains authoritative for intent, rationale, and error semantics. The generated document is the machine-readable projection of the implementation. A disagreement between them is a defect in one of the two.

| Path             | Purpose                      |
| ---------------- | ---------------------------- |
| `/documentation` | Swagger UI                   |
| `/openapi.json`  | The OpenAPI document as JSON |

Neither is versioned under `/v2`, because they describe the API rather than belong to it, and neither requires an account context. Both are served only when API documentation is enabled: `ENABLE_API_DOCS` controls it, defaulting to enabled outside production and disabled in production, because a service behind an internal gateway has no reason to publish its own schema.

## Authentication

Per assumption A-001 the surrounding platform authenticates callers and supplies the tenant context. This service reads that context from the `X-Account-Id` request header and scopes every query to it; a request without it is rejected with `UNAUTHENTICATED`.

The header is trusted because it is expected to arrive from an internal gateway that has already authenticated the caller. Exposing this service directly to untrusted clients would require a real credential check in front of it; that boundary belongs to the platform, not to the comment service.

## GET `/v2/posts/{postId}/comments`

Retrieves comments for a published post.

### Query parameters

| Parameter | Required | Description                                                       |
| --------- | -------- | ----------------------------------------------------------------- |
| `limit`   | No       | Number of comments requested. Defaults to `25`, maximum is `100`. |
| `cursor`  | No       | Opaque cursor returned by a previous response.                    |

The post’s platform is resolved from the authenticated account and post record. Provider-specific IDs are not exposed as query parameters.

The service answers from its local snapshot of the post’s comments. When the snapshot cannot fill the requested page and the provider stream has not been read to its end, it fetches the next page from the provider, stores it, and serves the result. Once a post has been read through, further requests are served locally with no provider traffic.

Starting a pagination run — a request with no cursor — reads the post through to the end of the provider stream before answering, so the run then pages a snapshot that does not move underneath it. Provider order is not this API's order: several platforms return newest first, and without completing the snapshot those comments would land behind an ascending cursor and never be returned. Completion is bounded, so a very large post may still report `hasMore` with the run continuing.

`hasMore` reflects whether more comments exist, not whether this response filled the page, and a response may contain fewer than `limit`.

Every response carries `snapshot.syncedAt`: when the post was last read through at the provider, or `null` if it never has been. Comments published since may not be present. A completed snapshot is re-read once it ages past the service's snapshot lifetime, so a post does not stay frozen at the moment it was first read.

### Request

```http
GET /v2/posts/2b1f8f5c-0d2e-4d64-9d5f-91a0c0f1b002/comments?limit=25 HTTP/1.1
X-Account-Id: 2b1f8f5c-0d2e-4d64-9d5f-91a0c0f1b001
```

### Response: `200 OK`

```json
{
  "data": [
    {
      "id": "beb5d133-e54d-5998-91d0-25f49f24aa7e",
      "postId": "2b1f8f5c-0d2e-4d64-9d5f-91a0c0f1b002",
      "platform": "instagram",
      "author": {
        "id": "ig-author-1",
        "displayName": "Ada Lovelace",
        "profileUrl": "https://example.test/ada"
      },
      "body": "This is great!",
      "parentCommentId": null,
      "publishedAt": "2026-08-01T10:00:00.000Z",
      "updatedAt": "2026-08-01T10:00:00.000Z"
    }
  ],
  "pagination": {
    "nextCursor": "eyJhIjpbIjIwMjYtMDgtMDFUMTA6MDA6MDAuMDAwWiIsImJlYjVkMTMzLWU1NGQtNTk5OC05MWQwLTI1ZjQ5ZjI0YWE3ZSJdfQ",
    "hasMore": true
  },
  "snapshot": {
    "syncedAt": "2026-08-01T12:00:00.000Z"
  }
}
```

Comment and post identifiers are service-owned UUIDs (ADR-0010). The provider’s own identifiers are stored for deduplication but are never serialized to clients. `author.id` remains the provider’s author identifier, because the author is not a resource this service owns.

## POST `/v2/comments/{commentId}/replies`

Publishes a reply to an existing comment.

### Headers

`Idempotency-Key` is required and must be stable across client retries for the same logical operation.

### Request

```http
POST /v2/comments/beb5d133-e54d-5998-91d0-25f49f24aa7e/replies HTTP/1.1
X-Account-Id: 2b1f8f5c-0d2e-4d64-9d5f-91a0c0f1b001
Idempotency-Key: reply-request-01
Content-Type: application/json

{
  "body": "Thank you!"
}
```

### Response: `201 Created`

```json
{
  "data": {
    "id": "923a391e-d474-543c-9dcc-a1645f29c28e",
    "postId": "2b1f8f5c-0d2e-4d64-9d5f-91a0c0f1b002",
    "platform": "instagram",
    "author": {
      "id": "fixture-account",
      "displayName": "Blotato"
    },
    "body": "Thank you!",
    "parentCommentId": "beb5d133-e54d-5998-91d0-25f49f24aa7e",
    "publishedAt": "2026-08-02T12:00:00.000Z",
    "updatedAt": "2026-08-02T12:00:00.000Z"
  }
}
```

Replying requires the parent comment to be present in the local snapshot, which listing the post’s comments guarantees. An identifier the service has never issued is answered with `COMMENT_NOT_FOUND` rather than a guess at provider coordinates.

## Error responses

All errors use one stable envelope:

```json
{
  "error": {
    "code": "COMMENT_NOT_FOUND",
    "message": "The requested comment was not found.",
    "requestId": "req_abc123"
  }
}
```

Expected mappings include:

| Status | Code examples                         | Meaning                                          |
| ------ | ------------------------------------- | ------------------------------------------------ |
| `400`  | `INVALID_REQUEST`, `INVALID_CURSOR`   | Request cannot be parsed or validated.           |
| `401`  | `UNAUTHENTICATED`                     | Caller credentials are missing or invalid.       |
| `404`  | `POST_NOT_FOUND`, `COMMENT_NOT_FOUND` | Resource is not visible in the caller’s scope.   |
| `409`  | `IDEMPOTENCY_CONFLICT`                | The idempotency key cannot be honoured.          |
| `422`  | `UNSUPPORTED_CAPABILITY`              | Provider cannot perform the requested operation. |
| `429`  | `PROVIDER_RATE_LIMITED`               | Provider or service rate limit was reached.      |
| `502`  | `PROVIDER_ERROR`                      | Provider returned an upstream failure.           |
| `503`  | `PROVIDER_UNAVAILABLE`                | Provider is temporarily unavailable.             |
| `500`  | `INTERNAL_ERROR`                      | Unexpected failure inside the service.           |

A `429` response carries `Retry-After` whenever the provider supplied that guidance.

A resource belonging to another tenant is `404`, not `403`: the caller is not told that something exists which they may not see.

`IDEMPOTENCY_CONFLICT` covers three cases, distinguished by the message: the key was reused for a different request body, a reply for the key is still in flight, or the key already failed. A failed key is terminal, because the outcome at the provider may be unknown; the client retries with a new key.

## Pagination strategy

Responses use opaque cursors. Clients must not decode or construct them; a cursor the service did not issue is rejected with `INVALID_CURSOR`.

A cursor encodes two things: the caller’s keyset position in the local snapshot, expressed as the last returned `(publishedAt, id)` pair, and the provider’s own continuation token when one is outstanding. Ordering is `(publishedAt, id)` ascending, which matches the `comments (account_id, post_id, published_at, id)` index.

Because the position is a keyset rather than an offset, a comment that arrives before the caller’s position does not shift the remaining pages: the caller sees neither duplicates nor gaps. Such a comment simply is not part of that pagination run and appears on a subsequent first-page request.
