---
adr: 0009
title: Add production concerns after core behavior is verified
status: accepted
---

# ADR-0009: Add production concerns after core behavior is verified

## Context

Provider calls and comment writes have operational risks including timeouts, rate limits, retries, duplicate requests, sensitive data, and partial failures. Adding operational machinery before the domain and contracts are stable would obscure the core design.

## Decision

Address structured logging, request correlation, metrics boundaries, provider timeouts, retry policy, rate-limit handling, security, retention, dependency hygiene, and delivery checks in a dedicated final milestone after core behavior and tests are established.

Each concern must be introduced through an explicit policy and, when architectural, an ADR or approved spec. Retries must be idempotency-aware and must not duplicate replies.

Deploy the service as a stateless containerized modular monolith on a managed container runtime. Run multiple API replicas behind the runtime’s managed ingress/load balancing when availability or traffic requires it. Use a managed PostgreSQL-compatible database for persistence, a managed secret store for provider credentials, and managed logging/metrics/error reporting where available.

The initial production topology is:

```text
Clients
  ↓
Managed ingress / load balancer
  ↓
Stateless comments API container replicas
  ├── Provider APIs
  └── Managed PostgreSQL
       └── backups / recovery policy
```

The managed runtime orchestrates container placement, health checks, restarts, rolling deployments, and replica scaling. The application orchestrates provider timeouts, retries, idempotency, and error translation. Database migrations run as a separately controlled release step with one migration runner, not once per API replica.

Do not introduce Kubernetes, Kafka, a workflow engine, or a permanently separate worker service initially. The API handles the two synchronous assignment operations. A worker or queue may be added only when webhook ingestion, long-running reconciliation, or provider retry volume creates a demonstrated need. The specific cloud/vendor choice remains a delivery decision and must preserve this topology.

## Consequences

Production behavior is deliberately staged and reviewable. The early skeleton is not production-ready by implication; the final milestone must close operational gaps before deployment. The vendor-neutral topology keeps deployment simple while leaving room to add workers or split services when operational evidence justifies it.

## Alternatives considered

Adding a full observability or distributed workflow platform at initialization was rejected as unnecessary complexity. Kubernetes, Kafka, and a dedicated orchestration service are deferred because the initial API is small and stateless. Ignoring operational behavior was rejected because provider integrations are failure-prone.
