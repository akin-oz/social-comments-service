---
spec: 007
title: Harden the service for production-oriented review
status: approved
approved: yes
owner: platform and operations
depends_on:
  - ADR-0009
  - Spec-004
  - Spec-005
  - Spec-006
paths:
  - package.json
  - tsconfig.json
  - tsconfig.build.json
  - eslint.config.js
  - eslint.config.mjs
  - .github/**
  - Dockerfile
  - fly.toml
---

# Spec 007: Harden the service for production-oriented review

## Problem / gap

Core behavior may be correct while provider outages, rate limits, duplicate retries, sensitive data, and missing operational signals remain unsafe for production.

## Scope

- Add structured logging and request correlation at service boundaries.
- Define provider timeout, retry, backoff, and rate-limit policies.
- Ensure retries are idempotency-aware and cannot duplicate replies.
- Add metrics boundaries for request, provider, repository, and failure outcomes.
- Perform security, credential-boundary, data-retention, and dependency reviews.
- Tighten CI and delivery checks, including frozen lockfile installation.
- Package the service as an immutable container image and deploy it to a managed container runtime.
- Deploy persistence on managed PostgreSQL-compatible infrastructure with backups and recovery procedures.
- Configure managed ingress, health checks, rolling deployment, secrets, logs, metrics, and error reporting.
- Define one controlled migration runner per release.
- Document why no Kubernetes, Kafka, workflow engine, or separate worker is required initially.

## Out of scope

Microservices, Kubernetes, Kafka, event sourcing, a workflow engine, a permanently separate worker, vendor-specific selection, or operational features without a demonstrated service requirement.

## Acceptance criteria

- [ ] ADR-0009 and all dependency specs are accepted.
- [ ] Timeouts and retry behavior are explicit for every provider operation.
- [ ] Logs and metrics exclude credentials and unnecessary comment content.
- [ ] Duplicate reply and partial-failure behavior is tested.
- [ ] Security and retention decisions are documented.
- [ ] The deployment topology identifies what runs in the API container, managed database, secret store, ingress, and observability services.
- [ ] Container health checks, restart behavior, rolling deployment, scaling limits, and migration execution are documented.
- [ ] Provider retries and idempotency remain application responsibilities; infrastructure orchestration does not duplicate reply operations.
- [ ] The service can run with multiple API replicas without relying on local mutable state.
- [ ] The reason for deferring Kubernetes, queues, and workers is recorded and revisited only from operational evidence.
- [ ] CI reproduces the local quality gate from a clean checkout.
- [ ] Operational runbook covers provider outage, rate limiting, and recovery.

## Verification

Run the complete test suite plus targeted failure simulations, dependency/security checks, CI from a clean checkout, and final architecture/contract reviews.
