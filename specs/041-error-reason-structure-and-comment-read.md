---
spec: 041
title: Add a single-comment read endpoint and keep reasons flat
status: accepted
approved: yes
owner: api contract
depends_on:
  - Spec-011
  - Spec-017
paths:
  - src/shared/errors.ts
  - src/api/schemas.ts
  - src/api/routes.ts
  - docs/api-design.md
---

# Spec-041: Add a single-comment read endpoint and keep reasons flat

## Problem / gap

The principal-review board left one API-ergonomics item open in `docs/tasks.md`: "`reason` is one flat enum shared API-wide, and there is no `GET /v2/comments/{id}`." These are two complaints, and they do not have the same answer.

**No way to re-read a comment.** `src/api/routes.ts` registers exactly two `/v2` routes: `GET /v2/posts/:postId/comments` (line 87) and `POST /v2/comments/:commentId/replies` (line 150). A client holds a service-owned comment id after either — every listed comment carries one, and a reply returns `data.id` — but there is no operation that takes an id back. A client that dropped a page, or that wants to confirm a reply it published, or that stored an id and came back later, has to re-list the whole post and scan for the id. The lookup the endpoint would need already exists and is already tenant-scoped: `CommentRepository.findById(context, commentId)` selects `where c.id = $1 and c.account_id = $2` under `withTenant` in `src/repositories/postgres.ts` (line 251), and reads a per-tenant map in `src/repositories/in-memory.ts` (line 106). It is used today only inside `replyToComment` and its replay path. Nothing exposes it.

**The reason enum is flat.** `serviceErrorReasons` in `src/shared/errors.ts` (lines 35-68) is a single `as const` array of globally-unique snake_case strings, shared across every code rather than grouped by it. `src/api/schemas.ts` feeds that array straight into the `Error` schema's `reason` enum (line 161), and `tests/api/openapi.test.ts` pins the published enum to `[...serviceErrorReasons]`. The complaint is that a reader of the enum cannot see which reasons belong to which code. But the flatness is deliberate: Spec-017's open decision #2 chose globally-unique strings over namespaced-per-code precisely so "a dashboard can group on reason alone without also carrying the code," and the source comment on the array reaffirms it — "Once a client branches on one, renaming it is a breaking change." The grouping the complaint asks for already exists, in the `docs/api-design.md` "What each reason asks you to do" table (lines 187-208) and in the section comments of the array itself.

## Context and assumptions

- The `/v2` compatibility policy in `docs/api-design.md` (lines 219-238) is the governing rule for both changes. It permits "Adding a new endpoint" without a new version, and it makes "Removing or renaming a … `reason`" a `/v3` change.
- Spec-017 made `reason` a required, globally-unique contract surface and wrote the policy that now constrains it. This spec is bound by that decision; it does not reopen it.
- The isolation model resolves an out-of-scope resource to `404`, not `403`, so a caller is never told something exists that it may not see (`docs/api-design.md` line 183; the `FORBIDDEN` note in `src/shared/errors.ts`). `findById` already returns `null` for a non-UUID id and for a row outside the tenant, which the endpoint maps to `404 COMMENT_NOT_FOUND`, matching how `GET /v2/posts/not-a-uuid/comments` already answers `404` (`tests/api/openapi.test.ts`, "treats a malformed post identifier as absent").
- `reason` is a pure response surface. `reply_operations.failure_code` stores `ServiceErrorCode` values, not reasons (`toFailureCode` returns a code; `src/repositories/postgres.ts` line 82), so renaming a reason would not invalidate any stored row. Its cost is entirely client-facing plus the OpenAPI golden.
- Assumption A-001 still holds: the gateway authenticates the caller and supplies `X-Account-Id`. The read endpoint inherits the same account-context hook that already guards the two `/v2` routes.

## Scope

### In scope

1. **Add `GET /v2/comments/{commentId}`** to `src/api/routes.ts`: tenant-scoped, reading only the local snapshot, returning the existing `Comment` projection wrapped in `{ data }` — the same envelope the reply route returns. It reuses `serializeComment` and the `Comment#` schema unchanged, so `parentUnresolved` and every provider identifier stay internal exactly as they do on the other two routes.
2. **Reach the lookup through the service, not the repository.** `src/api/routes.ts` receives a `CommentService`, never a repository, and that boundary must hold (architecture rules; ADR-0002). The endpoint therefore needs a new public method `CommentService.getComment(context, commentId): Promise<Comment>` that calls the existing `findById` and throws `NotFoundError('COMMENT_NOT_FOUND', …)` when it returns `null`. **That method lives in `src/comments/comment-service.ts`, which this proposal's `paths:` does not claim** — see the open decision.
3. **Document the endpoint** in `docs/api-design.md` (a `GET /v2/comments/{commentId}` section and the path table) and regenerate `docs/openapi.json` via `pnpm openapi`.
4. **Reaffirm the flat reason enum in `docs/api-design.md`**, stating that the code→reason grouping is documentation, not a wire-string prefix, and that the current strings are frozen under the compatibility policy. If a source-level reorganization of `serviceErrorReasons` is wanted for readability, it may regroup the declaration in `src/shared/errors.ts` only so long as the flattened array is byte-identical to today's — no emitted string changes.

### Out of scope

- **Renaming or namespacing any `reason` string** (`idempotency.key_in_flight`, `provider/rate_limited`, and the like). That is a rename, which the compatibility policy sends to `/v3`. It is recommended against below and, if pursued, belongs in its own spec and an ADR, not here.
- Adding a `reasonGroup`/`category` field to the error envelope. It would be additive and legal within `/v2`, but a client can already derive the group from `code`, so it buys nothing the two existing fields do not.
- Hydrating from the provider on a miss. The endpoint reads the stored snapshot only. An id the service never issued is `404`, the same stance the reply path takes (`docs/api-design.md` line 146); guessing at provider coordinates would invent provider behavior.
- Fetching the replies to a comment, or any list-shaped read. This is a single-resource `GET`.
- Any change to the two existing routes, to a status code, or to the meaning of any code or reason.

## Contract impact

Both changes are client-visible. They land on opposite sides of the compatibility policy, which is the whole point of separating them.

### The read endpoint is additive — it stays within `/v2`

A new endpoint is permitted without a new version. `GET /v2/comments/{commentId}` adds a path to `docs/openapi.json` and a third operation to the two the document describes today. It requires no change to any existing response, so no client breaks. Its documented failure set is deliberately narrower than the list route's, because it makes no provider call: **`200`, `401`, `404`, `500`** — no `429`/`502`/`503` (no hydration), no `409`/`413`/`415`/`422` (no body, no write). `500` remains reachable through the same mapper-validation path as every other read: a stored row that fails the domain model surfaces as `INTERNAL_ERROR` / `stored_record_invalid` (Spec-025), never as the caller's mistake.

### The reason restructure is a rename — it would be `/v3`

Any structuring that changes the emitted strings is, by the policy's own words, a rename requiring `/v3`. It would break every client that branches on a reason — the exact contract Spec-017 established — and turn the OpenAPI golden red. It buys no capability: the grouping already exists in the documentation table and in the `code` field a strict client is told to fall back to. The only form of "structure" that stays inside `/v2` is one that does not touch the wire at all: a source-level regrouping of the `serviceErrorReasons` declaration whose flattened value is identical to today's. That is not a contract change; it is a comment with indentation.

**Recommendation: do not restructure the reason strings. Ship only the additive endpoint.**

### Documentation

`docs/api-design.md` gains the endpoint section and path-table row, and a sentence making explicit that reason grouping is documentation rather than a string convention, and that the strings are frozen. `docs/openapi.json` is regenerated.

## Acceptance criteria

1. `GET /v2/comments/{commentId}` returns `200` with `{ data: <Comment> }` for a comment visible in the caller's scope, serialized through the existing `Comment#` schema with no field the two current routes do not already expose.
2. The endpoint requires an account context: a request without a valid `X-Account-Id` is `401`, through the same hook as the other `/v2` routes.
3. A comment id that is not visible to the caller — belonging to another tenant, never issued, or not a UUID — is `404 COMMENT_NOT_FOUND` / `comment_not_found`, never `403` and never a `500`.
4. The endpoint makes no provider call and no write; its documented statuses are exactly `200`, `401`, `404`, `500`.
5. `docs/openapi.json` describes the new operation, and the committed document matches the generated one.
6. No `reason` string changes value. The published `reason` enum still equals `[...serviceErrorReasons]`, and `docs/api-design.md` states that the grouping is documentation and the strings are frozen under the `/v2` policy.
7. The two existing routes and every existing test are unchanged in behavior.

## Verification plan

- **Named failing mutation (read isolation).** Delete the not-found guard in `CommentService.getComment` so it returns the repository's `null` straight through. The route then answers `200 { data: null }` for an out-of-scope or unknown id. Two assertions turn red: an in-memory route test asserting an unknown id is `404 COMMENT_NOT_FOUND`, and the two-tenant case in `tests/api/postgres-composition.integration.test.ts` — which already exercises HTTP-level cross-tenant refusal — asserting tenant B reading tenant A's comment id gets `404`, not A's comment. A single mutation kills both, which is the isolation the endpoint exists to preserve.
- **Reason-freeze tripwire (already present).** `tests/api/openapi.test.ts` ("declares every reason the service can emit") pins the published enum to `[...serviceErrorReasons]`, and the golden-diff test pins `docs/openapi.json`. Renaming any reason string turns both red. That standing tripwire is itself the argument that a cosmetic restructure is not free — it is a `/v3` event — and the verification for criterion 6 is that these stay green.
- New in-memory route tests in `tests/api/routes.test.ts`: happy-path read of a listed comment's id; `401` without an account context; `404` for a random UUID and for a non-UUID id.
- Regenerate and diff: `pnpm openapi` followed by `git diff --exit-code docs/openapi.json`, and update `tests/api/openapi.test.ts` so the "describes … operations" assertion covers the third path.

## Open decisions

1. **The claimed `paths:` do not cover the service method the endpoint needs.** This proposal claims `src/shared/errors.ts`, `src/api/schemas.ts`, `src/api/routes.ts`, and `docs/api-design.md`. The read endpoint additionally requires `CommentService.getComment` in `src/comments/comment-service.ts`, which the spec gate would block as an unclaimed path. This is flagged rather than silently resolved, because the front matter is the gate and I do not widen it on my own. Approving this spec requires either extending `paths:` to include `src/comments/comment-service.ts` or accepting a companion spec for that one method.
2. **Whether the reason restructure happens at all.** Proposed: no. Keep the flat, globally-unique strings Spec-017 chose; document the grouping, which already exists. The alternative is a `/v3`-class rename for a readability gain the documentation table already delivers.
3. **Response envelope shape.** Proposed: `{ data: <Comment> }`, matching the reply route, so a client deserializes one shape for both single-resource responses. The list route's `{ data, pagination, snapshot }` does not apply — there is no page and no provider read to report freshness on.

## Human decision required

Two decisions, and they are separable on purpose:

1. **Approve the additive `GET /v2/comments/{commentId}` endpoint within `/v2`**, accepting that its implementation touches `src/comments/comment-service.ts` and that `paths:` must be widened to claim it before the write is allowed.
2. **Decide the reason enum: keep it flat, or spend a `/v3`.** The recommendation is to keep it flat and treat the grouping as documentation. Only a maintainer can accept the opposite — that restructuring the wire strings is worth breaking every client that branches on a reason and cutting a new API version — and that decision does not belong inside this additive change.

Nothing here is implemented until a maintainer changes `approved: no` to `approved: yes`.
