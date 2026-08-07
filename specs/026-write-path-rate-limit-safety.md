---
spec: 026
title: Stop the write path replaying a rate-limited publish
status: implemented
approved: yes
owner: platform-integration
paths:
  - src/shared/observability.ts
  - src/comments/comment-service.ts
---

# Spec-026: Stop the write path replaying a rate-limited publish

> **Process note.** Implemented in the same session this was written, as a
> deliberate exception by the maintainer rather than the usual approve-then-build
> order. Recorded because the commit history shows it either way.

## Problem

Raised as P0-1 by the `principal-review` board and reproduced by execution.

`providerPolicies` pairs a read policy with a write policy whose whole purpose is
to replay nothing:

```ts
return { read, write: { ...read, shouldRetry: () => false } };
```

`retryDelayFor` did not consult that override until after it had already
answered for rate limits:

```ts
if (attempt >= policy.maxAttempts) return null;
if (error instanceof ProviderRateLimitError) { … }   // shouldRetry never reached
return policy.shouldRetry(error) ? backoffDelay(attempt, policy) : null;
```

So `shouldRetry: () => false` was dead code for a 429, and a publish was
replayed. Measured against the shipped policy:

```
WRITE policy, retryAfter 200ms:        publish invoked 3 time(s)
WRITE policy, retryAfter 30s:          publish invoked 1 time(s)
WRITE policy, no Retry-After header:   publish invoked 3 time(s)
```

Three replies under one customer's name for one idempotency key, with
`recordPublished` storing only the last `externalId` so the first two are
orphaned with no record anywhere in the service.

The second row is why no test caught it: every reply rate-limit test used
`retryAfterMs: 30_000`, which exceeds `maxDelayMs` and takes the branch that
declines to sleep. Compounding it, `buildService` in the service-level tests ran
`immediatePolicy` with `maxAttempts: 1`, which cannot retry anything — so no
service-level test could observe a replay at all, whatever the policy did.

A second, independent site: `provesRejection` classified `PROVIDER_RATE_LIMITED`
as proof of non-publication, so the operation was recorded `failed` and the next
request was answered `idempotency_key_failed` — _retry with a new key_. Fixing
the adapter alone would leave the service still instructing the client to
duplicate.

## Scope

### In scope

1. `retryDelayFor` consults `shouldRetry` before any error-class branch. The
   branches decide _when_ to replay, never _whether_.
2. `providerRetryPolicy.shouldRetry` names `ProviderRateLimitError` as retriable
   explicitly, so read behaviour is unchanged now that the delay logic no longer
   assumes it.
3. `provesRejection` returns false for every code, per [ADR-0015](../docs/decisions/0015-rate-limit-does-not-prove-refusal.md).
   A rate-limited reply is recorded `unknown`.
4. Tests that can fail:
   - the write policy dispatches exactly one publish for a 429 at each of
     `Retry-After` 200ms, 30s, and absent;
   - a rate-limited read still retries;
   - the service dispatches exactly one publish end to end, under a harness
     policy that _can_ retry and a `Retry-After` that fits the budget — both
     conditions are load-bearing and both were missing before;
   - a rate-limited operation lands `unknown`, and its retry is refused with
     `REPLY_OUTCOME_UNKNOWN` rather than `idempotency_key_failed`.

### Out of scope

- Distinguishing an edge 429 from a handler 429. No provider documents a
  reliable signal; see ADR-0015.
- Reconciling operations left `unknown` by a genuine refusal. Deferred under
  A-006 and recorded in [roadmap.md](../docs/roadmap.md).

## Verification

Each mutation was applied to a scratch copy and the suite re-run:

| Mutation                                                     | Result                                                            |
| ------------------------------------------------------------ | ----------------------------------------------------------------- |
| Restore the original branch order in `retryDelayFor`         | policy test fails (3 publishes), service test fails (3 publishes) |
| Widen `provesRejection` to `code !== 'PROVIDER_UNAVAILABLE'` | outcome test fails                                                |

Full suite green against PostgreSQL after the change.
