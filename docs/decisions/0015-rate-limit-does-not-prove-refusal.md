# ADR-0015: A rate limit does not prove the reply was refused

- **Status:** accepted
- **Date:** 2026-08-07
- **Supersedes:** the rate-limit carve-out in [ADR-0009](0009-production-polish.md) as implemented by [Spec-010](../../specs/010-reply-path-reliability.md)
- **Related:** [ADR-0011](0011-observability-model.md), [Spec-015](../../specs/015-reply-operation-lifecycle.md), [Spec-026](../../specs/026-write-path-rate-limit-safety.md)

> **Process note.** This decision was implemented in the same session it was
> written, rather than being approved before implementation. That is a
> deliberate exception made by the maintainer, and it is recorded here because
> the commit history shows it either way.

## Context

The reply path splits its retry policy in two. Reads may be replayed, because
refetching a provider page converges on the same rows through the upsert. Writes
may not, because a timeout proves only that no answer arrived — the reply may
already be published, and replaying it publishes a second one under a customer's
name.

That split carried an exception. A rate limit was treated as proof of refusal,
on the reading that "the provider declined to process the request, so nothing
went out". Two things followed from it:

1. `providerPolicies` built the write policy as `{ ...read, shouldRetry: () => false }`,
   but `retryDelayFor` consulted the rate-limit branch _before_ `shouldRetry`, so
   that override was unreachable for a 429 and a publish was replayed up to three
   times.
2. `provesRejection` returned true for `PROVIDER_RATE_LIMITED`, so a rate-limited
   operation was recorded `failed`, and `replay` answered the next request with
   `idempotency_key_failed` — which tells the client to retry _with a new key_.

Both were verified by execution rather than inference. Against the shipped
policy, one publish call became three for a 429 carrying a small `Retry-After`,
and three again for a 429 carrying no `Retry-After` at all — which is what Meta
and X routinely send.

No test caught either. Every reply rate-limit test in the suite used
`retryAfterMs: 30_000`, which exceeds `maxDelayMs` and takes the branch that
declines to sleep; and the service-level harness ran a policy with
`maxAttempts: 1`, which cannot retry anything. The suite reported the path safe
while it duplicated.

## Decision

**A 429 no longer proves anything about whether the reply was published.**

- `retryDelayFor` consults `shouldRetry` first. The delay branches decide _when_
  to replay; they no longer decide _whether_.
- The read policy states `ProviderRateLimitError` as retriable explicitly, so
  reads are unchanged and the reason is written where the decision is made.
- The write policy replays nothing at all.
- `provesRejection` returns false for every code. It is kept as an empty list
  rather than deleted, so an adapter that can genuinely prove a refusal has one
  obvious place to say so.
- A rate-limited reply is therefore recorded `unknown`, not `failed`.

## Why the original premise was wrong

It is true of a 429 raised by the provider's own write handler. It is false of a
429 raised by anything in front of that handler — a platform limiter, a CDN, a
gateway refusing on its own retry budget — any of which can answer 429 _after_
the origin accepted and published the reply. The status code does not say which
happened, and the service has no other signal that would.

The consequence of guessing ran in one direction only. `failed` invites a retry
under a new key, which publishes a duplicate if the reply did go out. `unknown`
refuses the retry, which is wrong only when the reply genuinely was refused —
and that case needs an operator or a reconciliation pass, not an automatic
retry. Between a wrong answer that duplicates customer-visible content and a
wrong answer that delays a legitimate reply, the service takes the second.

## Consequences

- `failed` is no longer reachable from the reply path. The status, the
  `idempotency_key_failed` reason, and the `replay` branch that maps it all stay,
  because rows written by earlier versions still carry them and a client meeting
  one must still get an answer it can act on. That branch is now tested by
  seeding such a row directly, the way a pre-upgrade row already exists.
- A caller rate-limited on a reply gets `REPLY_OUTCOME_UNKNOWN` (409) on retry
  rather than `IDEMPOTENCY_CONFLICT`. This is a visible contract change for the
  narrow case, and it is the point of the change: the previous code asked the
  client to do the one thing that duplicates.
- `fail` may now only be applied to a `pending` operation, so nothing can
  downgrade an `unknown` to `failed` after the fact.
- Genuinely refused replies now occupy an idempotency key until an operator or a
  reconciliation pass resolves them. Reconciliation is deferred (A-006) and the
  gap is recorded in [docs/roadmap.md](../roadmap.md).

## Alternatives considered

**Keep the carve-out and only fix the ordering bug.** Rejected: the ordering bug
and the `provesRejection` classification are the same premise expressed twice.
Fixing one leaves the service still instructing the client to duplicate.

**Distinguish the 429's origin by inspecting the response.** Rejected: no
provider in the capability matrix documents a header that reliably separates an
edge refusal from a handler refusal, and a heuristic that is right most of the
time is precisely what this decision is replacing.
