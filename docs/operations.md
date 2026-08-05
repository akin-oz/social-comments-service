# Operations guide

## Runtime topology

This section describes the intended production topology, not a deployment that exists. The service is packaged as an immutable container and is intended to run as multiple stateless API replicas behind managed ingress. PostgreSQL-compatible managed storage is the source for normalized comments and reply-operation state. Secrets remain in the platform secret store; logs and metrics are emitted to managed observability services.

Only one migration runner executes database migrations per release. API replicas do not run migrations on startup. The service does not require Kubernetes, Kafka, a workflow engine, or a permanent worker for the current synchronous use cases.

## Failure handling

- Provider calls must have explicit connection and response timeouts.
- Retries are limited to safe, transient failures and remain idempotency-aware.
- A reply operation is persisted before provider publication and completed only after the normalized reply is stored.
- Rate limits map to `PROVIDER_RATE_LIMITED`; operators should honor provider reset information and avoid retry storms.
- Provider outages map to `PROVIDER_UNAVAILABLE` or `PROVIDER_ERROR` and should be investigated using request ID and provider metrics.

### Provider load under concurrent reads

Hydration of a post is **single-flight per replica** (Spec-019). Callers arriving while a post is already being hydrated wait for that work and read its result rather than starting their own, so a burst of K readers on a cold post costs one read instead of K. This matters because completing a snapshot walks the provider stream: without deduplication the first burst on a popular post is exactly when provider load is highest and a rate limit is most likely.

Two consequences an operator should know:

- **Deduplication is per replica.** N replicas can still issue N hydrations. Cutting that further needs cross-replica coordination, which ADR-0009 defers; the factor that matters in practice is concurrent readers landing on one process.
- **A joiner waits at most ten seconds.** Past that it answers from the snapshot it has and reports `hasMore`, rather than holding a request until its own thirty-second timeout having helped nobody.

Snapshot advances are compare-and-set: a hydration only moves the stored continuation from the state it read. A losing writer keeps the newer state and stops rather than retrying, which would loop under sustained concurrency. Watch `comments.list.hydration_joined` against `comments.list.hydration_started` to see how much duplicate provider traffic is being avoided, and `comments.snapshot.conflict` for how often two hydrations are racing.

### Reply operation states

A reply operation is claimed on insert and holds that claim under a **lease of two minutes** — comfortably longer than any request that can still be alive, since the HTTP request timeout is thirty seconds. The lease exists because a claim held forever means a process that dies mid-request poisons its idempotency key permanently (Spec-015).

| State       | Meaning                                                                              | Client action                   | Needs an operator |
| ----------- | ------------------------------------------------------------------------------------ | ------------------------------- | ----------------- |
| `pending`   | In flight, and the lease has not expired.                                            | Retry the same key shortly.     | No                |
| `completed` | The reply was published and stored.                                                  | Nothing; the reply is returned. | No                |
| `failed`    | The provider refused the request. Nothing was published.                             | Retry with a **new** key.       | No                |
| `unknown`   | A reply may exist at the provider and this service cannot establish whether it does. | **Do not retry.**               | **Yes**           |

An operation reaches `unknown` three ways: the provider was sent the request and gave no usable answer, the publish succeeded but could not be recorded locally, or the lease expired on an operation whose outcome was never established. In every case the log record names the provider's identifier for the reply that may exist.

One `pending` case self-heals. If the reply was published _and stored_ and only the completion write was lost, the next request for that key reconciles the operation against the stored reply and returns it, without contacting the provider. Recovery is attempted before the lease is consulted, so a live request is never resolved out from under itself.

To find operations needing attention:

```sql
select id, account_id, comment_id, external_reply_id, failure_code, completed_at
from reply_operations
where status = 'unknown'
   or (status = 'pending' and lease_expires_at < now());
```

## Observability

Logs are structured records carrying a stable `event` name in a `noun.verb` namespace (ADR-0011). Alerts and dashboards match on `event`, never on message text, so wording stays editable. Every application and provider record carries `requestId` and `accountId`, so a request can be reconstructed end to end.

The events worth knowing:

| Event                             | Level | Means                                                              |
| --------------------------------- | ----- | ------------------------------------------------------------------ |
| `comments.list.served_from_cache` | info  | Answered from the local snapshot; no provider traffic.             |
| `comments.list.hydrated`          | info  | The snapshot could not answer; a provider page was fetched.        |
| `comments.list.hydration_joined`  | info  | Waited for a hydration already running; carries `waitedMs`.        |
| `comments.snapshot.conflict`      | info  | Another hydration advanced the snapshot first; this one stopped.   |
| `provider.list.completed`         | info  | A provider read finished; carries `fetched` and `durationMs`.      |
| `comments.reply.published`        | info  | A reply reached the provider and was stored.                       |
| `comments.reply.replayed`         | info  | An idempotent retry returned the stored reply.                     |
| `comments.reply.reconciled`       | info  | A pending operation was completed from its stored reply.           |
| `comments.reply.conflict`         | warn  | An idempotency key was reused while in flight.                     |
| `comments.reply.failed`           | warn  | A reply failed; carries the taxonomy `code`.                       |
| `comments.reply.lease_expired`    | warn  | An abandoned claim was resolved to `unknown`.                      |
| `provider.call.retried`           | warn  | A provider call was retried; carries `code` and `delayMs`.         |
| `provider.cursor.rejected`        | warn  | A stored continuation was refused; the stream restarted.           |
| `comments.reply.orphaned`         | error | A reply published but was never stored; the key becomes `unknown`. |
| `comments.reply.unreconciled`     | error | A reply published and stored, but the completion write failed.     |
| `http.request.rejected`           | warn  | A request was refused; carries the typed `code`.                   |
| `http.request.failed`             | error | An unhandled failure. This is the only routine alert-worthy event. |

The ratio of `comments.list.hydrated` to `comments.list.served_from_cache` is the cache hit rate, and a rise in `provider.call.retried` is the earliest warning of provider trouble. `comments.reply.orphaned` is the one record that always warrants a human: a reply exists under a customer's name and this service does not have it.

A rejected client request is logged at warn, never error. Reserving error for failures the service did not anticipate keeps the level meaningful for alerting.

Logs never contain comment bodies, author display names, credentials, or provider tokens. Where content matters operationally the record carries a measurement instead, such as `bodyLength` or `fetched`. The client address and port are omitted, since behind an internal gateway they describe the gateway rather than the caller.

`SNAPSHOT_LIFETIME_SECONDS` sets how long a completed snapshot is trusted before a read refreshes it, defaulting to 300. One read completes a post's stream, bounded at 20 provider calls per request, after which the caller is told there is more and the next request continues.

`LOG_LEVEL` sets verbosity and defaults to `info`. Metric counters and timings are emitted at `debug` in compositions that have not selected a metrics backend, so `pnpm dev` shows them without a collector.

## Database roles, migrations, and seeding

Two roles exist, and the separation is what makes tenant isolation real rather than nominal (ADR-0012).

| Role             | Used by                | Why                                                                   |
| ---------------- | ---------------------- | --------------------------------------------------------------------- |
| `comments_owner` | migrations and seeding | Owns the schema. Typically a superuser locally.                       |
| `comments_app`   | the running service    | Owns nothing and is not a superuser, so the RLS policies apply to it. |

**The service must never connect as a superuser or as the schema owner.** PostgreSQL exempts superusers and `BYPASSRLS` roles from row-level security unconditionally, and exempts a table's owner unless the table is set to `FORCE ROW LEVEL SECURITY`. A deployment that shares one credential between migrations and the service silently disables tenant isolation while `\d` still reports the policies as enabled.

```bash
pnpm migrate   # applies migrations/ in order, records them, safe to re-run
pnpm seed      # reference tenants, social accounts, and posts; idempotent
```

Migrations run once per release from a single runner, never on API startup, so replicas cannot race each other. `APP_DATABASE_PASSWORD` sets the service role's password during migration; credentials never live in a migration file.

`docker compose up` runs PostgreSQL, then migrate and seed as a one-shot step, then the service.

## Data and security

The application establishes `app.account_id` from trusted authentication context inside the database transaction. RLS policies fail closed when that setting is absent. Tokens are referenced, not stored, in this service schema. Logs must not contain credentials or full comment bodies unless explicitly needed for a controlled incident.

Retention and deletion automation are not selected yet and must be decided before production data retention is enabled.

## Health and delivery

`GET /health` is a process health check. Deployment configuration should add a database/provider readiness check when those dependencies are enabled. Rolling deployment requires a passing image quality gate and a completed migration step; restart behavior is delegated to the managed container runtime.
