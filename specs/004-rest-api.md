---
spec: 004
title: Implement the versioned comment REST API
status: approved
approved: yes
owner: src/api
depends_on:
  - ADR-0006
  - Spec-001
  - Spec-002
  - Spec-003
paths:
  - src/api/**
---

# Spec 004: Implement the versioned comment REST API

## Problem / gap

The API contract is documented, but Fastify routes, validation, serialization, and error mapping are not implemented.

## Scope

- Implement `GET /v2/posts/{postId}/comments`.
- Implement `POST /v2/comments/{commentId}/replies`.
- Add request and response schemas matching `docs/api-design.md`.
- Resolve authentication/account context through an existing integration point.
- Map domain, repository, and provider failures to the documented error envelope.
- Require and persist `Idempotency-Key` for reply requests.
- Add request IDs and structured route-level error context.

## Out of scope

Authentication implementation, OAuth, provider SDK calls outside the provider interface, new endpoints, arbitrary filtering, webhook ingestion, and frontend work.

## Acceptance criteria

- [ ] ADR-0006 and all dependency specs are accepted.
- [ ] Both routes match the documented paths, methods, request shapes, and response envelopes.
- [ ] Invalid input and unsupported capabilities return stable documented errors.
- [ ] Pagination passes opaque cursors through without client decoding requirements.
- [ ] Reply retries with the same idempotency key do not publish duplicates.
- [ ] API integration tests cover success, validation, authorization, not-found, provider, and pagination failures.

## Verification

Run Fastify API integration tests, provider/repository contract tests, typecheck, lint, formatting, and the complete suite.
