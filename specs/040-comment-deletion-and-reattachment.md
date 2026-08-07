---
spec: 040
title: Represent comment deletion and Instagram's silent reattachment
status: proposed
approved: no
owner: domain model and persistence
depends_on:
  - Spec-013
  - ADR-0014
paths:
  - src/shared/types.ts
  - src/repositories/postgres.ts
  - src/repositories/in-memory.ts
  - src/platforms/adaptive-provider.ts
  - migrations/**
  - docs/database.md
---

# Spec-040: Represent comment deletion and Instagram's silent reattachment

## Problem / gap

Two facts the provider can present, the domain model cannot say. Both were left open as domain-model work — the deletion gap under Spec-013, the reattachment gap under [ADR-0014](../docs/decisions/0014-reply-depth.md) §4 and [ADR-0016](../docs/decisions/0016-unresolved-parent-is-a-third-state.md) — and `docs/tasks.md` records them together as the last open domain items.

**A deleted comment has no representation.** `Comment` in `src/shared/types.ts` carries `id`, `postId`, `platform`, `author`, `body`, `parentCommentId`, `parentUnresolved`, `publishedAt`, and `updatedAt` — nothing that says the comment is gone. The `comments` table in migration `001` has no tombstone column, and the `deleted_at`/`status` names return zero hits across `src/`. Migration `006` gave every foreign key an `ON DELETE` behaviour, but that is referential hard deletion — a tenant or a post removed takes its comments with it — not a comment that vanishes at the provider while the post lives on.

The snapshot never reconciles a disappearance. `upsertComment` (`src/repositories/postgres.ts`) refreshes `last_seen_at = now()` for a comment it observes again, but a comment that stops coming back is simply never touched, and its row keeps being returned. Spec-013 states the resulting behaviour as out of scope in one sentence: "A comment edited or deleted at the provider stays as last observed." So a read returns a deleted comment as though it were live. `last_seen_at` is the one column that witnesses the disappearance — it is written on every upsert and read by nothing. And there is no `GET /v2/comments/{id}` (a P2 item in `docs/tasks.md`), so the list is the only surface a tombstone could ever reach.

**Instagram's silent reattachment is unmodelled.** The capability matrix records Instagram as "One level, enforced. A reply to a reply is silently reattached to the top-level comment," and ADR-0014 §4 states the consequence plainly: "The resolved parent can differ from the requested one, and the model has no field to say so." ADR-0016 confirms it is still open under "What this still does not model." The reply path cannot even retain the pair: `toObserved` sets `externalParentCommentId: item.parentExternalId ?? fallbackParentExternalId`, where the fallback is the requested parent. If Instagram returns the reply attached to the top-level comment, the service stores that top-level parent and forgets what was asked; if the reply record omits a parent, the service stores the requested parent and never learns it was moved. `reply_operations` records the requested parent as `comment_id` and the published reply as `resulting_comment_id`, but nothing pairs the requested parent with the resolved one, so the divergence is unrepresentable and undetectable.

## Context and assumptions

- A-003: the provider is authoritative; the local store is a snapshot.
- A-006: webhook ingestion, background synchronisation, and reconciliation are out of scope. There is no push signal for deletion; the only in-scope evidence a comment is gone is its absence from a **complete** provider read.
- No provider in the capability matrix documents a deletion signal — several entries read "not stated" precisely because the vendor does not document the behaviour. Deletion is therefore inferred from absence, never reported. This spec does not invent a provider deletion flag.
- Spec-013 and Spec-014 give a post `provider_exhausted` and `provider_completed_at`: together they record that a post's stream was read to its end at a known time. Spec-021 makes a bounded hydration a *partial* run — reaching the twenty-call budget is not reaching the end. A tombstone may only be inferred from a pass that is complete, never partial.
- ADR-0013 assigns identity at persistence; ADR-0016 keeps `parentUnresolved` internal and states that a divergence between the two adapters is an adapter bug. Both precedents bind here.
- No production data exists (Spec-018 context), so a nullable column is added without a backfill.

## Scope

1. **Give the domain a tombstone.** Add a way for `Comment` (`src/shared/types.ts`) to say it is deleted — a nullable `deletedAt` or a `status` enum (open decision 1).
2. **Persist it.** Add a nullable `comments.deleted_at` column in a new migration, mapped by both adapters. `last_seen_at` gains its first reader.
3. **Reconcile on a complete pass.** When a post's snapshot advances to complete — the compare-and-set `update posts set provider_exhausted, provider_completed_at` in `src/repositories/postgres.ts`, and its in-memory equivalent — mark that post's comments whose `last_seen_at` predates this completed pass as deleted. Only over a complete pass; a partial (Spec-021) run marks nothing.
4. **Retain the requested parent.** Give the reply path a place to record the parent that was asked for alongside the parent the provider resolved, so a reply whose resolved parent differs from the requested one is representable, and detectable on the next hydration. The carrier — a `reply_operations` column or a `Comment` field — is open decision 3.
5. **Mirror both in the in-memory adapter**, so the demo and shipped compositions agree (ADR-0016 precedent).
6. **Update `docs/database.md`**: the ERD, the deletion-semantics section, and a note on what a tombstone means versus a referential `ON DELETE`.
7. **Cover both with regression tests**, including the named failing mutations below.

## Contract impact

### Read contract — the fork this spec exists to surface

**Does a deleted comment appear in a read?** Two answers, and the choice is the maintainer's:

- **Option A — omit.** The list filters tombstoned rows. No response field changes. But a client holding a comment id — for instance from a reply operation — gets nothing back, and with no `GET /v2/comments/{id}` there is no endpoint that could show the tombstone; a `reply_operations.comment_id` then points at a comment no read returns. Under the `/v2` policy this removes no field, so it is schema-compatible; it changes *which* comments a list contains, which a snapshot list already does as pages shift.
- **Option B — marker.** The comment is returned carrying `deletedAt`/`status`. This is additive under the `/v2` compatibility policy — "Adding an optional field to a response" and "Adding a new member to an enum" are both permitted — and that policy already obliges clients to tolerate fields and enum members they do not recognise. Every client must then handle a comment marked deleted.

**Does it need `/v3`?** Neither option requires it if done additively. It crosses the line only if an existing field is removed, renamed, or changed in meaning — for example blanking or nulling `body` for a deleted comment changes what `body` means, which the policy lists under "Requires `/v3`." This spec proposes the additive path and flags that boundary rather than crossing it.

Note the precedent: ADR-0016 kept `parentUnresolved` out of the API response because it describes the service's sync state, not the comment. A deletion is different — it is true of the comment at the provider — which is why it is a genuine contract question rather than a settled internal flag.

### Persistence

`comments.deleted_at timestamptz` nullable, set by reconciliation, cleared if the comment is observed again (open decision 4). The reattachment carrier is a nullable column recording the requested parent, or a boolean divergence flag, on `reply_operations` or `comments`. The existing `ON DELETE` behaviour is untouched: a tombstone is a provider-side disappearance, not a referential delete.

### Application and adapters

Both adapters compute the tombstone and the reattachment marker identically. `src/platforms/adaptive-provider.ts` stops discarding the requested parent in the `parentExternalId ?? fallbackParentExternalId` fallback, so the pair survives to persistence.

## Out of scope

- Webhook- or push-driven deletion and any real-time reconciliation (A-006).
- **Surfacing the marker in the API response.** `src/api/schemas.ts` is deliberately not claimed here. Whether and how a deleted comment reaches a client is the contract decision below; Option A and an internal-only Option B land entirely within the claimed paths, while a client-facing marker needs a follow-up spec claiming the API layer.
- Representing an *edited* comment, or un-deletion as a distinct lifecycle. Only deleted-versus-live is in scope.
- Adding `GET /v2/comments/{id}`.
- Inferring deletion from a partial hydration or any single non-terminal page.
- Resolving Instagram's reattachment by a provider round trip on the write path (ADR-0016 rejected that for the depth gate; the same reasoning holds). This spec only makes the divergence representable.
- Changing pagination, cursor encoding, or ordering.

## Acceptance criteria

1. A comment present in an earlier complete sync and absent from a later complete sync of the same post is marked deleted, with `deletedAt` set to the completion instant.
2. A comment absent only from a partial or budget-bounded hydration (Spec-021) is **not** marked deleted.
3. A tombstoned comment observed again by a later sync has its deletion marker cleared (or, per open decision 4, the tombstone is terminal — whichever is approved is the one the test pins).
4. Under the approved read option the list behaves accordingly: Option A omits the tombstoned comment; Option B returns it carrying the marker.
5. A reply the service published whose resolved parent — observed on the next hydration of that reply — differs from the requested parent is representable: the requested/resolved divergence is recorded and queryable.
6. The in-memory and PostgreSQL adapters produce the same deletion and reattachment representation for the same observations.
7. `validateComment` rejects a comment in a contradictory state, mirroring ADR-0016's both-parents guard (for example, deleted with no `deletedAt`).
8. Existing Spec-013, Spec-014, and Spec-021 tests pass unchanged.

## Verification plan

- A repository test in both adapters: sync a post to completion with comments `{A, B, C}`, then re-sync to completion with `{A, C}`; assert `B` is tombstoned and `A`, `C` are not.
- A partial-run test: hydrate a post so the twenty-call budget is exhausted before the stream ends (a Spec-021 partial run); assert nothing is tombstoned.
- A re-observation test: tombstone `B`, observe it again in a later complete sync, assert the marker resolves per the approved rule.
- A reattachment test: publish a reply to parent `X`; on the next hydration the reply returns attached to top-level `Y`; assert the requested/resolved divergence is recorded.
- A PostgreSQL integration test for the migration and the reconciliation write.
- **Named failing mutation — `tombstone-on-partial-pass`.** Widen the reconciliation guard from "the post's snapshot is complete" to "any hydration pass." Criterion 2 turns red: a live comment sitting beyond the twenty-call budget is falsely reported deleted, which is exactly the Spec-021 partial-run case the guard exists to exclude.
- **Named failing mutation — `drop-requested-parent`.** Remove the requested-parent carrier so `toObserved` in `src/platforms/adaptive-provider.ts` keeps only `parentExternalId ?? fallbackParentExternalId`. Criterion 5 turns red: a reattached reply reads as though it went where it was asked to go, and the divergence is unrepresentable again — the precise gap ADR-0014 §4 named.

## Open decisions

1. **Marker shape.** `deletedAt: string | null` versus a `status: 'visible' | 'deleted'` enum. The enum extends naturally to a future `edited` state; the timestamp is smaller and carries the completion instant directly.
2. **The read contract: Option A or Option B.** The load-bearing decision. It determines whether this stays a domain and persistence change within the claimed paths, or requires a follow-up spec claiming `src/api/schemas.ts`.
3. **Reattachment carrier.** A `reply_operations` column (audit-shaped: the operation is the record of a publication under a customer's name) versus a `Comment` field. And whether the marker is internal like `parentUnresolved` (ADR-0016) or client-facing.
4. **Re-observation.** Does observing a comment again clear its tombstone, or is a tombstone terminal? Clearing keeps the snapshot faithful to a provider that restores content; terminal keeps the audit trail of what was once seen removed.
5. **Detection placement.** Reconciliation attached to the repository's advance-to-complete write keeps the change inside the claimed paths. A service-level sweep would need `src/comments/comment-service.ts`, which is not claimed here, and is the shape a later webhook-driven reconciliation (A-006) would want.
6. **Tombstone retention.** How long a tombstoned row is kept ties into the open retention decision already recorded in `docs/operations.md`.

## Human decision required

Decide how a deleted comment appears in a read: **Option A — omit it from the list**, or **Option B — return it with a deletion marker**. That single choice governs the rest — whether the change stays within the claimed domain, adapter, and migration paths or needs a follow-up spec that claims `src/api/schemas.ts`, and whether any part of it approaches the `/v2` → `/v3` line. Approving the spec also means accepting the `comments.deleted_at` column, reconciliation only over a completed snapshot pass, and a carrier for the requested-versus-resolved parent so Instagram's reattachment becomes representable. Nothing here is implemented until you change `approved: no` to `approved: yes`.
