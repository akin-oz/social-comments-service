---
spec: 014
title: Make the read path reachable, refreshable, and honest about freshness
status: accepted
approved: yes
owner: platform-integration
depends_on:
  - Spec-008
  - Spec-013
---

# Spec-014: Make the read path reachable, refreshable, and honest about freshness

## Problem / gap

Three defects in the read path, all found by the principal-review board, two of them reproduced by execution.

**Comments become unreachable in a pagination run.** Hydration triggers on an under-filled local page, while pagination advances a `(publishedAt, id)` keyset. Those are two different orderings. A provider that returns newest first — the documented default for Meta, X, and YouTube — delivers its second page of results _behind_ the caller's cursor. The keyset query then returns nothing, `hasMore` collapses to `false` because the page is empty, and the caller is told the post is exhausted while unread comments sit in the snapshot. Reproduced at four of six comments unreachable by any call sequence.

**`provider_exhausted` is a one-way latch.** Nothing ever sets it back to `false`. Once a post has been read through, every comment posted afterwards is invisible indefinitely, with no error. For a comments product whose users poll for new engagement, this is the worst possible failure: silent and permanent.

**The contract cannot express freshness.** A response is a snapshot that may lag the provider, and no field says how far. `hasMore: false` also conflates "nothing more exists" with "nothing more is visible to us" — Facebook filters low-quality comments by default, YouTube returns only a subset of replies inline, and X's listing is a seven-day search window.

## Context and assumptions

- A-003: the provider is authoritative; the local store is a snapshot.
- Spec-013 introduced snapshot state and resolved open decision 2 as one provider page per request. **That decision is what makes the first defect reachable**, and this spec revises it.
- Re-reading a provider page is idempotent through `(social_account_id, external_comment_id)`, so replay is safe and cheap.
- Vendor documentation states cursors must not be stored, so any stored continuation must be treated as best-effort.

## Scope

### In scope

1. **Hydrate until the requested window is satisfiable**, rather than once per request: loop while the local page is short and the stream is not exhausted, bounded by an explicit maximum of provider calls per request.
2. **Never collapse `hasMore` to `false` on an empty local page while the stream is not exhausted.** Exhaustion decides the answer, not page fill.
3. **Give exhaustion a lifetime.** A post whose snapshot was completed longer ago than a configured interval is eligible for re-hydration from the start of the stream.
4. **Add a snapshot timestamp to the list response** so a client can reason about freshness instead of assuming it.
5. **Handle a rejected provider cursor**: reset the stored continuation, replay the stream from the beginning once, and rely on upsert deduplication. The capability matrix already names both the risk and this remedy.
6. **Drop the provider cursor from the public cursor.** The service reads persisted snapshot state instead, so the field is write-only, and it hands clients the very token vendors say not to store.

### Out of scope

- Webhook ingestion and background synchronisation, still deferred by A-006.
- Reflecting edits, deletions, or moderation of comments already stored.
- Any change to keyset ordering or cursor encoding beyond removing the provider field.

## Contract impact

### API

The list response gains a snapshot timestamp. This is additive, and `additionalProperties: false` means existing clients are unaffected while the OpenAPI document and `docs/api-design.md` must both record it.

`hasMore` becomes correct where it was previously wrong. A client that inferred completeness from `hasMore: false` was being misled.

A response may now contain more provider round trips than before, so tail latency on a cold post rises in exchange for a correct answer.

### Persistence

Snapshot state gains a completion timestamp so exhaustion can expire. `provider_cursor` and `provider_exhausted` keep their meaning.

### Spec-013 revision

Open decision 2 of Spec-013 chose one provider page per request, explicitly trading response quality for a bounded number of provider calls. That trade produced the unreachability defect. This spec reverses it and bounds the loop instead, which is the bound that was actually needed.

## Acceptance criteria

1. With a provider that returns newest first, every comment on a post is reachable by following cursors from the first page, with no comment returned twice.
2. A response never reports `hasMore: false` while the stream is not exhausted.
3. Hydration within one request is bounded, and the bound is stated in the operations guide.
4. A post whose exhaustion has expired re-hydrates and surfaces comments published after it was first read through.
5. The list response carries a snapshot timestamp, present in `docs/openapi.json`.
6. A rejected provider cursor resets the stream and replays it once, and the replay stores no duplicate rows.
7. The public cursor no longer contains a provider token.
8. Existing Spec-008, 009, and 013 tests pass, except those asserting one provider call per request, which this spec revises.

## Verification plan

- A service test with a newest-first fixture provider walking every page, asserting the full set is seen exactly once. This test fails against the current implementation.
- A test asserting `hasMore` tracks exhaustion rather than page fill.
- A test that expires exhaustion, adds a provider comment, and confirms it becomes visible.
- A test where the provider rejects a stored cursor, asserting the stream restarts and rows do not duplicate.
- An integration test through `createPostgresApplication` covering the newest-first walk against a real database.

## Open decisions

1. **Exhaustion lifetime.** Proposed: a few minutes, configurable, since the cost of re-reading is one provider page and the cost of not re-reading is invisible comments. A longer interval saves provider quota against a rate-limited API.
2. **The per-request hydration bound.** Proposed: enough pages to fill the requested limit plus a small margin, capped absolutely. A high cap improves correctness on cold posts; a low one protects tail latency and provider quota.
3. **What the snapshot timestamp means when a page needed no hydration.** Proposed: the time the post's snapshot was last synchronised, not the time of the request, so it does not falsely imply freshness.
4. **Whether `hasMore: false` should distinguish "exhausted" from "the provider will not show us more".** Vendor filtering makes these genuinely different. Proposed: out of scope here, but it is the honest version and belongs in a later spec.

## Human decision required

Approval requires accepting:

1. That Spec-013's one-page-per-request decision is reversed, so a cold read may make several provider calls and take correspondingly longer.
2. An additive response field, and the migration that adds a completion timestamp.
3. Re-hydration after expiry, which spends provider quota on posts nobody is reading, bounded by the lifetime chosen in open decision 1.
