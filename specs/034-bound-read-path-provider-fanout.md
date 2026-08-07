---
spec: 034
title: Bound the provider fan-out a single inbound read can cause
status: proposed
approved: no
owner: read path and provider load
depends_on:
  - Spec-019
  - Spec-021
  - Spec-033
paths:
  - src/comments/comment-service.ts
  - src/shared/observability.ts
  - src/index.ts
---

# Spec-034: Bound the provider fan-out a single inbound read can cause

## Problem / gap

There is no rate limit on provider traffic, while one cold `GET /v2/posts/{postId}/comments` can page a provider to completion. Raised as an open item in [tasks.md](../docs/tasks.md) ("No rate limiting, while one cold list request can make up to twenty provider calls").

The amplifier is `runHydration` in `src/comments/comment-service.ts`. A starting run (no cursor) completes the snapshot before answering, and that completion loops:

```ts
while (
  this.needsHydration(state, request.startingRun, returned, request.limit) &&
  hydrations < MAX_HYDRATIONS_PER_REQUEST   // = 20
) {
  const next = await this.hydrate(context, post, state);
  ...
}
```

Grounded in the code, one inbound read costs, per cold post:

- up to `MAX_HYDRATIONS_PER_REQUEST = 20` iterations (`comment-service.ts:49`, `:614`), each calling `hydrate` once;
- each `hydrate` calls `provider.listComments` once, or **twice** when a stored cursor is rejected and the stream restarts from `null` (`:734`–`:744`);
- each `provider.listComments` runs inside the adapter under `callProvider(fn, this.policies.read, …)` with the shipped read policy's `maxAttempts: 3` (`adaptive-provider.ts:74`, `observability.ts:146`), so a transient or rate-limited page is retried up to three times.

So the "twenty" the task names is the loop bound; the worst-case count of provider HTTP requests for a single inbound read is `20 × 2 × 3 = 120`, each fetching up to `PROVIDER_PAGE_LIMIT = 100` comments (`:52`).

**What is already bounded, and what is not.** `MAX_HYDRATIONS_PER_REQUEST` bounds the depth of **one request**. Single-flight (Spec-019) dedups **concurrent** readers of **one post** on **one replica** — a joiner makes zero provider calls (`comment-service.ts:253`–`:256`). Neither bounds the **aggregate rate** of provider calls. Nothing caps:

1. **Fan-out across distinct posts.** Single-flight keys on `(accountId, postId)`; `N` distinct cold posts read at once cost up to `20 × N` calls with no ceiling.
2. **Sequential cold reads.** Single-flight is a *concurrent* optimisation. A post whose snapshot ages past `SNAPSHOT_LIFETIME_SECONDS` is re-read from the start (`stale()`, `:776`) and spends up to 20 again; a client walking many posts one after another spends up to 20 each.
3. **Replicas.** Spec-019 states single-flight is per replica, so `M` replicas issue up to `M ×` the above.

The provider quota this spends is real, not hypothetical — Spec-019's own context records that X charges per post read, YouTube spends quota units per call, and Facebook's business-use-case limit is computed from engaged users. A modest burst of reads across cold or stale posts is, against that quota, the shape of an outage — which is exactly the failure Spec-019 named but explicitly left for "its own spec." This is that spec.

## Context and assumptions

- **Spec-019** established single-flight and, in its own scope, deferred "a circuit breaker or a shared rate-limit budget … a different mechanism with their own failure modes [that] belong in their own spec." It also established the precedent this spec depends on: process-local mutable state in the application layer, scoped to the composition (not the module) so tests do not leak state, accepted as good-enough-per-replica.
- **Spec-021** already built a "stop early and tell the client there is more" path. When `MAX_HYDRATIONS_PER_REQUEST` is hit mid-completion, a starting run leaves `state.exhausted` false, so `hasMore` stays true and `partialRun`/`snapshot.syncedAt: null` mark the run as one that must be restarted (`comment-service.ts:280`, `:291`, `:338`). Stopping the hydration loop early is therefore a behaviour the contract already defines.
- **Spec-033** established the house method for a protective bound: derive the number from the work it protects, and pin the relation in a test rather than hand-copying a literal. A fan-out budget should be justified against a real provider quota the same way, not set to a bare magic number.
- **The contract already anticipates a service-imposed throttle.** `docs/api-design.md` maps `429 PROVIDER_RATE_LIMITED` to "Provider **or service** rate limit was reached," and the generated OpenAPI says the same (`src/api/schemas.ts:205`) and already declares a `Retry-After` header on 429 responses (`:215`–`:231`). The route handler already emits `Retry-After` for any `ProviderRateLimitError` carrying `retryAfterMs` (`routes.ts:391`–`:394`).
- **A-003** makes the provider the source of truth and **A-006** scopes out background sync, so on-demand hydration through this loop is the *only* path that spends provider read quota today. Bounding it bounds the whole read-side quota cost.
- This is a modular monolith (A-010) that may run as several replicas.

## Scope

### In scope

1. **A bound on the provider fan-out a single inbound read can cause, beyond the per-request depth bound.** The mechanism — a per-post fetch budget, a global (per-platform) provider token bucket, or both — is Open Decision 1 below; the scope is that *some* aggregate ceiling exists and is enforced at the site where provider calls are actually made (`hydrate`/`fetchPage`), so single-flight's dedup is preserved and only real provider calls are charged.
2. **Reconciliation with single-flight (Spec-019).** The throttle is charged once per real fan-out, not once per joining reader: a joiner that makes no provider call draws no budget. Single-flight runs first; the throttle governs the non-duplicated remainder.
3. **Reconciliation with the completion budget (Spec-021).** A run truncated by the throttle mid-completion is reported exactly as a run truncated by `MAX_HYDRATIONS_PER_REQUEST` is today — partial, `hasMore: true`, `snapshot.syncedAt: null` — unless Open Decision 2 chooses 429, in which case the throttle must never leave an incomplete snapshot marked complete.
4. **How the client observes throttling** (Open Decision 2): either `429 PROVIDER_RATE_LIMITED` with a `Retry-After` the service computes from its own budget, or a partial page over the existing Spec-021 contract.
5. **Observability**, matching Spec-019's pattern: a metric distinguishing a read throttled by fan-out budget from one served normally, tagged by platform and by throttle mode.
6. **Configuration** wired in `src/index.ts` alongside the existing knobs (`SNAPSHOT_LIFETIME_SECONDS`, the fingerprint secret), so the bound is composition-supplied rather than a bare module constant, and defaults are stated.

### Out of scope

- **Cross-replica coordination.** Deferred for the same reason Spec-019 deferred it: it needs infrastructure the service does not have (ADR-0009). The bound is per replica, and that limitation is stated, exactly as single-flight's is.
- **A circuit breaker.** A different mechanism with its own failure modes; Spec-019 named it separately and it stays separate.
- **The cursor-rejection re-walk** (tasks.md P1: "a run re-walks pages 1–20 forever") and the **unbounded wall-clock on `runHydration`** (tasks.md P2). Both are real and both touch this loop, but each is a distinct defect with its own fix; a fan-out budget neither causes nor closes them.
- **Write-path rate limiting.** Replies are serialised by the idempotency claim, and a provider 429 on the reply path is already handled by Spec-026/ADR-0015. This spec is read-path only.
- **Changing `MAX_HYDRATIONS_PER_REQUEST` or `PROVIDER_PAGE_LIMIT`.** The per-request depth bound and the page size are settled by Spec-014/Spec-021; this adds an aggregate bound above them rather than retuning them.

## Contract impact

### API

This is where the decision bites. Two options, and they are not equivalent.

**Option 429 — refuse the fan-out and tell the client when to return.** When the budget is exhausted at read entry, `listComments` throws `ProviderRateLimitError` with a `retryAfterMs` the service computes (for a token bucket, the time to the next token; for a per-post budget, the time to the window's reset). This reuses the existing `PROVIDER_RATE_LIMITED` code, which `docs/api-design.md` and the OpenAPI document already reserve for a *service* limit, and flows through the existing `applyRetryAfter` unchanged — so **it needs no `/v3` and, if it reuses `ProviderRateLimitError`, no change to `routes.ts`, `schemas.ts`, or `errors.ts`.** The client action is the documented one for `provider_rate_limited`: retry unchanged after `Retry-After`. This fits a *load-protection* throttle: the client is given a *when*.

**Option partial — degrade to a partial page.** When the budget is exhausted mid-completion, the hydration loop stops early, which — through the Spec-021 machinery already in place — yields `hasMore: true` with `snapshot.syncedAt: null`, the documented signal to restart. This adds no status, no field, and stays entirely within `comment-service.ts`. Its weakness is precisely at the cold-start edge: an empty bucket at entry returns an **empty** page with `hasMore: true` and no wait hint, and the Spec-021 contract tells the client to restart *immediately* — which re-enters the same throttled path. A partial page without a `Retry-After` can therefore become a hot retry loop under the very load this exists to shed. It fits a *latency* bound better than a *load* bound.

The reason vocabulary is the second lever. Reusing `provider_rate_limited` for a service-imposed refusal is semantically loose — the provider did not rate-limit; the service declined to fan out. A clearer reason (for example `read_fanout_budget_exhausted`) is an **additive `/v2` change** the compatibility policy explicitly permits, but adding a `ServiceErrorReason` touches `src/shared/errors.ts` and `src/api/schemas.ts`, which are outside this spec's declared paths — so it is called out as Open Decision 4 rather than assumed.

**Invariant either way:** a throttle that stops a *starting* run must never report the snapshot complete. Leaving `snapshot.syncedAt` set over a snapshot the throttle prevented from finishing would reintroduce the exact truncation Spec-021 closed. Under Option partial this is automatic (the loop exit already leaves `exhausted` false); under Option 429 the service must throw rather than return a complete-looking page.

### Application

New process-local mutable state — a token bucket, a per-post counter, or both. This is the same category Spec-019 introduced and requires the same treatment: scoped to the composition (an instance field like `inFlight`, or a limiter constructed in `createApplication`), never a module global, or two compositions in one test process share a budget and interfere. Candidate placement consistent with the declared paths: a small limiter primitive in `src/shared/observability.ts` (sibling to `callProvider`/`RetryPolicy`, no infrastructure leak), consumed by `CommentService`, constructed and configured in `src/index.ts`.

### Persistence

None. Per-replica, in-process, using no stored state — consistent with Spec-019 deferring cross-replica coordination.

## Acceptance criteria

1. A sequence of reads across enough distinct cold posts to exceed the aggregate budget makes **at most the budget's worth** of provider `listComments` calls, not `20 × N` — where a per-post-only bound (equivalent to no global ceiling) would exceed it.
2. A read whose fan-out budget is exhausted is answered deterministically per Open Decision 2: either `429 PROVIDER_RATE_LIMITED` carrying a `Retry-After` the service computed, or a partial page with `hasMore: true` and `snapshot.syncedAt: null`.
3. Under Option 429, the `Retry-After` is present and positive, derived from the service's own budget rather than from provider guidance (there is none).
4. A throttle that truncates a **starting** run never reports `snapshot.syncedAt` non-null over a snapshot it prevented from completing (the Spec-021 invariant holds under throttling).
5. Single-flight is preserved: `N` concurrent readers of one cold post still cost one fan-out and draw the budget once, not `N` times — a joining reader draws nothing.
6. A read served without throttling is unchanged: same comments, same pagination, no `Retry-After`, no partial-run flag it would not otherwise carry.
7. A metric distinguishes a throttled read from a normal one, tagged by platform and mode, so the amplification is observable exactly as Spec-019 made single-flight observable.
8. The budget is composition-supplied and its default is stated; two separately constructed services do not share it.

## Verification plan

Each behavioural change is proved by a mutation that must turn the suite red.

| Mutation | Test that must fail |
| --- | --- |
| Remove the aggregate budget check (or raise it to `Infinity`) | The multi-post fan-out test (AC1): total `CountingClient.listCalls` across `N` distinct cold posts exceeds the budget. |
| Scope the budget per-post only (no global/aggregate ceiling) | The same test: `N` distinct posts each get a full allowance, so the aggregate exceeds the bound — this is the mutation that proves the new bound does something single-flight and the per-request depth bound do not. |
| Make the budget check always pass (never throttle) | The throttle-observed test (AC2): the read past the budget is neither 429'd nor returned partial. |
| Under Option 429: drop the computed `Retry-After` | The `Retry-After` test (AC3): a service-imposed 429 arrives with no header. |
| Charge the budget on a joining reader (before single-flight dedups) | The single-flight test (AC5): `N` concurrent readers of one post draw `N` tokens instead of one, and either throttle spuriously or over-report. |
| Under Option 429 mid-starting-run: return the page instead of throwing | The Spec-021 invariant test (AC4): a throttle-truncated starting run reports a non-null `syncedAt` over an incomplete snapshot. |
| Delete the throttle metric | The observability test (AC7). |

The multi-post fan-out reproduction is the load-bearing one: a `CountingClient` (already in `tests/comments/comment-service.test.ts`) across several distinct cold posts, asserting the aggregate `listCalls` respects the budget. It fails against the current implementation, which has no aggregate ceiling.

## Open decisions

1. **Per-post fetch budget, global provider token bucket, or both.** *This is the key decision.*
   - A **global (per-platform) token bucket** bounds the aggregate provider call *rate*, which is what actually protects the vendor quota Spec-019 cites and what closes the tasks.md gap; it is the classic meaning of "rate limiting." It is one mechanism and one number to reason about.
   - A **per-post fetch budget** bounds any single post's amplification across a window, so a hot or repeatedly-restarted post cannot be a fan-out engine; it keys naturally like the existing `inFlight` map. It does *not* bound broad fan-out across many posts.
   - **Both** cover different failure shapes (one hot post vs. broad fan-out) but is two mechanisms, against the CLAUDE.md preference for the smallest design that satisfies a demonstrated requirement.
   Proposed: the **global per-platform token bucket** as the primary mechanism, because the demonstrated gap is aggregate volume against a shared quota, with the per-post budget added only if a specific single-post amplification is demonstrated.
2. **429 vs. partial page** as the client-observed outcome (see Contract impact). Proposed: **429 with a computed `Retry-After`**, because this is a load-protection bound and the client needs a *when*; the partial-page edge case (an empty page with `hasMore: true` and no wait hint) invites the hot retry loop this exists to prevent. The partial page remains the honest answer for a run truncated *mid-completion* after real data was returned, so a hybrid — partial when some page was served, 429 when the bucket is empty at entry — is worth considering.
3. **How the bound is sized.** Following Spec-033, derive it from the real provider quota it protects and pin the relation in a test, rather than a bare literal. The quotas are per-platform and documented in the capability matrix, which argues for a per-platform bucket configured in `index.ts` rather than one number for all providers. Proposed: a documented default per platform, overridable by env, with the derivation recorded where the constant lives.
4. **Reuse `provider_rate_limited` or add a reason** such as `read_fanout_budget_exhausted`. Reuse keeps the change within this spec's declared paths; a new reason is clearer and `/v2`-additive but touches `errors.ts` and `schemas.ts`, expanding the path set. Proposed: **add a distinct reason**, and expand the declared paths accordingly, because a client should be able to tell a provider's refusal from the service's own on the reason alone — but this is the maintainer's call precisely because it widens scope.
5. **Whether this also needs an ADR.** A shared provider-load budget is a new architectural mechanism, and CLAUDE.md requires an ADR for a decision that establishes one, even alongside an approved spec. Spec-019 introduced its process-local state by spec plus an explicit "Human decision required" rather than a fresh ADR; this spec follows that precedent but flags the choice rather than making it.

## Human decision required

Approval requires the maintainer to decide **Open Decision 1** — whether the bound is a per-post fetch budget, a global per-platform provider token bucket, or both — and, with it, to accept:

1. **Open Decision 2**, whether an exhausted budget is a `429 PROVIDER_RATE_LIMITED` with a service-computed `Retry-After` or a partial page over the existing Spec-021 contract, which is a genuine product judgement about what a throttled read means to a client.
2. That the bound is **per replica**, so `M` replicas can still issue `M ×` the budget, judged good enough until there is evidence otherwise — the same limitation, and the same reasoning, as single-flight (Spec-019).
3. **New process-local mutable state** in the application layer, of the category Spec-019 established, scoped to the composition.
4. Whether the change also requires an **ADR** (Open Decision 5) and whether it may **add a `ServiceErrorReason`** (Open Decision 4), which would widen this spec's declared `paths` to include `src/shared/errors.ts` and `src/api/schemas.ts`.

Nothing here may be implemented until the maintainer changes `approved: no` to `approved: yes`.
