---
spec: 035
title: Reject unknown fields on the reply body instead of dropping them
status: accepted
approved: yes
owner: api contract
depends_on:
  - Spec-011
  - Spec-022
paths:
  - src/api/routes.ts
  - src/api/schemas.ts
  - src/index.ts
---

# Spec-035: Reject unknown fields on the reply body instead of dropping them

## Problem / gap

`additionalProperties: false` reads as "reject unknown members" and behaves as "silently drop them."

`createApplication` in `src/index.ts` constructs `Fastify({...})` with no `ajv` option, so Fastify's default AJV configuration applies. That default sets `removeAdditional: true`. Combined with `additionalProperties: false` on the two request schemas that declare it — the reply body (`src/api/routes.ts:167`) and the `listComments` querystring (`src/api/routes.ts:103`) — AJV removes the unknown member and passes validation rather than failing it. There is no explicit `removeAdditional` anywhere in `src/`; the behaviour is the framework default, so a reader of the schema alone cannot see it.

Verified live: `POST /v2/comments/{id}/replies` with `{"body":"ok","isAdmin":true}` returns `201` with `isAdmin` discarded, and `GET …/comments?limit=25&order=desc` returns `200` with `order` discarded.

This is not a leak — the extra never reaches the domain, and the response projection in `serializeComment` is an explicit allowlist, so nothing internal escapes either way. It is a correctness-of-intent gap on the **write** path. A client that sends `{"body":"ok","parentCommentId":"…"}` or `{"body":"ok","authorId":"…"}` believes it set a field the service accepted; the service accepted the request and ignored the field. The mistake most worth surfacing — a typo'd or security-adjacent key on a command — is the one the service currently swallows. `docs/tasks.md` (line 221) records this as an open item and says explicitly that changing it is an API contract change and needs a spec.

## Context and assumptions

- A-001: an internal gateway authenticates the caller and supplies context, so this is about contract honesty, not an untrusted-input defence.
- Spec-011 established that `docs/openapi.json` is generated from these route schemas and that CI fails on any diff, so a schema change must be regenerated and committed.
- Spec-022 settled the shape a client mistake takes at this edge: a schema violation is `400 INVALID_REQUEST` with reason `request_validation_failed`, logged at warn via `logRejection`, through the `error.validation` branch of the route error handler (`src/api/routes.ts:237`). A rejected unknown field would travel that exact path — the NUL-body and over-long-key tests already assert that envelope (`tests/api/routes.test.ts:485`, `:527`). No new `code` or `reason` is required.
- Spec-017 and `docs/api-design.md` ("Compatibility within /v2") carry the tension this spec must resolve. Two clauses of that policy pull in opposite directions:
  - It obliges a **client** to tolerate unknown fields the **service** adds to a **response**. Rejecting unknown **request** fields does not touch that clause.
  - It permits the **service** to add "an optional request parameter or header" within `/v2`. That permission only holds if an older deployment tolerates a newer client's added parameter — so an older deployment must **not** reject unknown query parameters or headers, or the additive rollout breaks against it. The list does not name body fields.

The resolution follows from that asymmetry: the reply body is a closed command with one documented field and no additive-growth promise, so it can be closed to unknowns; query parameters and headers are exactly where the policy reserves additive growth, so they must stay tolerant.

## Scope

### In scope

1. **Make the reply body reject unknown members.** A `POST /v2/comments/{commentId}/replies` whose JSON body carries a property not named in the body schema is answered `400 INVALID_REQUEST` / `request_validation_failed`, logged at warn — the existing schema-violation path — instead of `201` with the field dropped.
2. **Keep query parameters and headers tolerant.** An unrecognised query parameter or request header does not reject the request; it is ignored, preserving the `/v2` permission to add optional parameters without a new version.
3. **Preserve `coerceTypes` and `useDefaults`.** `limit` arrives as a string and depends on `coerceTypes` to become an integer; `default: 25` depends on `useDefaults`. Whatever mechanism turns off member-stripping for the body must not disturb either.
4. **Record the decision in the contract.** `docs/api-design.md` "Compatibility within /v2" must state that the reply body is closed to unknown fields, distinct from the still-permitted addition of optional request parameters and headers — see the paths caveat in Open decisions.

### Out of scope

- Rejecting unknown **query parameters or headers**. Doing so would contradict the written `/v2` permission to add optional request parameters, and break a newer client against an older deployment. Closing those would be a policy reversal requiring an ADR, or a `/v3` change.
- Any new error `code` or `reason`. The rejection reuses `INVALID_REQUEST` / `request_validation_failed`; adding a bespoke reason would be a contract surface for no client gain.
- The response projection. `serializeComment` already emits an explicit allowlist; nothing about response shaping changes.
- The `listComments` route body (it has none) and the health and documentation endpoints (outside the account-scoped plugin).

## Contract impact

### API

One observable change: a reply request the service accepts today (`201`, extra field dropped) is refused tomorrow (`400`, `request_validation_failed`). Under the `/v2` policy this is permitted only because no clause promises that unknown **body** fields are accepted — the additive permission covers request **parameters and headers**, not the body. That reading is the load-bearing decision and must be written into `docs/api-design.md`, not left implicit, because it narrows what a future version may add to this body without a new version.

The reply body schema text (`additionalProperties: false`) does not change; only its enforcement does. An OpenAPI consumer therefore sees the same schema whether it strips or rejects, which is why the policy prose — not the schema — is where this decision has to live.

### Application

The mechanism is composition-level, in `createApplication`. Two options are weighed in Open decisions; both keep query and header tolerance intact and both stay within the claimed `src` paths.

### Documentation

`docs/openapi.json` must be regenerated so CI's golden compare passes (Spec-011). Whether it changes depends on the mechanism and on how `@fastify/swagger` renders a querystring `additionalProperties`; the golden compare is the authority. The compatibility-policy clarification lands in `docs/api-design.md`. Both files fall outside this spec's claimed `paths:` — see Open decisions.

## Acceptance criteria

1. A reply POST whose body carries a property absent from the body schema — e.g. `{"body":"ok","isAdmin":true}` — is answered `400` with `INVALID_REQUEST` / `request_validation_failed`, logged at warn, not `201`.
2. A reply POST with exactly the documented body — `{"body":"ok"}` — still returns `201`.
3. A list GET carrying an unknown query parameter — e.g. `?limit=25&order=desc` — still returns `200`; the request is neither rejected nor altered in behaviour by the unknown parameter.
4. An unrecognised request header does not reject the request.
5. `limit` still coerces from its string form and its default still applies: a request with `?limit=2` returns two-item pages and a request with no `limit` returns the default page size (`coerceTypes` and `useDefaults` remain enabled).
6. No new error `code` or `reason` is introduced.
7. `docs/openapi.json` regenerates cleanly and CI's golden compare passes.
8. `docs/api-design.md` "Compatibility within /v2" states that the reply body is closed to unknown fields, distinct from the permitted addition of optional request parameters and headers.

## Verification plan

- **New test — reject:** `POST …/replies` with `{"body":"ok","isAdmin":true}` asserts `400`, envelope `{ code: 'INVALID_REQUEST', reason: 'request_validation_failed' }`, and a warn-level `http.request.rejected` record, using the `captureLogs` harness already in `tests/api/routes.test.ts`.
- **New test — accept:** the same route with `{"body":"ok"}` asserts `201`, so a mutation that rejects every body is caught.
- **New test — query stays tolerant:** `GET …/comments?limit=2&order=desc` asserts `200` and a two-item page, so a mechanism that over-broadly rejects unknown query parameters turns red.
- **Regression guard — coercion and defaults:** the existing page-walk and default-limit assertions in `tests/api/routes.test.ts` must remain green, proving `coerceTypes` and `useDefaults` survived the change.
- **Named FAILING MUTATION:** restoring Fastify's default member-stripping — deleting the `ajv.customOptions.removeAdditional: false` setting from `createApplication` (or, under the route-scoped alternative, removing the strict body validator) — must turn the reject test red: the request returns `201` with `isAdmin` dropped instead of `400`. This mirrors Spec-022's rule that deleting the `statusCode` branch must turn a test red.

## Open decisions

1. **The mechanism.** Proposed: set `ajv: { customOptions: { removeAdditional: false } }` in `createApplication` (`src/index.ts`) — the idiomatic Fastify way to reject unknown properties — and relax the `listComments` querystring from `additionalProperties: false` to `true` in `src/api/routes.ts` so query parameters stay tolerant rather than flipping from strip to reject. This is the smaller change (one option, one schema value) but is global, so it must be proven that `customOptions` merges over Fastify's defaults rather than replacing them, keeping `coerceTypes` and `useDefaults` on (acceptance criterion 5). The alternative is a route-scoped strict validator for the `body` HTTP part only, leaving the querystring schema, its stripping, and the global AJV options untouched — a smaller blast radius at the cost of a second validator instance, which is more machinery than CLAUDE.md's "smallest design" prefers.
2. **The `/v2` policy amendment and its home.** Rejecting a request the service accepts today is a refinement of an accepted architectural decision (the compatibility policy), which under CLAUDE.md requires recording in `docs/decisions/`. This spec's `paths:` claims only the three `src` files, so `docs/api-design.md`, `docs/openapi.json`, and any ADR are not yet claimed. Either the maintainer expands `paths:` before approval to include those, or a companion ADR carries the policy change. This is a governance choice for the human, not something this spec resolves.
3. **Whether the body decision should instead be a `/v3` change.** Proposed: no. Because no `/v2` clause promises acceptance of unknown body fields, closing the body is consistent with the current policy once the policy says so explicitly; deferring to `/v3` would leave the misleading strip-accept in place for the write path indefinitely.

## Human decision required

Approval requires accepting:

1. That a reply request currently answered `201` (with an unknown body field dropped) becomes `400 INVALID_REQUEST` / `request_validation_failed` — a behavioural change permitted under `/v2` only if the maintainer agrees the additive-request-parameter permission does not extend to the reply body.
2. That query parameters and headers remain tolerant, so the change is not "reject everywhere."
3. The path/governance question in Open decision 2: whether to expand this spec's `paths:` to cover `docs/api-design.md`, `docs/openapi.json`, and an ADR, or to carry the compatibility-policy amendment in a companion ADR — since the decision to close the body revises an accepted architectural policy and cannot land in the `src` files alone.
