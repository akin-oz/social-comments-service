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

### Reads deeper than the hydration budget

One request completes a post's provider stream, bounded at twenty provider calls. A post deeper than that is served over a snapshot still being read, and the run is marked partial: `snapshot.syncedAt` reports `null` for every page of that run, which is the contract's instruction to the client to start again once the snapshot finishes (Spec-021).

Nothing is lost from the database — the comments are fetched and stored, they are simply behind that run's cursor. `comments.list.*` records carry `partialRun`, so the share of reads landing on posts too deep for one budget is measurable. A consistently high share is the signal to raise `MAX_HYDRATIONS_PER_REQUEST` or to hydrate ahead of the request.

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

### The idempotency fingerprint secret

`IDEMPOTENCY_FINGERPRINT_SECRET` keys the digest that binds an idempotency key to one request (Spec-023). **The service refuses to start under `NODE_ENV=production` without it**, in the same way and for the same reason it refuses without `DATABASE_URL`: falling back would leave the deployment believing its stored fingerprints were unguessable when they are computed from a constant in this repository. Outside production a fixed development key is used and the startup log reports `fingerprintKey: "development"`, so a configured deployment is distinguishable from a defaulted one at a glance.

The digest is an HMAC rather than a plain hash because `request_fingerprint` sits in the same row as `comment_id`, and the row exists precisely so the reply body is not stored (ADR-0011). Unkeyed, anyone who could read the table — a support engineer, a backup, an analytics export — could confirm a guess at a short reply with one hash, and "Thanks!" is a very small dictionary.

**Rotating the secret invalidates every stored fingerprint.** A client replaying an in-flight idempotency key across the rotation is told its request body changed (`idempotency_key_body_mismatch`), which from outside looks like a client bug. The exposure window is minutes long — the length of a reply operation — so rotate during a quiet period rather than carrying a previous key for comparison.

### Malformed stored records

Every comment and every reply operation is checked against the domain model on its way out of a repository (Spec-025). A row that fails produces `INTERNAL_ERROR` with reason `stored_record_invalid`, a `500`, and an error-level record naming `recordKind` and `recordId` — the row's service-owned identifier, never its content.

**This should never fire.** When it does it means a mapper defect or corrupt data, not a bad request, and the log record is the handle for finding the row. The guard exists because this exact class of defect has shipped here before: a reply-operation row was cast rather than mapped, every field read as `undefined`, and every idempotent retry looked like a different request while the suite stayed green.

The cost is deliberate and worth knowing: **one malformed row makes the page containing it unreadable**, and under keyset pagination that blocks the pages after it too, so a single corrupt comment can strand the rest of a post. The alternative — skipping the row and serving a short page — hides the fault behind a response that looks complete, which is the failure mode this service keeps finding in itself.

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

That rule used to be aspirational at the transport layer. An oversized body or malformed JSON is a Fastify error rather than a `ServiceError`, so it fell through to `INTERNAL_ERROR` with a stack trace at error level — a page-worthy signal anyone with a valid account header could raise at will. The handler now reads the status the framework attached and treats any sub-500 as the client error it is (Spec-022). It is asserted, not stated: a test injects both and fails if anything reaches error level.

Logs never contain comment bodies, author display names, credentials, or provider tokens. Where content matters operationally the record carries a measurement instead, such as `bodyLength` or `fetched`. The client address and port are omitted, since behind an internal gateway they describe the gateway rather than the caller.

`SNAPSHOT_LIFETIME_SECONDS` sets how long a completed snapshot is trusted before a read refreshes it, defaulting to 300. One read completes a post's stream, bounded at 20 provider calls per request, after which the caller is told there is more and the next request continues.

`LOG_LEVEL` sets verbosity and defaults to `info`. Metric counters and timings are emitted at `debug` in compositions that have not selected a metrics backend, so `pnpm dev` shows them without a collector.

## Install and supply chain

Every dependency resolves from the npm registry. `@akinlabs/ai-engineering` used to come from a pinned GitHub tarball, which meant an install also needed reachability to `codeload.github.com` and resolved a mutable tag; it is now `0.2.0` from the registry, immutable and integrity-checked. A proxy that allowlists the registry alone is sufficient.

The current advisory set is five findings, all in the `vitest`/`vite`/`esbuild` development chain and none present in the production image. They are recorded rather than bumped, because bumping a test runner on the eve of a submission trades a real regression risk for a theoretical one that does not reach the deployed artefact.

`pnpm migrate` sets the service role's password with `alter role … password`. DDL cannot take a bound parameter, so the value is escaped as a literal rather than interpolated raw — but a server configured with `log_statement = ddl` or `all` will write that statement, and therefore the password, to the PostgreSQL log. Either leave `log_statement` at its default of `none` while migrating, or set a pre-computed SCRAM verifier instead of a plaintext password.

### Regenerating the assistant artefacts

`pnpm ai:sync` compiles `.ai/` into `CLAUDE.md`, `AGENTS.md`, `.claude/`, and `.codex/`, and CI fails if the result differs from what is committed.

Two things about it are worth knowing before editing `.ai/`:

- **`.ai/state/` is committed on purpose.** Since 0.2.0 the compiler records which files it owns and refuses to overwrite anything it does not. Without that state in the repository, the first `pnpm ai:sync` after a clone refuses and the drift gate fails for a reason that has nothing to do with drift.
- **`pnpm ai:validate` reports six warnings, and that is expected.** They say the hook scripts are not declared in the manifest. They are not, deliberately: the compiler's hook model has four events, and two of this repository's six hooks — a pre-tool-use guard matching Bash, and a Stop hook — cannot be expressed in it. Declaring four and hand-maintaining two would leave the set half-generated, so `scripts/sync-ai.mjs` copies all six, the same way it already did for `.codex/hooks`. If that number changes, something else has drifted.

## Security response headers

The service sets no `Strict-Transport-Security`, `Content-Security-Policy`, or `X-Content-Type-Options`. That is deliberate for a JSON API behind an internal gateway (A-001): the gateway terminates TLS and is the correct place to set transport and browser policy, and none of these headers changes what a JSON client does. Exposing this service directly to browsers would require them, and would require a real credential check in front of it first — the same boundary A-001 already draws.

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
