---
spec: 015
title: Make a reply operation recoverable and its outcome honest
status: accepted
approved: yes
owner: platform-integration
depends_on:
  - Spec-010
---

# Spec-015: Make a reply operation recoverable and its outcome honest

## Problem / gap

Two defects the principal-review board found in the reply operation's state machine, both of which turn a transient failure into a permanent one.

**A crash between claim and completion poisons the key forever.** The claim inserts a `pending` row, and only the process that inserted it can resolve it. If that process dies — a rolling deploy mid-request is enough — every subsequent request with that key is answered `409 already in progress`, permanently, until someone runs SQL by hand. There is no lease, no expiry, and no reconciliation.

**There is no state for "unknown".** `ReplyOperationStatus` is `pending`, `completed`, or `failed`. A timeout after the request reached the provider, a crash after a confirmed publish, and a clean rejection are all indistinguishable from one another, to the client and to the operator alike. The recent hardening improved this — a storage failure after a publish now leaves the operation `pending` rather than marking it `failed`, because `failed` invited the client to duplicate — but `pending` is being used to mean two different things: in flight, and outcome unknown.

The two compound. An operation left `pending` by a crash is indistinguishable from one left `pending` because the publish succeeded and the write did not, and neither can be resolved without a human.

## Context and assumptions

- A-009: clients supply an idempotency key; the design is at-most-once, and a failed key is terminal.
- Spec-010 established the claim-on-insert and the terminal-failure rule.
- The provider is authoritative, so an operation whose outcome is unknown can be reconciled by asking whether the reply exists — but only where the adapter can look up a comment by its own identifier, which the current provider port cannot do.

## Scope

### In scope

1. **Lease the claim.** A claimed operation carries an expiry. A request that finds an expired lease may take it over rather than being told the work is in flight forever.
2. **Add an `unknown` terminal state**, distinct from `failed`, for an operation whose outcome at the provider cannot be established: a timeout after send, an expired lease, or a storage failure after a confirmed publish.
3. **Give `unknown` its own error code** so a client can tell "definitely not published, use a new key" from "possibly published, a human should look". These call for different client behaviour and currently share one.
4. **Self-heal the resolvable case.** An operation left pending after the reply was stored can be completed by reconciling against the stored comment, without asking the provider.
5. Record the lifetime and the state machine in the operations guide, so an operator knows what each state means and which ones need attention.

### Out of scope

- Asking the provider whether a reply exists. That needs a lookup capability the provider port does not have, and it belongs with Spec-016.
- Automatic retry of an unknown operation. Unknown means unknown; retrying is the caller's decision, taken with a new key.
- Background reconciliation. Recovery happens on the next request for that key.

## Contract impact

### API

A new error code for the unknown outcome, additive to the documented taxonomy. `IDEMPOTENCY_CONFLICT` keeps its meaning for a key reused with a different body and for one genuinely in flight.

The status code for unknown needs choosing: `409` groups it with the other idempotency outcomes, `503` says try later, and neither is obviously right. See open decisions.

### Persistence

`reply_operations` gains a lease expiry, and `ReplyOperationStatus` gains `unknown`. The status column has a check constraint, so this is a migration.

### Spec-010 revision

Spec-010's "a failed key is terminal" stands. This spec splits the failures it covered: those the provider definitively rejected stay `failed` and terminal; those whose outcome nobody knows become `unknown`, which is also terminal for that key but says something different to the client.

## Acceptance criteria

1. An operation whose lease has expired can be taken over by a later request rather than answering `409` forever.
2. A timeout after the provider call is recorded as `unknown`, not `failed`.
3. A storage failure after a confirmed publish is recorded as `unknown`, and the log names the provider's identifier for the reply that exists.
4. An operation left pending with its reply already stored is completed on the next request for that key, without contacting the provider.
5. `unknown` and `failed` produce different error codes, and both are documented with the client action each implies.
6. Two concurrent requests still cannot both reach the provider; leasing does not weaken the claim.
7. An expired lease on an operation that did reach the provider does not cause a second publish.

## Verification plan

- A test that claims a key, expires the lease, and confirms a later request proceeds.
- A test that a timeout after send yields `unknown` rather than `failed`.
- A test that a storage failure after publish yields `unknown` and that a subsequent request reconciles to `completed` when the reply is present.
- A concurrency test asserting a lease does not let two callers publish.
- An integration test against PostgreSQL covering the state transitions and the migration.

## Open decisions

1. **Lease duration.** Proposed: a small multiple of the provider call budget, so a lease can only expire after the request that holds it must already have finished or died. Too short risks a takeover racing a live request; too long restores the current problem in slower motion.
2. **The status code for `unknown`.** Proposed: `409`, keeping every idempotency outcome in one place and distinguished by code and reason. `503` would imply the service is at fault, which it is not.
3. **Whether a takeover republishes.** Proposed: no. An expired lease whose operation may have reached the provider becomes `unknown`; only a lease that provably never reached it may be retried, and the current port cannot prove that.
4. **Whether `unknown` should be visible in a listing**, so an operator can find these without querying the database directly. Proposed: out of scope, but it is the operational follow-up.

## Human decision required

Approval requires accepting:

1. A migration adding a lease column and widening the status check constraint.
2. A new error code in the public taxonomy, and the status code chosen in open decision 2.
3. That an unknown outcome is surfaced to the client as unknown rather than being flattened into failure, which means some clients will need to handle a case they currently do not.
