---
spec: 017
title: Make every error tell a client what to do next
status: proposed
approved: no
owner: api
depends_on:
  - Spec-011
---

# Spec-017: Make every error tell a client what to do next

## Problem / gap

The error contract names what went wrong but not what to do about it, and in one case a single code covers three situations that demand three different client actions.

`IDEMPOTENCY_CONFLICT` means the key was reused with a different body (a client bug — abort), the key is in flight (retry the same key shortly), or the key already failed (retry with a new key). The only thing distinguishing them is English prose in the message. A client that wants to behave correctly has to match on message text, which a copy-edit silently breaks.

The API reviewer found the same shape elsewhere. `Retry-After` is described in prose but absent from the OpenAPI document, so a generated client cannot see it. There is no written policy for what may change within `/v2`, while `additionalProperties: false` on every schema means additive changes are not as safe as they look. And the pagination loop a client must write — keep going while `hasMore`, tolerate a page shorter than `limit`, tolerate an empty page — was only recently documented in prose and still is not expressible from the schema, which does not tie `nextCursor` to `hasMore`.

## Context and assumptions

- Spec-011 established that the OpenAPI document is generated from the route schemas, so anything a client should see must exist in a schema rather than only in prose.
- Spec-015 adds an unknown-outcome code, which makes the reason problem worse before it makes it better: four situations, one code.
- The error envelope is already stable and carries `code`, `message`, and `requestId`.

## Scope

### In scope

1. **Add a machine-readable `reason` to the error envelope**, enumerated per code, so a client branches on a value rather than on prose. `IDEMPOTENCY_CONFLICT` gains reasons for reused-with-different-body, in-flight, already-failed, and outcome-unknown.
2. **Document the client action for each code and reason** in one table: retry unchanged, retry with a new key, fix the request, or escalate.
3. **Express `Retry-After` in the OpenAPI document** for the rate-limited response, rather than only in prose.
4. **Tie `nextCursor` to `hasMore` in the schema**, so a document consumer can see that one implies the other and that a short page is normal.
5. **Write the `/v2` compatibility policy**: what may be added, what may not change, and what would require `/v3`. State explicitly that `additionalProperties: false` means a client must tolerate new fields it does not know, since the service may add them.
6. Add response examples to the document, which a generated client and a reviewer both use.

### Out of scope

- Changing any status code or the meaning of any existing code.
- Splitting `IDEMPOTENCY_CONFLICT` into several codes. The code says what happened; the reason says what to do. Splitting would break existing clients for no gain.
- Fetching a single comment or the replies to one comment, which the reviewer also raised. Those are new endpoints and belong in their own spec.

## Contract impact

### API

`error.reason` is additive and optional to consume, but `additionalProperties: false` means the schema must declare it, and the compatibility policy must say that a client is required to tolerate unknown fields. That policy is the part with teeth.

No status code, existing code, or payload shape changes.

### Documentation

`docs/api-design.md` gains the code-and-reason table and the compatibility policy. The OpenAPI document gains the header, the examples, and the reason enum.

## Acceptance criteria

1. Every error response carries a `reason` drawn from an enumeration declared in the schema.
2. Each of the four idempotency situations produces a distinct reason.
3. A client can determine the correct action from `code` and `reason` alone, with no reference to `message`.
4. `Retry-After` appears in the OpenAPI document on the rate-limited response.
5. The document expresses that `nextCursor` is present exactly when `hasMore` is true.
6. `docs/api-design.md` states the `/v2` compatibility policy, including the obligation to tolerate unknown fields.
7. Existing clients that ignore `reason` continue to work unchanged.

## Verification plan

- A test per idempotency situation asserting the emitted reason.
- A test asserting every reason the service can emit is declared in the schema, so the two cannot drift.
- An OpenAPI test asserting the `Retry-After` header and the reason enumeration are present.
- A test asserting `nextCursor` is non-null exactly when `hasMore` is true, across the paths that produce each.

## Open decisions

1. **Whether `reason` is required or optional in the envelope.** Proposed: required, because an optional field is one clients cannot rely on, and every error path can supply one.
2. **Whether reasons are globally unique or namespaced per code.** Proposed: globally unique strings, so a log or dashboard can group on reason alone without also carrying the code.
3. **How far the compatibility policy commits.** Proposed: additive fields and new enum members are allowed within `/v2`; removing a field, narrowing a type, or changing a status code is not. The risk is that new enum members break a client validating strictly, which is exactly why the obligation must be written down rather than assumed.
4. **Whether to add response examples for failures as well as successes.** Proposed: yes for at least one error per status, since a reviewer reads examples before schemas.

## Human decision required

Approval requires accepting:

1. A new required field in the error envelope, and with it the position that clients must tolerate fields they do not know.
2. A written compatibility policy, which constrains what future changes may do without a new version.
3. That reasons become a contract surface: once a client branches on one, renaming it is a breaking change.
