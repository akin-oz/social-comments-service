---
spec: 022
title: Stop client mistakes arriving as service failures
status: proposed
approved: no
owner: api
depends_on:
  - Spec-011
  - Spec-017
---

# Spec-022: Stop client mistakes arriving as service failures

## Problem / gap

Three things a client controls reach the service in a shape it does not handle, and the cost lands on the operator rather than the client.

**A transport-level rejection becomes a 500 with a stack trace.** The error handler checks `error.validation`, then `DomainValidationError`, then `ServiceError`, then falls through to `INTERNAL_ERROR` at log level 50 with a full stack. Fastify's own errors — an oversized body, malformed JSON, an unsupported media type — are none of those three, but they all carry a `statusCode` the handler never reads. So a request body over Fastify's default 1 MB limit produces `INTERNAL_ERROR`, a roughly 1 KB error-level record, and a page-worthy signal, for something the client did wrong. `docs/operations.md` promises the opposite: "a rejected client request is logged at warn, never error." It is a cheap log-flooding and alert-blinding vector, and it needs no authentication beyond a valid account header.

**No explicit body limit is set** despite the reply body schema capping at 10,000 characters. The gap between 10 KB of legitimate content and Fastify's 1 MB default is a hundredfold of parse work the contract never wanted.

**`X-Request-Id` is trusted verbatim.** Fastify is configured with `requestIdHeader: 'x-request-id'`, so a caller-supplied value flows unbounded into every log record and into every error body as `requestId`. A 229-character value was accepted. The correlation identifier the operations guide tells an operator to reconstruct a request by is therefore attacker-controlled: two unrelated requests can be given the same id, or an id can be crafted to collide with a real one. The trust boundary for `X-Account-Id` is documented in four places; this header's is documented nowhere.

**Unknown routes escape the error envelope.** Fastify's default 404 returns its own JSON shape, so a client that handles `error.code` uniformly meets one response that has none, and the body advertises the framework.

## Context and assumptions

- A-001: an internal gateway authenticates the caller and supplies context. That makes the headers trustworthy for _authorisation_, which is not the same as trustworthy for _unbounded logging_.
- Spec-017 established that every error carries a `code` and a machine-readable `reason`; these paths are the ones that escape it.
- ADR-0011 governs log levels and the shape-only rule for error records.

## Scope

### In scope

1. **Honour a sub-500 `statusCode` on an unrecognised error** as a client error: map it into the documented envelope with a code and reason, and log it at warn.
2. **Set an explicit `bodyLimit`** proportionate to the largest documented body, rather than inheriting a default two orders of magnitude larger.
3. **Bound or replace the request identifier.** Either generate it server-side and ignore the header, or accept it only when it matches a bounded, restrictive pattern.
4. **Document the request-identifier trust boundary** next to A-001, where the account-header boundary is already stated.
5. **Add a not-found handler** so an unknown route answers in the same envelope as everything else.
6. Tests for each: an oversized body, malformed JSON, an over-long request id, and an unknown route.

### Out of scope

- Rate limiting. A separate mechanism with its own failure modes, and it belongs to the gateway under A-001.
- Security response headers. Assessed and deliberately not set for a JSON API behind a gateway; recorded in `docs/operations.md`.
- Changing how `X-Account-Id` is trusted, which A-001 settles.

## Contract impact

### API

New reasons for the transport cases, additive under the Spec-017 policy — a client must already tolerate reasons it does not know. Two responses that were `500` become `4xx`, which is a change in observable behaviour and the point of the spec.

A 404 for an unknown route gains the standard envelope. Its `code` needs choosing: reusing `POST_NOT_FOUND` would be wrong, so this is either a new code or a reason under a generic one.

If the request identifier stops being caller-supplied, a client that today correlates by sending its own value loses that. No documented client does, because the behaviour was never documented.

### Application

`bodyLimit` and the request-id policy are composition-level settings in `createApplication`.

## Acceptance criteria

1. A request body over the limit answers `413` with the documented envelope, logged at warn.
2. Malformed JSON answers `400` with the documented envelope, logged at warn.
3. Neither produces a stack trace in the log, and neither is logged at error.
4. An unknown route answers in the documented envelope.
5. A request identifier longer than the bound, or containing characters outside the accepted set, does not reach a log record or a response body verbatim.
6. Every response still carries a `requestId` that correlates with the log.
7. The rule "a rejected client request is logged at warn, never error" is true of every path a client can trigger, asserted rather than stated.

## Verification plan

- A test injecting a body over the limit, asserting the status, the envelope, and the log level.
- A test injecting malformed JSON, asserting the same.
- A test asserting no record at level error is emitted for either.
- A test supplying a 229-character `X-Request-Id` and asserting what reaches the response and the log.
- A test hitting an unknown route and asserting the envelope.
- Mutation: deleting the `statusCode` branch must turn a test red.

## Open decisions

1. **Generate the request id, or validate it.** Proposed: generate server-side and stop honouring the header. It removes the class of problem rather than bounding it, at the cost of cross-system correlation the gateway can do better anyway. Validating keeps that ability and leaves a smaller version of the same trust question.
2. **The body limit.** Proposed: 64 KB. Comfortably above the 10,000-character reply body with its JSON overhead, far below 1 MB.
3. **What code an unknown route returns.** Proposed: a new `ROUTE_NOT_FOUND`, because reusing a resource-level code would tell a client the post or comment was not found when the path was wrong.
4. **Whether the transport cases get their own reasons or share `request_validation_failed`.** Proposed: their own — `request_body_too_large` and `request_body_malformed` — since the client action differs from a schema violation.

## Human decision required

Approval requires accepting:

1. That two failure modes change status code, from `500` to a `4xx`, which is a breaking change for any client branching on `500` — permitted only because the `500` was itself a defect.
2. The request-identifier decision in open decision 1, which may remove a correlation ability no client is documented as using.
3. A new error code for unknown routes, and an explicit body limit that will reject a request the service currently accepts.
