---
spec: 036
title: Brand comment and post identifiers and validate their shape at the edge
status: accepted
approved: yes
owner: domain model and api edge
depends_on:
  - Spec-001
  - Spec-025
paths:
  - src/shared/types.ts
  - src/shared/validation.ts
  - src/shared/identifiers.ts
  - src/api/routes.ts
  - src/comments/comment-service.ts
---

# Spec-036: Brand comment and post identifiers and validate their shape at the edge

## Problem / gap

Every identifier this service issues for a comment or a post is a UUID. That is
not a convention; it is what ADR-0013 decided — `comments.id` defaults to
`gen_random_uuid()`, identity is assigned by persistence and is not reproducible
from provider data. The PostgreSQL adapter encodes the fact defensively:
`findPublishedById`, `findById`, `resolveExternalId`, and `findReplyByExternalId`
each open with `if (!isUuid(...)) return null`, and `identifiers.ts` states why —
"checking the shape before a value reaches SQL keeps a malformed one from failing
a `::uuid` cast, which produced a 500 and an error-level log where the contract
promises a 404." That contract is pinned:
`tests/api/postgres-composition.integration.test.ts:155` requests
`/v2/posts/not-a-uuid/comments` and asserts `404 POST_NOT_FOUND`.

But the rule lives only inside one adapter's method bodies. At the type level,
`Comment.id`, `Comment.postId`, `Comment.parentCommentId`,
`ReplyOperation.commentId`, the `postId`/`commentId` path params in
`src/api/routes.ts` (schema `type: 'string', minLength: 1` and nothing more),
and every repository and service signature are bare `string`. Nothing says
"UUID," so the shape is re-asserted ad hoc per PostgreSQL method and **not at
all** in the in-memory adapter, which accepts any string as a `Map` key.

This produces the open item in `docs/tasks.md`. The default suite runs the
service only against the in-memory adapter, and its fixtures — `post.id` in
`tests/support/fixtures.ts` — are `'post-1'`, a value the PostgreSQL adapter's
`isUuid` guard rejects and its `post_id uuid` column cannot store. The two
adapters therefore **disagree on what a valid identifier is**, and the
disagreement is invisible: it is exercised only by the database-gated
integration test, never by the default suite. A change that let the in-memory
adapter accept an identifier PostgreSQL cannot store — or that dropped the
`isUuid` guard so a malformed id reached a `::uuid` cast — would ship green.

The same asymmetry runs the other way at the edge. The account context's shape
*is* validated there: the `onRequest` hook rejects a non-UUID `x-account-id`
with `401`. Only the two path identifiers are exempt, and only they can reach a
repository unshaped.

## Context and assumptions

- ADR-0013 (assigned identity, superseding ADR-0010) is why UUID is the true
  shape and why the `'post-1'` fixture is unrepresentative of any stored row.
- Spec-025 established `assertStoredComment` / `assertStoredReplyOperation` as
  the single mapper chokepoint both adapters already funnel through, and the
  rule that a malformed *stored* record is a service fault — a `500`
  `StoredRecordInvalidError` (`stored_record_invalid`), asserted at
  `tests/api/routes.test.ts:402` — never a client `400`. This spec extends that
  chokepoint; it does not add a second one.
- Spec-001 governs the domain model, under whose authority branding an
  identifier falls.
- The edge already validates identifier shape (`isUuid` on `x-account-id`
  → `401`), so doing the same for path identifiers is an established pattern
  here, not a new one.
- The current client-observable contract for a malformed path identifier is
  `404`, both by the pinned integration test and by the intent recorded in
  `identifiers.ts`.
- No production data exists; branded types are a compile-time change plus
  test-fixture updates.

## Scope

### In scope

1. **Define nominal brands** `PostId` and `CommentId` in `src/shared/types.ts`
   (an opaque `string & { readonly __brand }`), and apply them to `Comment.id`,
   `Comment.postId`, `Comment.parentCommentId`, and `ReplyOperation.commentId` /
   `ReplyOperation.resultingCommentId`.
2. **Add validated constructors** `toPostId(value: string): PostId | null` and
   `toCommentId(value: string): CommentId | null` in
   `src/shared/identifiers.ts`, built on the existing `isUuid`. These are the
   only *inbound* mint — the point at which a client-supplied string becomes a
   branded identifier.
3. **Extend the Spec-025 chokepoint** in `src/shared/validation.ts`:
   `assertStoredComment` and `assertStoredReplyOperation` accept plain-string-id
   input, assert `isUuid` shape on the identifier fields *in addition to* the
   existing non-empty rules, and return the branded `Comment` / `ReplyOperation`.
   This is the only *outbound* mint. Because both adapters already call these
   functions, it makes the in-memory adapter reject a non-UUID stored identifier
   exactly as the PostgreSQL `::uuid` column does.
4. **Parse the two path params at the edge** in `src/api/routes.ts` via the new
   constructors, so a malformed `postId` / `commentId` never reaches the service.
   The failure response is the open decision below. `src/comments/comment-service.ts`
   takes `PostId` / `CommentId` parameters, so the compiler forbids passing a
   raw string — which is what forces the service fixtures to mint real UUIDs and
   makes the default suite exercise the real shape.
5. **Keep `validateComment`'s field rules unchanged** (Spec-025). The shape
   check is added at `assertStoredComment`, not inside `validateComment`, so the
   existing `validateComment` behaviour and its `tests/comments/domain-model.test.ts`
   assertions on `post_123`/`comment_123` continue to describe the field
   contract, while the mapper enforces shape.

### Out of scope

- Branding `AccountId`, `ReplyOperation.id`, `PublishedPost.id`, external/provider
  identifiers, or `CommentKeyset.id`. The cursor keyset already carries its own
  shape guard (`isUuid` + `isIssuedTimestamp` in the PostgreSQL `listByPost`,
  Spec-022) and is reconstructed from a service-issued token rather than supplied
  at the edge; the account context is validated separately at the `onRequest`
  hook.
- Changing `validateComment`'s field rules.
- Removing the PostgreSQL per-method `isUuid` guards. Keeping them as
  defence-in-depth is what lets the design leave `src/repositories/**`
  unedited (see Contract impact).
- The account-context shape asymmetry: service unit tests call the service
  directly with `accountId: 'account-1'`, below the edge that would reject it.

## Contract impact

### API

A malformed `postId` / `commentId` is rejected at one place instead of three,
but its *status* is the open decision. Keeping `404` preserves
`postgres-composition.integration.test.ts:155` and the recorded intent; moving to
`400` is a breaking status change on an existing, tested path. No new fields,
routes, or reasons arise under either choice.

### Application

Both adapters agree on identifier shape by construction: a malformed id is
rejected at the single edge parse, and a stored non-UUID id is rejected at the
shared mapper chokepoint. What only the database-gated integration test verified
becomes verifiable in the default suite.

Branded ids are subtypes of `string`, so a `PostId` passed to a repository
method still satisfies its `string` parameter, and a mapper's plain-string
object literal still satisfies the chokepoint's input type. The design intent is
therefore that **`src/repositories/**` and `src/comments/contracts.ts` need not
change** — the mint is centralized in `validation.ts`. This must be confirmed at
implementation; if it cannot hold, those paths must be claimed before approval.

### Domain

`Comment` and `ReplyOperation` identifier fields become nominal `PostId` /
`CommentId`. This is a domain-model change (Spec-001) and a refinement of the
identity model in ADR-0013/ADR-0010 — see open decision 2.

The forcing function has a cost that is the point of the spec: the verification
requires editing test fixtures to mint real UUIDs — `tests/support/fixtures.ts`
(`post.id`), `tests/comments/domain-model.test.ts` (`post_123`, `comment_123`,
and the `operation` fixture), `tests/comments/comment-service.test.ts`,
`tests/repositories/in-memory.test.ts`. The spec-gate covers `tests/*`
(Spec-032), so the approved `paths:` list must be extended to claim `tests/**`.
This is named in the human decision rather than assumed.

## Acceptance criteria

1. `PostId` / `CommentId` are nominal: a bare `string` is not assignable to a
   `PostId` / `CommentId` position without passing a constructor or the mapper
   chokepoint.
2. The only ways to obtain a branded identifier are `toPostId` / `toCommentId`
   (inbound) and `assertStoredComment` / `assertStoredReplyOperation`
   (outbound); each requires UUID shape.
3. A malformed `postId` / `commentId` path param is rejected at the edge with the
   decided status and never reaches the service or a repository.
4. Reading a stored comment or reply operation whose identifier is not a UUID
   yields a `StoredRecordInvalidError` (`500`, `stored_record_invalid`) from
   **both** adapters, exercised in the default suite.
5. `validateComment`'s field-rule tests are unchanged; shape enforcement is at
   `assertStoredComment`, not in `validateComment`.
6. The two adapters produce identical client-observable behaviour for a
   malformed path identifier, demonstrated without a database.
7. The implementation touches no `src/repositories/**` or
   `src/comments/contracts.ts` file — or, if it must, the `paths:` claim is
   extended accordingly before approval.
8. `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, and `pnpm test` pass;
   `docs/tasks.md` is updated.

## Verification plan

- **Type level:** a `// @ts-expect-error` fixture proving a bare string cannot be
  passed where a `PostId` / `CommentId` is required, and that `toPostId('post-1')`
  is `null`.
- **Edge, default suite:** an HTTP test against `createDemoApplication`
  requesting `/v2/posts/not-a-uuid/comments` and `/v2/comments/not-a-uuid/replies`
  asserts the decided status — mirroring `postgres-composition.integration.test.ts:155`
  at the in-memory edge, so the contract is checked without a database.
- **Named FAILING MUTATION (default suite):** in `src/shared/validation.ts`,
  weaken `assertStoredComment`'s new `postId` shape check from `isUuid(...)` back
  to `isNonEmptyString(...)`. A test that stores an `ObservedComment` with
  `postId: 'post-1'` — the exact value in `tests/support/fixtures.ts` today —
  through `InMemoryCommentRepository` and reads it back **must go red**: it
  expects `StoredRecordInvalidError` and, mutated, receives a comment. This is
  the assertion that proves the in-memory adapter now enforces the identifier
  shape the PostgreSQL `::uuid` column enforces; before this spec no
  default-suite test could turn red for it.
- **Decision-dependent mutation:** under a `400` decision, removing the
  `toPostId` parse in `src/api/routes.ts` makes `/v2/posts/not-a-uuid/comments`
  return `404` (in-memory `Map` miss) instead of `400`, and the edge test above
  catches it. Under a `404` decision that mutation is **not** observable by
  status in the demo composition — both paths give `404` — so the stored-record
  mutation is the one that must stay red, and the edge parse's value under `404`
  is the type-level brand and adapter agreement rather than a status change.
  State this explicitly so the guard that matters is not mistaken for the edge
  status.
- Full suite after fixtures are migrated to real UUIDs.

## Open decisions

1. **`400` versus `404` for a malformed path identifier.** Proposed: **stay 404**
   — map the parse failure to the route's existing `POST_NOT_FOUND` /
   `COMMENT_NOT_FOUND`. It is non-breaking, preserves the pinned
   `postgres-composition.integration.test.ts:155` and the intent recorded in
   `identifiers.ts`, and fits ADR-0013's opaque, assigned identity: a token that
   names nothing is not-found, and a well-behaved client only ever echoes an id
   this API issued. The alternative, `400 INVALID_REQUEST` /
   `request_validation_failed`, is the more honest signal of a client bug,
   matches the edge's schema-validation and account-id-shape handling,
   centralizes the rule, and buys the extra default-suite killing test above — at
   the cost of a breaking status change and of distinguishing malformed-from-
   absent (a harmless disclosure, since UUID shape is already public in the
   OpenAPI examples and the `401` account-id rule). This is the maintainer's
   call and the substance of the spec.
2. **Whether this needs its own ADR.** Branded identifiers refine the identity
   representation of ADR-0013/ADR-0010. Proposed: record an ADR, since this
   establishes a domain-wide representation rule, even though Spec-001 already
   authorizes domain-model changes. (The spec author may not write it here; only
   this one file is edited.)
3. **Breadth of branding.** Proposed: brand `Comment` / `ReplyOperation`
   identifier fields only, leaving `PublishedPost.id`, `AccountId`, operation
   ids, and the cursor keyset as `string`, to contain the change to the five
   claimed files plus tests. Branding `PublishedPost.id` or the seed would
   additionally touch `src/index.ts`, `src/seed-data.ts`, and possibly
   `src/repositories/**`; decide whether that breadth is wanted, and extend
   `paths:` if so.
4. **Path claims for verification.** The forcing function edits `tests/**`, which
   the spec-gate covers. Approval must extend the `paths:` list to claim
   `tests/**` (and any `src` path admitted by decision 3).

## Human decision required

The decision that gates everything is (1): does a malformed `postId` /
`commentId` become **400** — validated and refused at the edge — or **stay 404**,
treated as absent, given that today it is a tested `404`? Approval also requires
accepting (a) nominal `PostId` / `CommentId` as a domain-model change, and
whether an ADR records it (decision 2); and (b) extending this spec's `paths:` to
cover the verification tests, and any wider branding under decision 3. Nothing is
implemented until a human changes `approved: no` to `approved: yes`.
