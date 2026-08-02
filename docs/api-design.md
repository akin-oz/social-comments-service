# API design

The API is versioned from the start because provider integrations and normalized representations will evolve.

Base path: `/v2`

## GET `/v2/posts/{postId}/comments`

Retrieves comments for a published post.

### Query parameters

| Parameter | Required | Description |
| --- | --- | --- |
| `limit` | No | Number of comments requested. Default and maximum are implementation-configured. |
| `cursor` | No | Opaque cursor returned by a previous response. |

The post’s platform is resolved from the authenticated account and post record. Provider-specific IDs are not exposed as query parameters.

### Request

```http
GET /v2/posts/post_123/comments?limit=25 HTTP/1.1
Authorization: Bearer <token>
```

### Response: `200 OK`

```json
{
  "data": [
    {
      "id": "comment_456",
      "postId": "post_123",
      "platform": "instagram",
      "author": {
        "id": "author_789",
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
    "nextCursor": "eyJvZmZzZXQiOjI1fQ",
    "hasMore": true
  }
}
```

## POST `/v2/comments/{commentId}/replies`

Publishes a reply to an existing comment.

### Headers

`Idempotency-Key` is required and must be stable across client retries for the same logical operation.

### Request

```http
POST /v2/comments/comment_456/replies HTTP/1.1
Authorization: Bearer <token>
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
    "id": "comment_999",
    "postId": "post_123",
    "platform": "instagram",
    "author": {
      "id": "account_123",
      "displayName": "Blotato"
    },
    "body": "Thank you!",
    "parentCommentId": "comment_456",
    "publishedAt": "2026-08-02T12:00:00.000Z",
    "updatedAt": "2026-08-02T12:00:00.000Z"
  }
}
```

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

| Status | Code examples | Meaning |
| --- | --- | --- |
| `400` | `INVALID_REQUEST`, `INVALID_CURSOR` | Request cannot be parsed or validated. |
| `401` | `UNAUTHENTICATED` | Caller credentials are missing or invalid. |
| `403` | `FORBIDDEN` | Caller cannot access the account or post. |
| `404` | `POST_NOT_FOUND`, `COMMENT_NOT_FOUND` | Resource is not visible in the caller’s scope. |
| `409` | `IDEMPOTENCY_CONFLICT` | Key was reused for a different request. |
| `422` | `UNSUPPORTED_CAPABILITY` | Provider cannot perform the requested operation. |
| `429` | `PROVIDER_RATE_LIMITED` | Provider or service rate limit was reached. |
| `502` | `PROVIDER_ERROR` | Provider returned an upstream failure. |
| `503` | `PROVIDER_UNAVAILABLE` | Provider is temporarily unavailable. |

## Pagination strategy

Responses use opaque cursors. The service owns the cursor format and may encode provider cursors, a local snapshot boundary, or both. Clients must not decode or construct cursors. Ordering should be deterministic, and the implementation must document how new comments arriving during pagination are handled.
