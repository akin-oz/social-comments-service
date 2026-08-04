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

## Observability

Logs are structured records carrying a stable `event` name in a `noun.verb` namespace (ADR-0011). Alerts and dashboards match on `event`, never on message text, so wording stays editable. Every application and provider record carries `requestId` and `accountId`, so a request can be reconstructed end to end.

The events worth knowing:

| Event                             | Level | Means                                                              |
| --------------------------------- | ----- | ------------------------------------------------------------------ |
| `comments.list.served_from_cache` | info  | Answered from the local snapshot; no provider traffic.             |
| `comments.list.hydrated`          | info  | The snapshot could not answer; a provider page was fetched.        |
| `provider.list.completed`         | info  | A provider read finished; carries `fetched` and `durationMs`.      |
| `comments.reply.published`        | info  | A reply reached the provider and was stored.                       |
| `comments.reply.replayed`         | info  | An idempotent retry returned the stored reply.                     |
| `comments.reply.conflict`         | warn  | An idempotency key was reused while in flight.                     |
| `comments.reply.failed`           | warn  | A reply failed; carries the taxonomy `code`.                       |
| `provider.call.retried`           | warn  | A provider call was retried; carries `code` and `delayMs`.         |
| `http.request.rejected`           | warn  | A request was refused; carries the typed `code`.                   |
| `http.request.failed`             | error | An unhandled failure. This is the only routine alert-worthy event. |

The ratio of `comments.list.hydrated` to `comments.list.served_from_cache` is the cache hit rate, and a rise in `provider.call.retried` is the earliest warning of provider trouble.

A rejected client request is logged at warn, never error. Reserving error for failures the service did not anticipate keeps the level meaningful for alerting.

Logs never contain comment bodies, author display names, credentials, or provider tokens. Where content matters operationally the record carries a measurement instead, such as `bodyLength` or `fetched`. The client address and port are omitted, since behind an internal gateway they describe the gateway rather than the caller.

`LOG_LEVEL` sets verbosity and defaults to `info`. Metric counters and timings are emitted at `debug` in compositions that have not selected a metrics backend, so `pnpm dev` shows them without a collector.

## Data and security

The application establishes `app.account_id` from trusted authentication context inside the database transaction. RLS policies fail closed when that setting is absent. Tokens are referenced, not stored, in this service schema. Logs must not contain credentials or full comment bodies unless explicitly needed for a controlled incident.

Retention and deletion automation are not selected yet and must be decided before production data retention is enabled.

## Health and delivery

`GET /health` is a process health check. Deployment configuration should add a database/provider readiness check when those dependencies are enabled. Rolling deployment requires a passing image quality gate and a completed migration step; restart behavior is delegated to the managed container runtime.
