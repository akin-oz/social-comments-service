---
spec: 039
title: Give an unknown reply operation an exit and a traceable id
status: proposed
approved: no
owner: reply lifecycle and observability
depends_on:
  - Spec-015
  - Spec-028
paths:
  - src/comments/comment-service.ts
  - src/repositories/postgres.ts
  - src/repositories/database.ts
  - src/shared/observability.ts
  - docs/operations.md
---

# Spec-039: Give an unknown reply operation an exit and a traceable id

## Problem / gap

The principal-review board recorded it in one line under P1 ([tasks.md](../docs/tasks.md)): "`unknown` is terminal with no exit, and no log record carries the operation id while the runbook's triage query returns operation ids." Both halves are true of the code as it stands, and they compound. `unknown` is the one reply-operation state the operations guide marks **Needs an operator: Yes** — and it is the one an operator cannot follow through the logs and the service can never close on its own.

**`unknown` has no exit.** `CommentService.replay` (`src/comments/comment-service.ts`) answers a repeated idempotency key. For an `unknown` operation it runs one line — `if (operation.status === 'unknown') throw unknownOutcome();` — and returns `REPLY_OUTCOME_UNKNOWN` every time, for the life of the row. The only reconciliation the service has, `recover`, is reached one branch later and only for `pending`; it never runs for `unknown`. So once an operation is `unknown` nothing completes it, nothing closes it, and nothing ever reads it again except to re-throw. The `markUnknown` guards in both adapters accept only `pending`, and `fail` accepts only `pending`, which is correct — but there is no path that leaves `unknown` at all.

The exit transition is, in fact, already permitted at the persistence layer and simply has no caller. Spec-028 widened `complete` to accept `['pending', 'unknown']` in both `postgres.ts` and `in-memory.ts`, precisely "because reconciling an unknown operation to its stored reply is the self-healing path Spec-015 exists for." That path was never wired: `replay` short-circuits `unknown` before `recover` — the only place `complete` is called during recovery — can run. The guard is live and the transition is dead.

**No reply-path log record carries the operation id.** `trace(context)` emits `requestId` and `accountId` and nothing else, and every reply-path record is built from it. The service holds `claim.operation.id` throughout — it passes it to `fail`, `markUnknown`, `recordPublished`, and `complete` — but never to a `logger` call. None of the nine reply records carries it: not `comments.reply.orphaned`, which is the record that "always warrants a human"; not `comments.reply.lease_expired`; not `comments.reply.unreconciled`; not `comments.reply.reconciled`, `published`, `failed`, `replayed`, or `conflict`.

**The two compound around the runbook.** The triage query in [operations.md](../docs/operations.md) hands an operator a set of operation `id`s as its first column:

```sql
select id, account_id, comment_id, external_reply_id, failure_code, completed_at
from reply_operations
where status = 'unknown'
   or (status = 'pending' and lease_expires_at < now());
```

An operator who finds `id = X` there has no log record keyed on `X`. The only shared field between the triage row and the logs is `comment_id` / `commentId`, and that is not unique to an operation — one comment can be the target of many reply operations over time — so it cannot join a specific `unknown` row to the request that produced it. The guide claims "in every case the log record names the provider's identifier for the reply that may exist," but that is `externalReplyId`, not the operation id, and even it is conditional: `comments.reply.lease_expired` includes `externalReplyId` only when it is non-null, so a lease that expired before any provider identifier was recorded leaves a record with neither an operation id nor an external reply id — just a comment id.

The gap also contradicts a promise the public contract already makes. [api-design.md](../docs/api-design.md) tells a client that hit `429 PROVIDER_RATE_LIMITED` on a reply to "retry **the same idempotency key**," and states "Retrying the same key is safe: it is either resolved to the reply that exists or refused as unknown." Under ADR-0015 a rate-limited reply records `unknown`, so that retry lands on an `unknown` operation — and the code delivers only the "refused as unknown" half. The "resolved to the reply that exists" half is unreachable for `unknown`, because `unknown` has no reconciliation. The documentation promises a resolution the state machine cannot reach.

## Context and assumptions

- A-009: clients supply an idempotency key; the design is at-most-once, and a terminal key is terminal. `unknown` is terminal-for-that-key and says "a reply may exist; do not retry."
- Spec-015 introduced `unknown` as a fourth terminal state with its own error code, self-healed the resolvable `pending` case against the stored reply, and **deferred two things by name**: asking the provider whether a reply exists ("that needs a lookup capability the provider port does not have, and it belongs with Spec-016"), and background reconciliation ("recovery happens on the next request for that key").
- Spec-016 gave the provider port an authorization context but did **not** add a comment-lookup capability. `CommentPlatformProvider` (`src/comments/contracts.ts`) still exposes exactly `listComments` and `replyToComment`. There is no `getReplyByExternalId`, so an automated exit that establishes truth by asking the provider is still blocked by a missing capability — and inventing that capability is out of bounds for this spec.
- Spec-028 widened `complete` to accept `unknown` and held `fail` to `pending` only, so `unknown` can move to `completed` but can never be downgraded to `failed` — the one transition that would tell a client to retry with a new key (ADR-0015).
- Spec-033 derives `REPLY_LEASE_MS` from the real post-claim budget (one publish plus three database calls, bounded by `DATABASE_CALL_BUDGET_MS` in `src/repositories/database.ts`). Any change that added a database call to the claim-holding critical section would move that budget; the exit here runs on a **replay**, outside any held claim, so it must not.
- ADR-0011: the logger port carries a stable `event` and arbitrary `fields`; callers must not pass content, only measurements or service-owned identifiers. `requestId` and `accountId` already ride every record. A reply-operation id is a service-owned UUID of the same kind.
- A-006 and ADR-0009 defer webhook ingestion, background synchronization, and a worker topology. Anything that resolves `unknown` on a schedule rather than on a request belongs to that deferred work.
- The front matter deliberately does not claim `migrations/**`. The exit specified here therefore introduces no new status value and no new column; it reuses the `unknown -> completed` transition Spec-028 already made legal.

## Scope

### In scope

1. **Trace every post-claim reply record by operation id.** Add `operationId`, equal to the operation's own id, to the reply-path `logger` records that are emitted once an operation row exists: `comments.reply.orphaned`, `comments.reply.unreconciled`, `comments.reply.lease_expired`, `comments.reply.reconciled`, `comments.reply.published`, the post-claim `comments.reply.failed`, and the `replayed` / `conflict` records that already hold an operation. The pre-claim records — `COMMENT_NOT_FOUND` and `REPLY_DEPTH_EXCEEDED` — create no operation and neither carry nor need it. The field goes on log records only, never as a metric tag: an operation id is unbounded cardinality and `Metrics` is the wrong place for it.

2. **Give `unknown` an exit by reconciling it against the stored reply, on replay.** When `replay` meets an `unknown` operation that carries an `externalReplyId`, attempt the same stored-reply lookup `recover` already performs for `pending` — `findReplyByExternalId(context, operation.commentId, operation.externalReplyId)` — and, if the reply is now stored locally, `complete` the operation (`unknown -> completed`, already legal per Spec-028) and return it. If the reply is not stored, the operation stays `unknown` and the caller still receives `REPLY_OUTCOME_UNKNOWN`. This reconciliation touches no provider and, unlike the `pending` case, races no live holder: an `unknown` operation is terminal, so there is no in-flight request to resolve out from under.

3. **State the correlation in the operations guide.** Record in [operations.md](../docs/operations.md) that reply-path records carry `operationId`, that the triage query's `id` is the field to grep the logs by, and that an `unknown` operation whose published reply is later hydrated into the snapshot self-heals to `completed` on the next request for its key — the same shape the guide already documents for the recoverable `pending` case.

The concrete edits land in `src/comments/comment-service.ts` (the `operationId` fields and the `replay` reconciliation branch) and `docs/operations.md`. `src/shared/observability.ts` needs at most a one-line note in the `Logger` doc-comment that a reply-operation id is an accepted correlation field; the port itself does not change, because it already carries arbitrary fields. `src/repositories/postgres.ts` and `src/repositories/database.ts` are claimed as the state-machine and call-budget surface but see no structural change under this proposal: the exit reuses the existing `complete` guard and `findReplyByExternalId`, and adds no database call inside a held claim, so `REPLY_LEASE_MS` and `DATABASE_CALL_BUDGET_MS` are untouched. `src/repositories/in-memory.ts` is intentionally not claimed and does not change, which is only true because the exit reuses `complete`'s existing `['pending', 'unknown']` acceptance rather than adding a transition.

## Contract impact

### What a client sees for `REPLY_OUTCOME_UNKNOWN` — and what must not change

While an operation is `unknown` and its reply is not locally reconcilable, every replay of its key returns exactly what it returns today: `REPLY_OUTCOME_UNKNOWN`, reason `reply_outcome_unknown`, `409`, whose documented action is **"Do not retry. Escalate — a reply may already exist."** This spec does not touch that code, status, reason, or action. The "do not retry" guarantee is the invariant the whole reply lifecycle is built to protect, and the exit is constrained by it:

- The exit may move `unknown` only to `completed`, and only when the actual published reply is in hand. It must never route through `fail`. `failed` is the single outcome that tells a client to retry with a new key, and a new key is the one thing that duplicates a reply under a customer's name (ADR-0015, Spec-028). The `fail` guard already forbids `unknown -> failed`; this spec adds nothing that could.
- The exit is a read-and-reconcile, never a re-publish. It does not weaken the write policy's "replay nothing" (ADR-0015).
- After the exit completes an operation, a subsequent replay returns the stored reply — the same behavior `completed` already produces. A client that obeyed "do not retry" never observes the transition; a client that retried the same key (which api-design.md already calls safe) now gets the reply instead of a repeated `REPLY_OUTCOME_UNKNOWN`.

This is additive under the `/v2` compatibility policy: it makes reachable the "resolved to the reply that exists" branch that api-design.md already promises for a retried key, without changing any code, status, or reason. No new error code, no new field on a response.

### Observability contract

`operationId` is a new, additive field on the named reply records. Alerts and dashboards match on `event`, never on fields (ADR-0011), so no consumer breaks. The field is a service-owned UUID and carries no content, so it is within the redaction contract the `Logger` port already states.

## Out of scope

- **A new terminal state** (`acknowledged`, `closed`, `resolved`) or any column such as `acknowledged_at`. Either is a `reply_operations` schema change and a migration, and `migrations/**` is deliberately unclaimed. The exit here reuses `completed`.
- **Asking the provider whether the reply exists.** That needs a lookup capability `CommentPlatformProvider` does not have — deferred by Spec-015, still absent after Spec-016 — and inventing provider behavior is forbidden. Even a provider "not found" could not become `failed` (ADR-0015), so a provider-backed exit is a larger change with its own ADR.
- **Background or scheduled reconciliation.** A sweep that resolves `unknown` off a request path is the worker topology A-006 and ADR-0009 defer.
- **The un-reconcilable residue.** An `unknown` operation with no `externalReplyId` (a timeout before the provider identifier was recorded), or one whose reply is never hydrated back into the snapshot, cannot be completed locally and stays `unknown` for an operator. This spec makes that operator's job possible by giving them the operation id in the logs; it does not close the residue automatically. Its disposition is the open decision below.
- Any change to `failed` semantics, to the write retry policy, or to `REPLY_OUTCOME_UNKNOWN`'s code, status, or action.
- An operation-status endpoint or an `unknown` listing (Spec-015 open decision 4; Spec-028 out of scope).

## Acceptance criteria

1. Every reply-path log record emitted after an operation row exists carries `operationId` equal to that operation's id: `comments.reply.orphaned`, `comments.reply.unreconciled`, `comments.reply.lease_expired`, `comments.reply.reconciled`, `comments.reply.published`, the post-claim `comments.reply.failed`, and the `replayed` / `conflict` records. `operationId` never appears as a metric tag.
2. Pre-claim records (`COMMENT_NOT_FOUND`, `REPLY_DEPTH_EXCEEDED`) do not carry `operationId`, because no operation exists.
3. Replaying the idempotency key of an `unknown` operation whose published reply is now stored locally completes the operation (`unknown -> completed`) and returns that reply, instead of throwing `REPLY_OUTCOME_UNKNOWN`.
4. Replaying the key of an `unknown` operation whose reply is not stored still throws `REPLY_OUTCOME_UNKNOWN` (`409`), and the operation is never moved to `failed`.
5. The exit never calls `fail`; no code path can downgrade `unknown` to `failed`.
6. The reconciliation adds no database call inside a held claim, so the `REPLY_LEASE_MS` / `DATABASE_CALL_BUDGET_MS` relation asserted under Spec-033 is unchanged.
7. `docs/operations.md` states that reply records carry `operationId`, that the triage query's `id` is the log correlation key, and that an `unknown` operation self-heals to `completed` once its reply is hydrated.
8. The `unknown -> completed` reconciliation behaves identically in the in-memory and PostgreSQL compositions.

## Verification plan

- **Tracing.** A service-level test drives an operation to `unknown` via the orphaned-publish path (a `storePublishedReply` failure after `recordPublished`) and asserts the captured `comments.reply.orphaned` record carries `operationId` equal to the claimed operation id; a second asserts the same for `comments.reply.lease_expired`.
- **The exit (primary).** A test claims a key, drives the operation to `unknown` with an `externalReplyId` recorded, stores the reply as a later hydration would, then replays the key and asserts the operation is `completed` and the stored reply is returned.
- **The guarantee.** A test replays the key of an `unknown` operation whose reply is not stored and asserts `REPLY_OUTCOME_UNKNOWN` is still thrown and the row is never `failed`.
- **Both adapters.** A PostgreSQL integration test mirrors the exit test, proving the service now drives the `unknown -> completed` transition Spec-028 made legal but nothing exercised end to end.

**Named failing mutation.** In `CommentService.replay`, restore the current line `if (operation.status === 'unknown') throw unknownOutcome();` in place of the new reconciliation branch — that is, revert to today's behavior. The exit test in criterion 3 turns red: the key stays `unknown` forever and never returns the stored reply. Because the mutation is literally the present code, a red test here is the proof that "`unknown` is terminal with no exit" is a real defect and that the reconciliation branch is load-bearing. A second mutation — routing the exit through `fail` instead of `complete` — turns the criterion-4/5 guarantee test red. A third — deleting `operationId` from the `comments.reply.orphaned` fields — turns the tracing test red.

## Open decisions

1. **Is the unknown-exit automated or manual — and how far does it go?** This spec proposes the automated, in-port, no-migration half: reconcile `unknown` against the locally stored reply on replay. It is eventually consistent and partial — it fires only for operations that recorded an `externalReplyId` and whose reply is later hydrated into the post's snapshot. The residue (no `externalReplyId`, or a post never listed again) is left `unknown`. The maintainer's decision is whether that automated local reconciliation is the intended answer, or whether the residue must also be closed, which forces a choice this spec cannot make within its paths:
   - **Manual close** — an operator resolves the residue using the newly-logged operation id, either by triggering a re-list so reconciliation completes it, or by an explicit acknowledgement. An explicit terminal/ack state for the un-hydratable residue is a new status or column, hence a migration, hence out of these paths.
   - **Automated provider read** — a bounded provider lookup of the reply by `externalReplyId` resolves the residue on truth, but requires a new `CommentPlatformProvider` capability (an ADR; Spec-015 deferred it) and likely the A-006 / ADR-0009 worker, and still may not downgrade to `failed`.
   The trade is residue coverage against new surface: the automated local exit adds no schema, no provider method, and no worker, but leaves a residue; either fuller exit closes more at the cost of a migration, a provider capability, or a background topology.
2. **How many records carry `operationId`.** Proposed: all post-claim reply records, so a whole request reconstructs, not only the two states the triage query surfaces. The field is a service-owned id within ADR-0011's contract, so the wider set costs nothing and the narrow set would leave `published` and `replayed` un-correlatable.

## Human decision required

Approving this spec accepts two changes and no more: (a) `operationId` added to the post-claim reply-path log records, and (b) an exit for `unknown` implemented as an on-replay reconciliation against the locally stored reply, moving `unknown -> completed` (never `failed`) and otherwise leaving `REPLY_OUTCOME_UNKNOWN` and its "do not retry" action exactly as documented.

The one decision to make is the exit's reach: **approve the automated local reconciliation as the exit and leave the un-reconcilable residue to an operator** (no migration, no provider change), **or** direct that the residue be closed too — which means either a manual acknowledgement path with a new terminal state (a migration, a separate spec) or a provider-backed reconciliation read (a new provider capability and an ADR, plus the deferred worker). Approval of this spec authorizes neither a migration, nor a new provider capability, nor a background worker; those require their own approved documents. Nothing here may be implemented until the maintainer changes `approved: no` to `approved: yes`.
