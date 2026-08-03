---
adr: 0006
title: Expose versioned REST use cases through Fastify
status: accepted
---

# ADR-0006: Expose versioned REST use cases through Fastify

## Context

The assignment requires a REST API for retrieving comments and replying to a comment. HTTP concerns such as validation, serialization, authentication context, and error mapping should not leak into the domain or provider layers.

## Decision

Expose the documented operations under `/v2` using Fastify. Routes validate transport input, invoke application use cases, serialize normalized responses, attach request correlation, and map typed failures to stable error envelopes.

Use opaque cursor pagination and require an idempotency key for reply creation. The API exposes internal post/comment identifiers, not provider-specific lookup parameters.

## Consequences

The API can evolve through explicit versioning while preserving a small transport boundary. Fastify schemas and integration tests become part of the contract. Authentication and authorization remain integration points owned by surrounding platform infrastructure.

## Alternatives considered

An unversioned API was rejected because provider and normalized contracts will evolve. Exposing provider APIs directly was rejected because it leaks external schemas and capabilities.
