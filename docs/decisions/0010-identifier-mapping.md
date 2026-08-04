---
adr: 0010
title: Use internal UUIDs with explicit external-ID mapping at adapter boundaries
status: accepted
---

# ADR-0010: Use internal UUIDs with explicit external-ID mapping at adapter boundaries

## Context

The system needs stable identifiers across three layers:

- **Domain contracts**: Platform-neutral comment and post IDs used in API responses and business logic.
- **Provider layer**: Each provider uses opaque external identifiers (e.g., Instagram comment ID `17999999999999999`, Facebook post ID `123456_987654321`).
- **Persistence**: Comments and posts must be uniquely keyed by both internal and external IDs for deduplication and provider reconciliation.

The current implementation is inconsistent:

1. The adaptive provider builds domain IDs as `platform:externalId` (e.g., `instagram:17999999999999999`) ([adaptive-provider.ts:85](../../src/platforms/adaptive-provider.ts:85)).
2. The database schema declares `comments.id uuid` ([001_initial_schema.sql:29](../../migrations/001_initial_schema.sql:29)), expecting UUID values.
3. The `replyToComment` handler passes the domain ID directly to the provider as if it were an external ID ([adaptive-provider.ts:71](../../src/platforms/adaptive-provider.ts:71)).
4. There is no comment-ID resolver equivalent to the existing `postIdResolver`.

This will cause INSERT failures at runtime and prevent reply-to-comment from working against any real provider.

## Decision

1. **Domain layer** uses UUIDs for all comment and post identities (`comment_abc123...`, `post_def456...`).
2. **Persistence layer** stores both the internal UUID and the external provider ID in separate columns:
   - `comments.id` (UUID, internal identity).
   - `comments.external_comment_id` (text, provider-specific ID for deduplication).
   - `posts.id` (UUID, internal identity).
   - `posts.external_post_id` (text, provider-specific ID).
3. **Adapter layer** owns the translation:
   - **Inbound** (provider → domain): Map `externalId` to a stable internal UUID (deterministic function: `uuid5(namespace, platformId:externalId)` or a lookup from persistence).
   - **Outbound** (domain → provider): Map domain ID back to external ID by resolving through the repository.
4. **Repository interface** provides:
   - `resolveCommentExternalId(context, commentId): Promise<string>` to translate internal ID → provider ID.
   - `findByExternalId(context, platform, externalId): Promise<Comment | null>` for deduplication during upsert.

## Rationale

- **Stability**: Internal UUIDs are stable across provider account reauthorization or API changes; external IDs may change or be deprecated.
- **Multi-tenant isolation**: UUIDs are globally unique and do not leak provider-specific structure.
- **Deduplication**: The `(social_account_id, external_comment_id)` unique constraint in the database prevents storing the same provider comment twice; the adapter uses external ID to check before upsert.
- **Pagination safety**: Cursors encode internal IDs, not external IDs, so pagination is stable if the provider's ID scheme changes.
- **Minimal adapter coupling**: The adapter does not need to know how internal IDs are generated; it only translates between external IDs and domain contracts.

## Consequences

1. Every adapter must implement the ID translation. The adaptive provider becomes:
   ```typescript
   async replyToComment(command: ReplyToCommentCommand): Promise<Comment> {
     const externalCommentId = await this.resolveCommentExternalId(command.commentId);
     const item = await this.client.replyToComment({
       externalCommentId,
       body: command.body,
     });
     return this.toDomain(item, ...);
   }
   ```
2. The comment service passes a repository method to the provider to enable translation. (Acceptable because the provider is already aware of repository semantics through the upsert contract.)
3. All provider tests must verify that external IDs are correctly resolved and that comments with the same external ID are deduplicated.

## Alternatives considered

1. **Use `platform:externalId` as the domain ID** — simpler short-term, but leaks provider structure into domain contracts and makes it impossible to change a provider's ID scheme without rewriting all comments.
2. **Generate UUIDs on the fly without storage** — prevents deduplication and makes concurrent provider updates risk duplicates.
3. **Store external IDs in comments.id directly** — violates the schema constraint and makes internal ID lookups O(n).

## Implementation notes

- Update `CommentRepository` and `PostRepository` interfaces to add resolution methods.
- Update in-memory implementations to store both IDs.
- Update Postgres schema if needed (already has the columns; just enforce the mapping).
- Update the adapter to accept a resolver function.
- Add tests for ID resolution and deduplication across multiple calls with the same external comment.

## Implementation outcome

Two details settled differently from the sketch above, and this record is the authority:

1. **No `findByExternalId` method.** Because the internal identity is derived deterministically from `(platform, externalId)`, the external identifier already maps to the primary key, and Postgres resolves duplicates through the existing `(social_account_id, external_comment_id)` constraint. A separate lookup would have had no caller, so `CommentRepository` exposes only `resolveExternalId`.
2. **The adapter takes no resolver function.** `ProviderListCommentsQuery` and `ProviderReplyCommand` carry the whole `PublishedPost`, which already holds both the internal and external post identifiers, and the service resolves the parent comment's external identifier before calling the provider. The adapter therefore stays a pure translation layer with no repository dependency, which is a stronger form of the boundary this ADR set out to establish.

Derivation assumes provider comment identifiers are unique within a platform. Every currently modelled provider satisfies this; a provider that does not would need its social account folded into the derivation, which changes existing identifiers and so requires a new ADR.
