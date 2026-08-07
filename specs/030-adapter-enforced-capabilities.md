---
spec: 030
title: An adapter enforces the capabilities it declares
status: implemented
approved: yes
owner: platform-integration
paths:
  - src/platforms/**
---

# Spec-030: An adapter enforces the capabilities it declares

> **Process note.** Implemented in the same session this was written, as a
> deliberate exception by the maintainer.

## Problem

Raised as P1 by the `principal-review` board.

`AdaptiveProviderAdapter` declares `capabilities` publicly, and neither
`listComments` nor `replyToComment` consulted it. Enforcement lived entirely in
`requireCapability`, called by the service before each operation.

Both current call sites are correct. A third — or a background sync reaching the
adapter directly, which A-006 defers rather than rejects — would silently call a
client that does not implement the operation. A declaration the declaring object
does not enforce is documentation.

## Scope

### In scope

1. Both adapter operations assert their capability before touching the client,
   raising the same `UNSUPPORTED_CAPABILITY` / `capability_unsupported` error the
   service raises.
2. The call-site `requireCapability` check stays. It fails before a claim is
   taken and without touching the network, which is a better failure than this
   one; the adapter check is the backstop, not the replacement.

### Out of scope

- Deriving capabilities from the client rather than passing them in. The
  capability matrix is documentation of vendor behaviour, not something an
  adapter can introspect.
