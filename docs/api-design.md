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

**`X-Request-Id` is not trusted, and is ignored.** The service generates its own correlation identifier and returns it as `error.requestId` (Spec-022). It previously honoured the header verbatim, which meant the identifier an operator reconstructs a request by was chosen by the caller: unbounded in length, and freely collidable with another request's. Correlating across systems is the gateway's job, and it can do it without handing the choice to whoever is calling.

**The request body is limited to 64 KB.** The largest documented body is a 10,000-character reply; Fastify's 1 MB default was a hundredfold of parse work the contract never asked for. Over the limit is `413`, not a service failure.

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

Every response carries `snapshot.syncedAt`: when the post was last read through at the provider, or `null`. Comments published since may not be present. A completed snapshot is re-read once it ages past the service's snapshot lifetime, so a post does not stay frozen at the moment it was first read.

#### A run that ends on `syncedAt: null` was partial — start it again

`syncedAt` is reported **as of the run**, not as of the post, and this is load-bearing (Spec-021).

Completing a snapshot is bounded, so a post with more provider pages than the budget begins its run over a snapshot the service is still filling. Providers return newest-first while this API returns oldest-first, so everything fetched after that point lands _behind_ the run's cursor and the run can never reach it. Such a run reports `syncedAt: null` on every page including its last, even though the snapshot has usually completed by then.

**The rule: if the final page of a run — the one with `hasMore: false` — carries `snapshot.syncedAt: null`, that run did not see everything. Start again from no cursor.** The second run is served over the finished snapshot, returns every comment, costs no provider traffic, and ends with `syncedAt` set.

A client that ignores `syncedAt` gets a correct, duplicate-free, gap-free page sequence over a partial view. That is the trade: the alternative is holding the first request open until an arbitrarily large post has been read end to end.

```
run 1:  … → hasMore: false, syncedAt: null   ← partial, restart
run 2:  … → hasMore: false, syncedAt: "…"    ← complete
```

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

Comment and post identifiers are service-owned UUIDs, assigned by persistence ([ADR-0013](decisions/0013-assigned-comment-identity.md), which supersedes ADR-0010). The provider’s own identifiers are stored for deduplication but are never serialized to clients. `author.id` remains the provider’s author identifier, because the author is not a resource this service owns.

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
    "reason": "comment_not_found",
    "message": "The requested comment was not found.",
    "requestId": "req_abc123"
  }
}
```

**Branch on `code` and `reason`. Never on `message`** — its wording is not part of the contract and a copy-edit may change it at any time. `reason` says which of several situations behind a code this is, and therefore what to do; reasons are globally unique, so a log or dashboard can group on reason alone.

Expected mappings include:

| Status | Code examples                                            | Meaning                                                             |
| ------ | -------------------------------------------------------- | ------------------------------------------------------------------- |
| `400`  | `INVALID_REQUEST`, `INVALID_CURSOR`                      | Request cannot be parsed or validated.                              |
| `401`  | `UNAUTHENTICATED`                                        | Caller credentials are missing or invalid.                          |
| `404`  | `POST_NOT_FOUND`, `COMMENT_NOT_FOUND`, `ROUTE_NOT_FOUND` | Resource is not visible in the caller’s scope, or no route matched. |
| `409`  | `IDEMPOTENCY_CONFLICT`, `REPLY_OUTCOME_UNKNOWN`          | The idempotency key cannot be honoured.                             |
| `422`  | `UNSUPPORTED_CAPABILITY`, `REPLY_DEPTH_EXCEEDED`         | Well formed, but cannot be performed on this resource.              |
| `413`  | `INVALID_REQUEST`                                        | The request body is larger than the service accepts.                |
| `415`  | `INVALID_REQUEST`                                        | The request content type is not supported.                          |
| `429`  | `PROVIDER_RATE_LIMITED`                                  | Provider or service rate limit was reached.                         |
| `502`  | `PROVIDER_ERROR`                                         | Provider returned an upstream failure.                              |
| `503`  | `PROVIDER_UNAVAILABLE`                                   | Provider is temporarily unavailable.                                |
| `500`  | `INTERNAL_ERROR`                                         | Unexpected failure inside the service.                              |

A `429` response carries `Retry-After` whenever the provider supplied that guidance.

A resource belonging to another tenant is `404`, not `403`: the caller is not told that something exists which they may not see. That rule is why **`FORBIDDEN` has no producer and no documented status** — every authorisation failure is either a `401` for missing context or a `404` for a resource outside the caller's scope. The code and its reason remain declared in the schema, reserved rather than live, because removing an enum member is the one change the `/v2` compatibility policy below does not permit.

### What each reason asks you to do

| Code                     | Reason                          | Do this                                                              |
| ------------------------ | ------------------------------- | -------------------------------------------------------------------- |
| `UNAUTHENTICATED`        | `missing_account_context`       | Fix the caller: supply a valid `X-Account-Id`.                       |
| `POST_NOT_FOUND`         | `post_not_found`                | Fix the request; the post is not visible in your scope.              |
| `COMMENT_NOT_FOUND`      | `comment_not_found`             | List the post's comments first, then reply to an identifier from it. |
| `IDEMPOTENCY_CONFLICT`   | `idempotency_key_body_mismatch` | Fix the caller. Reusing a key for a different body is a bug.         |
| `IDEMPOTENCY_CONFLICT`   | `idempotency_key_in_flight`     | Retry **the same key** after a short delay.                          |
| `IDEMPOTENCY_CONFLICT`   | `idempotency_key_failed`        | Retry with a **new key**. Nothing was published.                     |
| `REPLY_OUTCOME_UNKNOWN`  | `reply_outcome_unknown`         | **Do not retry.** Escalate — a reply may already exist.              |
| `REPLY_DEPTH_EXCEEDED`   | `reply_depth_exceeded`          | Fix the request: reply to the top-level comment instead.             |
| `UNSUPPORTED_CAPABILITY` | `capability_unsupported`        | Do not retry; this platform cannot do this.                          |
| `UNSUPPORTED_CAPABILITY` | `platform_not_configured`       | Escalate; the deployment has no adapter for this platform.           |
| `PROVIDER_RATE_LIMITED`  | `provider_rate_limited`         | Retry unchanged after `Retry-After`.                                 |
| `PROVIDER_ERROR`         | `provider_upstream_error`       | Retry a read; escalate a write, whose outcome may be unknown.        |
| `PROVIDER_ERROR`         | `provider_cursor_rejected`      | Retry unchanged; the service restarts the provider stream itself.    |
| `PROVIDER_UNAVAILABLE`   | `provider_unavailable`          | Retry a read with backoff; escalate a write.                         |
| `INVALID_CURSOR`         | `cursor_not_issued_by_service`  | Restart pagination from no cursor.                                   |
| `INVALID_REQUEST`        | `request_validation_failed`     | Fix the request.                                                     |
| `INVALID_REQUEST`        | `idempotency_key_missing`       | Fix the caller: supply `Idempotency-Key`.                            |
| `INTERNAL_ERROR`         | `reply_not_stored`              | Escalate; a reply may have been published.                           |
| `INTERNAL_ERROR`         | `internal_error`                | Retry once, then escalate.                                           |

`IDEMPOTENCY_CONFLICT` keeps one code across three situations on purpose: the code says what happened, the reason says what to do. Splitting it would break existing clients for no gain.

`REPLY_OUTCOME_UNKNOWN` is deliberately a separate code (Spec-015). It means a reply may have been published and this service cannot establish whether it was — a timeout after send, a claim whose owning process died, or a publish that could not be recorded. Its action is the opposite of every other `409`. The service log names the provider's identifier for the reply that may exist, so an operator can check.

`REPLY_DEPTH_EXCEEDED` means the parent named by the request is itself a reply. This service exposes one level of replies as a deliberate normalisation, not because every platform enforces one (ADR-0014).

## Compatibility within `/v2`

Every response schema sets `additionalProperties: false`, which describes what the service sends — not a promise that the shape will never grow. **A client must tolerate fields and enum members it does not recognise.** Validating a response strictly against a copy of the schema taken today will break on a change this policy explicitly permits.

Permitted without a new version:

- Adding an optional field to a response.
- Adding a new member to an enum, including a new error `code` or `reason`.
- Adding an optional request parameter or header.
- Adding a new endpoint, or a new status to an existing endpoint's documented set.
- Changing any `message` text, which is never part of the contract.

Requires `/v3`:

- Removing or renaming a field, an error `code`, or a `reason`.
- Narrowing a type, or making an optional field required.
- Changing the status code an existing situation produces.
- Changing what an existing `code` or `reason` means.

The risk this policy accepts is that a new enum member breaks a client validating strictly. That is exactly why the obligation is written down rather than assumed. A client that cannot tolerate unknown reasons should branch on `code` alone and treat an unrecognised `reason` as the code's default action.

## Pagination strategy

Responses use opaque cursors. Clients must not decode or construct them; a cursor the service did not issue is rejected with `INVALID_CURSOR`.

A cursor encodes one thing: the caller’s keyset position in the local snapshot, the last returned `(publishedAt, id)` pair. It carried the provider’s continuation token in an earlier version; [Spec-014](../specs/014-read-path-completeness.md) removed that, because handing a client the very token vendors document must not be stored is a leak, and the service reads its stored snapshot state instead. Ordering is `(publishedAt, id)` ascending, which matches the `comments (account_id, post_id, published_at, id)` index.

Because the position is a keyset rather than an offset, a comment that arrives before the caller’s position does not shift the remaining pages: the caller sees neither duplicates nor gaps. Such a comment simply is not part of that pagination run and appears on a subsequent first-page request.
