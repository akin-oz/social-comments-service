---
spec: 016
title: Give the provider port somewhere to carry a credential
status: proposed
approved: no
owner: platform-integration
depends_on:
  - Spec-002
---

# Spec-016: Give the provider port somewhere to carry a credential

## Problem / gap

The provider abstraction cannot express the one thing every real adapter needs: which authorised connection to act as.

A single adapter instance is registered per platform and shared across every tenant. `ProviderListCommentsQuery` and `ProviderReplyCommand` carry the post, and `PublishedPost` carries the internal and external post identifiers but no social account. The repository does not select `social_account_id`, though the column exists and `social_accounts.credential_reference` is exactly the pointer an adapter would need.

Assumption A-002 says the service receives an authorised provider context rather than implementing OAuth. Today there is nowhere for that context to arrive. The abstraction that the README presents as the design's central claim — that adding a platform means writing an adapter and nothing else — is not yet true, because the first real adapter has to thread a credential through four layers before it can make a single call.

This is cheap now and expensive later: a field on two interfaces today, a change to a widely depended-on domain type once adapters exist.

## Context and assumptions

- A-002: OAuth flows, token storage, refresh, and revocation belong to existing platform infrastructure. This service receives a reference, never a secret.
- The schema already models the connection: `social_accounts` holds the platform, the external account identifier, and `credential_reference`.
- ADR-0011 forbids credentials in logs, and the schema comment already states that tokens are referenced rather than stored.
- No live adapter exists, so nothing depends on the current shape.

## Scope

### In scope

1. **Carry the connection into the provider port.** The query and command types gain the authorised connection: the social account and its credential reference, alongside the post they already carry.
2. **Select the social account in the post repository** so the service can supply it, and expose it on the domain type that represents a published post.
3. **Keep the secret out.** The port receives a reference an adapter resolves through infrastructure it owns, never a token value, so nothing secret enters the domain, a log, or an error.
4. **Prove the boundary with the fixture adapter**, which asserts it received a connection rather than ignoring it.
5. Record in the capability matrix's onboarding steps that an adapter resolves its credential from the reference it is given.

### Out of scope

- Token acquisition, refresh, revocation, and storage, all owned upstream by A-002.
- Per-tenant adapter instances. One instance per platform stays; the connection travels with the call, which is what makes that safe.
- Any change to the API contract. This is entirely below the application boundary.

## Contract impact

### Provider port

`ProviderListCommentsQuery` and `ProviderReplyCommand` gain the connection. Every adapter sees it; the fixture ignores everything but its presence.

### Domain and persistence

`PublishedPost` gains the social account it was published through, which the repository already joins to and currently discards. No migration: the columns exist.

### Security

A credential reference is not a secret, but it names one. It must not appear in an API response, and the log redaction rules extend to cover it.

## Acceptance criteria

1. Both provider operations receive the authorised connection for the post they act on.
2. The connection carries a credential reference, never a credential.
3. `PublishedPost` exposes the social account, and the PostgreSQL repository selects it.
4. Neither the credential reference nor the social account reaches an API response.
5. No log record contains a credential reference.
6. The fixture adapter asserts it was given a connection, so an adapter cannot silently be wired without one.
7. Two tenants connected to the same platform reach the provider with different connections.

## Verification plan

- A service test asserting the connection reaching the provider matches the post's social account.
- A test with two tenants on one platform, asserting each call carries its own connection.
- A serialization test asserting neither the reference nor the social account appears in a response.
- A log test asserting no record contains the reference.
- An integration test against PostgreSQL confirming the repository returns the joined social account.

## Open decisions

1. **What shape the connection takes.** Proposed: a small value carrying the social account identifier, the platform, and the credential reference. The alternative is passing the whole social-account row, which drags persistence detail into the provider port.
2. **Whether the connection travels on the query types or as a separate argument.** Proposed: on the query and command types, so an adapter method keeps one parameter and the connection cannot be forgotten at a call site.
3. **Whether `PublishedPost` should carry it at all**, or whether the service should fetch the connection separately. Proposed: carry it, because the repository already joins the row and a second query would be pure waste.
4. **Whether the fixture should simulate an invalid credential** so the unauthorised path has a test. Proposed: yes, but the error taxonomy for it belongs with the API error work.

## Human decision required

Approval requires accepting:

1. A change to `PublishedPost`, a domain type several layers depend on — cheap now, disruptive once adapters exist.
2. That the provider port carries a credential reference, on the understanding that a reference is not a secret and the resolution stays inside the adapter.
3. That one adapter instance per platform remains, with the connection supplied per call rather than per instance.
