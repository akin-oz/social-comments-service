---
adr: 0004
title: Isolate social platforms behind provider adapters
status: accepted
---

# ADR-0004: Isolate social platforms behind provider adapters

## Context

Social platforms expose different APIs, identifiers, capabilities, pagination, rate limits, and error models. The service must support additional platforms without making application use cases provider-aware.

## Decision

Use an adaptive platform layer at the integration boundary. The application depends on a platform-neutral provider interface and resolves implementations through a platform provider registry. Each adapter under `src/platforms/` adapts one provider’s API, identifiers, pagination, timestamps, capabilities, and failures into the service’s domain contracts.

The dependency direction is:

```text
Application use cases
        ↓
Platform-neutral provider interface
        ↓
Adaptive platform layer
        ├── Instagram adapter
        ├── LinkedIn adapter
        └── Other provider adapters
                ↓
        Provider SDK/API
```

Application services and routes must not branch on platform names or import provider SDKs. Provider-specific behavior belongs in the adaptive layer. Unsupported provider capabilities must become explicit typed errors rather than being silently emulated.

Provider-specific features require a documented capability decision before being added to shared contracts.

## Consequences

New integrations are localized to adapters, configuration, mapping tests, and capability documentation. The common interface must remain deliberately small to avoid becoming a provider-shaped superset. The adaptive layer adds translation code, but makes provider churn and API differences explicit at one boundary.

## Alternatives considered

Calling provider SDKs directly from route handlers was rejected because it couples transport to integrations. Separate domain models per provider were rejected for the initial scope because they multiply mapping and use-case complexity.
