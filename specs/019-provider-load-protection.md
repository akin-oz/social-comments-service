---
spec: 019
title: Stop concurrent readers multiplying provider load
status: accepted
approved: yes
owner: platform-integration
depends_on:
  - Spec-014
paths:
  - src/comments/**
---

# Spec-019: Stop concurrent readers multiplying provider load

## Problem / gap

Nothing deduplicates concurrent hydration of the same post. K readers arriving together on a cold post each run the full hydration loop, so the service issues K copies of every provider call. Against a rate-limited API that is the shape of an outage: the first burst of traffic to a popular post is exactly when the load is highest and exactly when the provider is most likely to start refusing.

Spec-014 made this worse, and did so deliberately. Before it, a request made one provider call; now starting a run reads a post through to the end of its stream, bounded at twenty calls. That was the right trade for correctness — comments were unreachable otherwise — but it multiplied the cost of the amplification it did not address.

Two smaller faults compound it. `saveSnapshotState` is an unconditional overwrite with no compare-and-set, so two concurrent hydrations can write continuations in either order and the later writer wins regardless of which is further along. And a rate limit consumes the retry budget of whichever call happens to hit it, with no shared notion that the provider has asked this service as a whole to slow down.

## Context and assumptions

- Re-reading a provider page is idempotent through `(social_account_id, external_comment_id)`, so the amplification wastes quota rather than corrupting data.
- Vendor documentation shows real budgets: X charges per post read, YouTube spends quota units per call, Facebook's business-use-case limit is computed from engaged users.
- The service is a modular monolith today, and may run as several replicas.
- ADR-0011 established the metrics and logging this needs to be observable.

## Scope

### In scope

1. **Single-flight hydration per post.** Concurrent requests for a post already being hydrated wait for that work and use its result, rather than starting their own.
2. **Compare-and-set on snapshot state**, so a hydration only advances the stored continuation from the state it read, and a stale writer cannot move it backwards.
3. **Make the amplification observable**: metrics for hydrations joined versus started, and for how long a joiner waited.
4. **Bound the wait.** A caller joining in-flight hydration must not inherit an unbounded delay; past the bound it answers from the snapshot it has.
5. State the behaviour in the operations guide, including that single-flight is per replica.

### Out of scope

- A cross-replica lock. In-process single-flight cuts amplification by the factor that matters and costs nothing; coordinating replicas needs infrastructure the service does not have and ADR-0009 defers.
- A circuit breaker or a shared rate-limit budget, both of which the board also raised. They are a different mechanism with their own failure modes and belong in their own spec.
- Any change to what hydration fetches or how pagination behaves.

## Contract impact

### API

None. A joining caller receives the same response it would have received; it simply did not pay for a duplicate fetch.

Tail latency changes shape: a joiner waits for work already running rather than running its own, which is usually faster and occasionally slower when the in-flight call is nearly timed out. The bound in scope item 4 caps that.

### Application

The service gains per-post in-flight state. That is process-local mutable state in a service that has none today, so it must be scoped to the composition rather than global, or tests will leak state into one another.

### Persistence

No migration. Compare-and-set uses the columns already present.

## Acceptance criteria

1. N concurrent first reads of a cold post produce the provider call volume of one read, not N.
2. A joining caller receives the same comments and pagination it would have received alone.
3. A hydration whose snapshot state changed underneath it does not overwrite the newer state.
4. A caller that joins in-flight hydration and waits past the bound still receives a correct response from the snapshot it has.
5. A failing hydration does not leave later callers waiting on it, and does not mark the post permanently in flight.
6. Metrics distinguish a hydration that ran from one that joined.
7. Single-flight state does not leak between compositions in tests.

## Verification plan

- A test issuing N concurrent first reads through `Promise.all` against a counting provider, asserting the call count matches one read. This fails against the current implementation.
- A test where hydration rejects, asserting waiters see the error and the next request retries rather than hanging.
- A test that a stale writer cannot move the stored continuation backwards.
- A test that two separately constructed services do not share in-flight state.
- An integration test against PostgreSQL asserting the compare-and-set holds under concurrent writers.

## Open decisions

1. **What the joiner waits on.** Proposed: the in-flight hydration promise for that post, keyed by tenant and post. The alternative — answering immediately from whatever snapshot exists — is simpler and never waits, but returns a knowingly incomplete page during the very burst this exists to handle.
2. **The wait bound.** Proposed: the provider call budget plus a margin, so a joiner can never wait longer than the work it joined could legitimately take.
3. **What compare-and-set does on conflict.** Proposed: keep the newer state and do not retry, since a conflicting write means another hydration already advanced further. The alternative, retrying, risks a loop under sustained concurrency.
4. **Whether single-flight should cover the reply path too.** Proposed: no. Replies are already serialised by the idempotency claim, which is a stronger guarantee than this.

## Human decision required

Approval requires accepting:

1. Process-local mutable state in the application layer, which the service has so far avoided entirely.
2. That deduplication is per replica, so N replicas can still issue N hydrations, and that this is judged good enough until there is evidence otherwise.
3. The waiting behaviour in open decision 1, which trades a bounded wait for a correct and cheaper answer.
