---
spec: 002
title: Implement the social platform provider abstraction
status: approved
approved: yes
owner: src/platforms
depends_on:
  - ADR-0001
  - ADR-0004
  - Spec-001
paths:
  - src/platforms/**
---

# Spec 002: Implement the social platform provider abstraction

## Problem / gap

The domain contracts exist, but no provider registry or adapter contract currently resolves platform-specific operations.

## Scope

- Finalize the provider registry contract under `src/platforms/`.
- Define the adaptive layer boundary between application use cases and provider SDK/API clients.
- Keep provider-specific request/response mapping, external IDs, timestamps, pagination, capabilities, rate-limit signals, and failures inside each adapter.
- Define provider capability and unsupported-operation error boundaries.
- Add one provider adapter only if the selected provider is explicitly named in a follow-up implementation decision.
- Add provider mapping and contract-test fixtures without making live network calls in unit tests.
- Document the capability matrix and provider-specific identifier mapping.

## Out of scope

OAuth, credential storage, webhook ingestion, background synchronization, retry policy, persistence implementation, and REST route implementation.

## Acceptance criteria

- [ ] ADR-0004, ADR-0002, ADR-0003, and the domain-model spec are accepted.
- [ ] Application code resolves providers through an interface or registry and does not branch on platform names.
- [ ] Provider SDK types do not leak into domain contracts.
- [ ] The adaptive layer translates provider identifiers, pagination, timestamps, capabilities, and failures into stable service contracts.
- [ ] Unsupported capabilities produce typed, documented failures.
- [ ] Mapping tests cover normalized comments, pagination, timestamps, and provider identifiers.
- [ ] The capability matrix documents known differences for every implemented provider.

## Verification

Run provider contract tests, typecheck, lint, the complete test suite, and the architecture/contract guardian reviews.
