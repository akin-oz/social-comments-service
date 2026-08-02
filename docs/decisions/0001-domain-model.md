---
adr: 0001
title: Define a platform-neutral comment domain model
status: accepted
---

# ADR-0001: Define a platform-neutral comment domain model

## Context

The service must retrieve comments and publish replies across multiple social platforms. Each provider exposes different identifiers, author fields, timestamps, pagination models, capabilities, and failure modes.

If provider payloads become the application model, API behavior and business rules will become coupled to the first integration. If the model attempts to represent every provider-specific feature, it will become broad, ambiguous, and difficult to maintain.

The service therefore needs a small, stable domain contract that supports the assignment while preserving enough provider identity and metadata for synchronization and troubleshooting.

## Decision

Adopt a platform-neutral comment domain model owned by `src/comments/` and `src/shared/`.

The initial `Comment` contract contains:

- a stable internal comment identifier;
- the internal published post identifier;
- the normalized platform identifier;
- provider author identity and display information;
- comment body text;
- an optional `parentCommentId` for one-level replies;
- normalized publication and update timestamps.

Provider-specific identifiers, payloads, pagination tokens, SDK types, rate limits, and error details remain inside platform adapters under `src/platforms/`. Adapters translate provider responses into the domain contract and translate domain commands back into provider requests.

The common application contract will expose only capabilities shared by supported providers. A provider that cannot perform an operation must return an explicit unsupported-capability error; the service will not silently emulate unsupported behavior.

The initial domain model will not include arbitrary provider payload JSON, nested conversation trees, moderation state, reactions, attachments, or platform-specific author profiles. Those additions require a new ADR or an approved implementation spec supported by a concrete requirement.

## Consequences

### Positive

- API and application code remain independent of provider SDKs.
- Adding a provider primarily requires a new adapter and mapping tests.
- Provider differences are explicit at the integration boundary.
- The persistence model can store normalized comments without defining a separate model per platform.
- The model remains small enough to review and evolve deliberately.

### Negative

- Some provider-specific data will not be available through the common API initially.
- Mapping information can be lost unless provider identifiers and required metadata are explicitly preserved.
- Provider capabilities must be documented and tested rather than inferred from the common interface.
- Future requirements may require versioning or extending the domain contract.

## Alternatives considered

### Use provider payloads directly

Rejected because it couples the application and public API to external schemas and makes future providers expensive to add.

### Create a universal superset of all provider fields

Rejected because it produces nullable, provider-shaped contracts and encourages callers to depend on fields that are not consistently supported.

### Create one domain model per platform

Rejected for the initial service because it would leak platform selection into use cases and multiply API/persistence mapping logic without a demonstrated need.

## Implementation implications

This ADR authorizes the following direction once approved:

- keep `Comment`, pagination, platform, and command types provider-neutral;
- keep provider SDK types within `src/platforms/`;
- model provider selection through a registry or equivalent application boundary;
- add contract tests for provider-to-domain mapping;
- document capability differences before adding each provider;
- update `docs/database.md` if persistence requires fields beyond this model.

This ADR does not authorize database implementation, provider integration, REST route implementation, authentication changes, or business logic. Those changes require their own approved specs where applicable.
