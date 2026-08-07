---
spec: 011
title: Publish an OpenAPI document and interactive API documentation
status: accepted
approved: yes
owner: api
paths:
  - src/openapi.ts
  - src/api/**
  - docs/openapi.json
---

# Spec-011: Publish an OpenAPI document and interactive API documentation

## Problem / gap

`docs/api-design.md` is the source of truth for the REST contract and is written by hand. Nothing mechanically ties it to the routes, so the two drift silently. They already have: the default and maximum `limit`, header-only authentication, the `INTERNAL_ERROR` code, and the cursor semantics were all wrong in the document until a review pass corrected them under Milestone 10. Each was a documentation change made after the code changed, caught by reading rather than by tooling.

There is also no machine-readable contract. A consumer cannot generate a client, and a reviewer cannot exercise the API without hand-writing curl commands.

The route schemas are the natural source for both, but they are incomplete: `params`, `querystring`, `body`, and `headers` are declared, while **no route declares a `response` schema**. A document generated today would describe every response as untyped.

## Context and assumptions

- Fastify 5.11 is already a dependency, and its route schemas are JSON Schema.
- `docs/api-design.md` governs the REST contract per the source-of-truth rules; this spec must say what happens to that authority.
- ADR-0011 established that responses are serialized explicitly so provider identifiers cannot leak. Response schemas reinforce that boundary rather than replace it.
- The repository already uses a generate-and-diff pattern in CI for the `.ai/` workspace, so the same shape is available for a generated contract.
- Assumption A-001: the service sits behind a gateway that has already authenticated the caller.

## Scope

### In scope

1. **Add response schemas to every route**, covering the success envelope and the error envelope, including the documented status codes for each operation.
2. **Generate an OpenAPI 3.1 document from the route schemas** using `@fastify/swagger`, so the document is derived from the code rather than maintained beside it.
3. **Serve interactive documentation** with `@fastify/swagger-ui`.
4. **Commit the generated document** as `docs/openapi.json` and add a CI step that regenerates it and fails on any difference, mirroring `pnpm ai:validate`.
5. **Describe the security scheme** so the `X-Account-Id` requirement and the `Idempotency-Key` header appear in the document.
6. **Add a script** (`pnpm openapi`) that writes the document without starting a server.

### Out of scope

- Changing any existing route path, status code, or payload. This spec documents the contract that exists; it does not alter it.
- Generating client SDKs.
- Authenticating or authorising the documentation endpoints beyond the exposure rule below.
- Replacing `docs/api-design.md` with generated output.

## Contract impact

### New endpoints

| Path             | Purpose                      |
| ---------------- | ---------------------------- |
| `/documentation` | Swagger UI                   |
| `/openapi.json`  | The OpenAPI document as JSON |

Both are additions to the public surface and must be recorded in `docs/api-design.md`. Neither is versioned under `/v2`, because they describe the API rather than belong to it.

**Exposure.** Documentation endpoints are served only when `ENABLE_API_DOCS` is set, defaulting to enabled outside production and disabled in production. A service behind an internal gateway has no reason to publish its own schema to the internet, and the endpoints bypass the account-context hook.

### Behaviour change from response schemas

Fastify uses a `response` schema to serialize, discarding properties the schema does not declare. This is a real behaviour change and the main risk in this spec: a field present in a handler's return value but missing from its schema disappears from the response. It also strengthens the ADR-0011 leak boundary, since a provider identifier would have to be declared to escape.

### Source-of-truth relationship

`docs/api-design.md` remains authoritative for the contract's intent, rationale, and error semantics. `docs/openapi.json` is the machine-readable projection of what the routes actually implement. Where they disagree, that is a defect in one of them, and the CI diff makes the disagreement visible rather than silent.

### Dependencies

`@fastify/swagger` and `@fastify/swagger-ui`, both maintained by the Fastify organisation and both required to be Fastify 5 compatible. This is the first runtime dependency added since Fastify itself, which is why it needs approval rather than a judgement call.

## Acceptance criteria

1. Every route declares response schemas for its success status and for each error status listed in `docs/api-design.md`.
2. `GET /openapi.json` returns a valid OpenAPI 3.1 document describing both operations, their parameters, the `X-Account-Id` and `Idempotency-Key` headers, and the error envelope.
3. `GET /documentation` serves Swagger UI, and a request issued from it against the running demo composition succeeds.
4. `pnpm openapi` writes `docs/openapi.json` without starting a server, and CI fails when the committed document differs from the generated one.
5. Documentation endpoints are absent when `ENABLE_API_DOCS` is disabled.
6. Existing API tests pass unchanged, demonstrating that no response payload was altered by the introduction of response schemas.
7. A test asserts that a comment serialized through the schema still omits provider identifiers.

## Verification plan

- Unit and integration tests for the response schemas, including one that would fail if a schema omitted a field the handler returns.
- An API test asserting the document is served and contains both paths and the security scheme.
- An API test asserting the documentation endpoints are absent when disabled.
- Manual check: `pnpm dev`, open `/documentation`, execute both operations from the UI.
- CI: `pnpm openapi` followed by `git diff --exit-code docs/openapi.json`.

## Open decisions

1. **Document location.** `docs/openapi.json` sits with the other contract documents, but a root-level `openapi.json` is more conventional for tooling that auto-discovers it. Proposed: `docs/openapi.json`, since `docs/` already holds the contract.
2. **Default exposure in production.** Proposed: disabled, with `ENABLE_API_DOCS` to opt in. The alternative is always-on, which is friendlier for an internal service and one fewer configuration switch.
3. **OpenAPI version.** Proposed: 3.1, which matches the JSON Schema dialect Fastify uses. Some older tooling still expects 3.0.
4. **Whether `pnpm openapi` should also run in the pre-existing quality gate** rather than only in CI, so a drifted document fails locally before it is pushed.

## Human decision required

Approval requires accepting three things:

1. Two new runtime dependencies, `@fastify/swagger` and `@fastify/swagger-ui`, which is the first dependency addition since Fastify.
2. Two new unversioned public endpoints, and the exposure rule that keeps them out of production by default.
3. That response schemas begin governing serialization, with the understood risk that an undeclared field is silently dropped from a response.
