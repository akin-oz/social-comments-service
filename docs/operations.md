# Operations guide

## Runtime topology

The service is packaged as an immutable container and runs as multiple stateless API replicas behind managed ingress. PostgreSQL-compatible managed storage is the source for normalized comments and reply-operation state. Secrets remain in the platform secret store; logs and metrics are emitted to managed observability services.

Only one migration runner executes database migrations per release. API replicas do not run migrations on startup. The service does not require Kubernetes, Kafka, a workflow engine, or a permanent worker for the current synchronous use cases.

## Failure handling

- Provider calls must have explicit connection and response timeouts.
- Retries are limited to safe, transient failures and remain idempotency-aware.
- A reply operation is persisted before provider publication and completed only after the normalized reply is stored.
- Rate limits map to `PROVIDER_RATE_LIMITED`; operators should honor provider reset information and avoid retry storms.
- Provider outages map to `PROVIDER_UNAVAILABLE` or `PROVIDER_ERROR` and should be investigated using request ID and provider metrics.

## Data and security

The application establishes `app.account_id` from trusted authentication context inside the database transaction. RLS policies fail closed when that setting is absent. Tokens are referenced, not stored, in this service schema. Logs must not contain credentials or full comment bodies unless explicitly needed for a controlled incident.

Retention and deletion automation are not selected yet and must be decided before production data retention is enabled.

## Health and delivery

`GET /health` is a process health check. Deployment configuration should add a database/provider readiness check when those dependencies are enabled. Rolling deployment requires a passing image quality gate and a completed migration step; restart behavior is delegated to the managed container runtime.
