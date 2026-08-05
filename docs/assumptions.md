# Assumptions

These assumptions bound the first implementation. If any assumption changes, update this document and record a decision when the impact is material.

## A-001: Authentication exists upstream

The surrounding platform authenticates callers and supplies an internal account or tenant context. This service does not design login, sessions, or user identity management.

## A-002: OAuth and provider credentials already exist

Social-platform OAuth flows, token storage, refresh, and revocation are owned by existing platform infrastructure. The comment service receives an authorized provider context rather than implementing OAuth.

## A-003: External platforms are the source of truth

Provider APIs are authoritative for newly retrieved comments and published replies. Local persistence is a normalized cache and operational record, not an independent social graph.

## A-004: Published posts are addressable internally

The scheduling platform can resolve an internal `postId` to its platform and external post identifier. The public API does not require clients to know provider-specific post IDs.

## A-005: This service exposes one level of replies

One level is a normalization this service chose, not a fact about the platforms. Instagram and YouTube enforce a single level themselves; LinkedIn implies two; Facebook states no limit; on X a reply is a Post and threads nest arbitrarily deep. Beneath the normalization those differences remain, and a conversation deeper than one level is flattened rather than represented.

The invariant is enforced at the application boundary rather than assumed: replying to a comment that is itself a reply is refused with `REPLY_DEPTH_EXCEEDED`. Expanding the contract to nested threads is a product decision requiring a new ADR. See [ADR-0014](decisions/0014-reply-depth.md).

## A-006: Webhook synchronization is out of scope

The initial assignment covers on-demand retrieval and reply creation. Webhook ingestion, background synchronization, retries, and reconciliation are future work.

## A-007: Provider capabilities differ

Not every platform supports identical comment fields, reply semantics, page sizes, or moderation behavior. Unsupported operations are explicit API errors rather than silently emulated.

## A-008: Cursor pagination is preferred

The service uses opaque cursors so it can preserve provider pagination semantics and avoid unstable offset paging over changing external data.

## A-009: Idempotency is required for writes

Clients provide an idempotency key for reply creation. The persistence layer claims that key on insert, so concurrent requests cannot both reach the provider and a retry returns the reply already published.

## A-010: One service boundary is sufficient initially

The first implementation is a modular monolith. Deployment separation is not justified by the assignment and would add operational complexity without improving the core design.

## A-011: Tenant isolation is mandatory

The existing account context represents a tenant boundary. A caller authenticated for one account must not read, mutate, or infer comments, posts, social accounts, or reply operations belonging to another account. The repository layer must enforce tenant scoping, with database-level row security considered as defense in depth when supported by the selected database.
