---
spec: 005
title: Complete layered test coverage
status: approved
approved: yes
owner: tests
depends_on:
  - ADR-0007
  - Spec-002
  - Spec-003
  - Spec-004
---

# Spec 005: Complete layered test coverage

## Problem / gap

Initial domain tests exist, but provider, repository, and API boundaries need coverage before the service can be considered safe to change.

## Scope

- Add domain unit tests for invariants and error contracts.
- Add provider adapter contract tests with deterministic fixtures.
- Add repository integration tests for constraints and transactions.
- Add API integration tests for route and error mapping.
- Add explicit failure-path coverage for rate limits, unsupported capabilities, provider outages, and duplicate writes.
- Keep test fixtures free of real credentials and live provider dependencies.

## Out of scope

Production load testing, end-to-end tests against live social platforms, performance tuning, and test-driven implementation of undocumented behavior.

## Acceptance criteria

- [ ] ADR-0007 and dependency specs are accepted.
- [ ] Every critical use case has success and failure coverage at its owning layer.
- [ ] Contract tests fail when provider mappings drift.
- [ ] CI runs the complete suite without external credentials.
- [ ] Test names explain the behavioral contract being protected.

## Verification

Run the full Vitest suite in CI and locally, inspect coverage for critical paths, and run the architecture/contract reviews.
