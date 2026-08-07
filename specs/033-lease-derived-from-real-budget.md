---
spec: 033
title: Derive the reply lease from the work it protects
status: implemented
approved: yes
owner: platform-integration
paths:
  - src/comments/comment-service.ts
  - src/repositories/database.ts
---

# Spec-033: Derive the reply lease from the work it protects

> **Process note.** Implemented in the same session this was written, as a
> deliberate exception by the maintainer.

## Problem

Raised as P1 by the `principal-review` board.

`REPLY_LEASE_MS` was justified by "the HTTP request timeout is 30 seconds and
the provider call budget is shorter still, so a lease can only expire after the
request holding it has finished or died."

That bound does not hold. Fastify's `requestTimeout` destroys the socket; it does
not stop the handler, which keeps running with nobody left to answer. The number
that matters is how long the work _after the claim_ can take, and it was never
computed — the lease and the request timeout were two separately pinned
literals, one of them hand-copied into a test.

## Scope

### In scope

1. `DATABASE_CALL_BUDGET_MS` is exported from `database.ts`: the pool's
   connection timeout plus its query timeout, which is the longest one database
   call can take.
2. `REPLY_LEASE_MS` is exported, and its comment states the real bound — one
   provider publish plus the three database calls that follow it
   (`recordPublished`, `storePublishedReply`, `complete`).
3. A test asserts `REPLY_LEASE_MS > providerRetryPolicy.timeoutMs + 3 * DATABASE_CALL_BUDGET_MS`,
   and asserts the same of the lease actually observed on a claimed operation.

### Out of scope

- Computing the lease in `comment-service.ts`. That would import
  `repositories/database.ts`, which imports `pg`, into a module ADR-0002 keeps
  free of persistence clients. The arithmetic lives in a test, which may import
  both.

## Note on the reviewer's figure

The board computed a worst case of roughly 115s against a 120s lease, assuming
three provider attempts plus two backoff sleeps. That ladder no longer exists:
under [ADR-0015](../docs/decisions/0015-rate-limit-does-not-prove-refusal.md) the
write policy replays nothing, so the publish is one attempt. The real worst case
is 20s + 3 × 15s = 65s, and the 120s lease clears it with the margin the comment
now claims.

## Verification

Lowering `REPLY_LEASE_MS` to 60_000 fails the assertion with
`expected 60000 to be greater than 65000`.
