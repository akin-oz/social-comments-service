---
spec: 028
title: Stop a late writer erasing an outcome a client was already given
status: implemented
approved: yes
owner: platform-integration
paths:
  - src/repositories/**
---

# Spec-028: Stop a late writer erasing an outcome a client was already given

> **Process note.** Implemented in the same session this was written, as a
> deliberate exception by the maintainer.

## Problem

Raised as P1 by the `principal-review` board.

`markUnknown` was guarded — only a `pending` operation moves — but `complete` and
`fail` shared an `update` whose predicate was `id` and `account_id` only. Every
transition was therefore a last-writer-wins overwrite of whatever outcome was
already recorded. `complete` additionally set `failure_code` to null.

The consequence: an operation that had already told a client `unknown` could be
silently rewritten to `completed` by a writer that finished late, and the runbook
query for unknown operations then returned nothing while the customer who raised
the ticket was still holding it. The only evidence of what the client had been
told was the failure code, which the same statement erased.

## Scope

### In scope

1. `update` takes the set of statuses a transition may leave, and refuses the
   row otherwise. Both adapters.
2. `complete` accepts `pending` and `unknown`. `unknown` is deliberate:
   reconciling an unknown operation to its stored reply is the self-healing path
   Spec-015 exists for. What is excluded is a terminal outcome being overwritten.
3. `complete` preserves `failure_code` instead of nulling it, so a reconciled
   operation still records why it was ever unknown.
4. `fail` accepts only `pending`, so nothing can downgrade an `unknown` to
   `failed` — the one transition that would tell a client to retry with a new key
   after it had been told not to (ADR-0015).
5. `recordPublished` accepts only `pending`: it annotates an operation in
   flight rather than moving it, so a terminal row must not accept it either.

### Out of scope

- An operation-status endpoint, and a reconciliation pass that resolves
  `unknown`. Both deferred under A-006 and recorded in [roadmap.md](../docs/roadmap.md).

## Verification

The existing in-memory test completed an operation and then failed _the same
one_, which passed only because no transition checked the status it was leaving.
It now uses two operations, and two new tests pin the guard: a terminal
operation refuses a later `complete`, and an `unknown` one accepts it while
keeping its failure code.
