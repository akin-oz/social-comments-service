---
spec: 029
title: A joining reader does not inherit the originator's failure
status: implemented
approved: yes
owner: platform-integration
paths:
  - src/comments/comment-service.ts
---

# Spec-029: A joining reader does not inherit the originator's failure

> **Process note.** Implemented in the same session this was written, as a
> deliberate exception by the maintainer.

## Problem

Raised as P1 by the `principal-review` board.

Single-flight hydration (Spec-019) exists to stop K concurrent readers on a cold
post costing K provider walks. `joinHydration` raced the in-flight promise
against a timeout, and the timeout branch resolved to a serviceable fallback
snapshot — but the promise itself was raced with no rejection handler. A provider
failure therefore propagated to every reader waiting on it.

So a load optimisation had quietly turned one upstream failure into a fan-out of
them: K readers arriving together on a cold post all received 503, each while
holding a snapshot it could have been served from. A joiner did not make the call
that failed and has no more reason to fail than it does to wait forever.

The suite covered the provider failing, but only for a caller running alone —
never with a joiner attached, which is the case that multiplies it.

## Scope

### In scope

1. The joined promise carries a rejection handler that resolves to the same
   fallback snapshot the timeout branch uses.
2. A `comments.list.hydration_join_failed` counter and log record, carrying the
   failure code and the wait, so the fan-out that used to be visible as a burst
   of 503s stays visible as a burst of something.
3. The originator still surfaces its own failure. It made the call.
4. A test with four concurrent readers on a failing provider: exactly one
   rejects, three are served an empty-but-honest page, and the provider is
   called once.

### Out of scope

- Cross-replica deduplication. `inFlight` remains instance-local and Spec-019
  says so.

## Verification

Reverting to the unhandled race makes the new test fail with all four callers
rejected — the fan-out, reproduced.
