# Database design

The database is intentionally not implemented in the initialization milestone. The following normalized model gives the future repository layer a concrete target while leaving the storage technology open.

## Design goals

- Preserve stable internal identifiers while retaining provider identifiers.
- Make comments queryable by internal post and platform.
- Support deduplication when the same provider comment is observed repeatedly.
- Record reply attempts and idempotency keys for safe client retries.
- Keep credentials and access tokens outside this schema.

## Initial entities

### Account

Represents the existing platform tenant or account that owns connected social accounts.

### Social account

Represents one authorized connection to a provider. It stores provider identity and references credentials managed by existing infrastructure.

### Post

Represents a scheduled/published post in the host platform. It maps to a provider-specific post identifier.

### Comment

Stores a normalized snapshot of a provider comment, including its external identity, author information, parent relationship, and timestamps.

### Reply operation

Records a client-requested reply and its idempotency key. It supports auditability and safe retry handling without making the operation itself the source of truth for the external comment.

## Mermaid ERD

```mermaid
erDiagram
  ACCOUNT ||--o{ SOCIAL_ACCOUNT : owns
  ACCOUNT ||--o{ POST : owns
  SOCIAL_ACCOUNT ||--o{ POST : publishes
  POST ||--o{ COMMENT : contains
  COMMENT ||--o{ COMMENT : replies_to
  COMMENT ||--o{ REPLY_OPERATION : receives

  ACCOUNT {
    uuid id PK
    string external_tenant_id UK
    datetime created_at
  }

  SOCIAL_ACCOUNT {
    uuid id PK
    uuid account_id FK
    string platform
    string external_account_id
    string credential_reference
    datetime created_at
  }

  POST {
    uuid id PK
    uuid account_id FK
    uuid social_account_id FK
    string external_post_id
    string status
    datetime published_at
  }

  COMMENT {
    uuid id PK
    uuid post_id FK
    string external_comment_id
    string external_parent_comment_id
    string author_external_id
    string author_display_name
    text body
    datetime published_at
    datetime updated_at
    datetime last_seen_at
  }

  REPLY_OPERATION {
    uuid id PK
    uuid comment_id FK
    string idempotency_key UK
    string status
    uuid resulting_comment_id FK
    text failure_code
    datetime created_at
    datetime completed_at
  }
```

## Constraints to validate during implementation

- Unique provider identity within a provider scope, such as `(social_account_id, external_comment_id)`.
- Unique idempotency key within the authenticated account scope.
- Index comments by `(post_id, published_at, id)` for deterministic cursor queries.
- Define deletion and retention behavior before production use.
- Treat provider payloads and raw error details as sensitive operational data.
