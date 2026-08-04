---
adr: 0011
title: Log domain decisions as structured events behind a logger port
status: accepted
---

# ADR-0011: Log domain decisions as structured events behind a logger port

## Context

ADR-0009 deferred operational concerns to a final milestone and Spec-007 authorised "structured logging and request correlation at service boundaries" and "metrics boundaries for request, provider, repository, and failure outcomes". Neither says what should be logged, by which layer, or in what shape. The result is that the service emits HTTP access logs and nothing else.

Running `pnpm dev` and issuing four requests that do materially different things produces output that cannot distinguish them:

```text
reqId=req-1  GET  /v2/posts/{id}/comments  200  3.36ms
reqId=req-2  GET  /v2/posts/{id}/comments  200  0.20ms
reqId=req-3  POST /v2/comments/{id}/replies 201 1.90ms
reqId=req-4  GET  /v2/posts/{id}/comments  400  0.32ms
```

The first request fetched a page from the provider and populated the snapshot. The second answered from the snapshot without touching the provider. The third published a reply to a provider and stored it. The fourth was rejected for an invalid cursor. None of that is recoverable from the logs. The only signal separating a provider round trip from a cache hit is response time, which is inference, not evidence.

Three specific gaps follow from this:

1. **Domain decisions are invisible.** Whether a read was served locally or cost a provider call is the single most operationally interesting fact about this service, and it is not recorded. The same applies to idempotent replay, idempotency conflict, provider retry, and rate-limit backoff.
2. **Failures are logged without their reason.** The error handler maps a failure to a typed code and returns it to the client, but logs only the HTTP status. An operator sees `400` and cannot tell `INVALID_CURSOR` from `INVALID_REQUEST` without reproducing the call. Only unhandled exceptions are logged with detail.
3. **Metrics are computed and discarded.** `CommentService` emits counters and timings for every operation, and the default composition binds them to `noopMetrics`. The instrumentation exists and reaches nothing, so `pnpm dev` shows no metrics at all.

There is also a structural obstacle. `CommentService` receives a `Metrics` port but no logger, and the domain must not import Fastify or a logging library, so today there is no legal way for the application layer to record anything.

## Decision

1. **Add a `Logger` port next to `Metrics` in `src/shared/observability.ts`.** It exposes `debug`, `info`, `warn`, and `error`, each taking a structured payload and an event name. A `noopLogger` is the default, matching the existing `noopMetrics` convention. Domain and application code depend only on this port, so the dependency rule in `docs/architecture.md` is preserved and the logging backend stays replaceable.

2. **Every log record carries a stable `event` name** in a `noun.verb` namespace mirroring the existing metric names, for example `comments.list.hydrated`, `comments.list.served_from_cache`, `comments.reply.published`, `comments.reply.replayed`, `provider.call.retried`. Consumers match on `event`, never on human-readable text, so message wording stays editable without breaking a dashboard or alert.

3. **Each layer logs what only it knows.**
   - The API layer logs request lifecycle, the resolved account, the outcome status, and, on failure, the typed error code.
   - The application layer logs domain decisions: snapshot hit versus provider hydration, page size returned, reply published, reply replayed, idempotency conflict.
   - The provider adapter logs provider call outcome, attempt count, elapsed time, and retry or rate-limit backoff.
   - Repositories stay silent by default. They are called on every request, carry no decision, and would drown the useful records; failures surface as exceptions logged by the caller.

4. **Correlate with a request-scoped context.** Introduce `RequestContext`, which extends `TenantContext` with the `requestId` Fastify already generates. Service methods take `RequestContext`; repositories keep taking `TenantContext`, since tenancy is all they need. This keeps tracing concerns out of the tenancy contract while making every application and provider record joinable to the HTTP request that caused it.

5. **Severity reflects who must act.** `info` for lifecycle and domain decisions. `warn` for conditions that are expected but worth counting, such as rate limiting, idempotency conflict, and unsupported capability. `error` only for failures the service did not anticipate. A rejected client request is not an error; logging 4xx at error level trains operators to ignore the level.

6. **Redaction is a property of the logger, not of each call site.** Comment bodies, author display names, credentials, and provider tokens are never logged. Where content matters operationally, log a measurement instead: body length, item counts, page sizes. This extends the existing rule in `docs/operations.md` from prose into an enforced boundary, and the client remote address and port are dropped from the request serializer as low-value data about an internal gateway.

7. **Bind metrics to the logger in non-production compositions.** The `Metrics` port keeps its shape and its production exporter stays unselected, per ADR-0009's rule that vendor choice is a delivery decision. The demo composition binds a logging-backed implementation so counters and timings are visible during `pnpm dev` rather than silently dropped.

## Consequences

An operator can answer the questions that matter for this service from the log alone: whether a read cost a provider call, why a request failed, whether a reply was published or replayed, and how often the provider is rate limiting. Those are the same questions a reviewer asks when judging whether the caching and idempotency designs work.

The cost is that `CommentService`, the adapter, and the routes each take one more dependency, and `RequestContext` is a contract change rippling through the service signatures. Records also become a compatibility surface: once an `event` name is consumed by a dashboard, renaming it is a breaking change and belongs in a later ADR.

Logging is deliberately kept sparse. A record per domain decision, not per function call, is what makes the output readable; the failure mode of this decision is not too little logging but a later drift toward logging everything.

## Alternatives considered

**Passing the Fastify request logger into the service.** It is the least code and gives correlation for free, but it puts a Fastify type in the application layer, which `docs/architecture.md` forbids and which would make the service untestable without an HTTP server.

**Logging inside repositories and the cursor codec.** Rejected as noise. These run on every request and record no decision, and the interesting fact about a repository call is whether the service chose to make it, which the application layer already knows.

**Adopting OpenTelemetry spans now.** Correct for a distributed system and premature for a single modular monolith with one synchronous provider call per request. It also means a dependency and a vendor decision, both of which ADR-0009 defers until operational evidence justifies them. The `event`-plus-`requestId` shape chosen here maps onto spans later without changing call sites.

**Pretty-printing logs in development.** Genuinely helps readability but requires a new dependency, which the engineering rules gate behind an approved spec. Left as an open decision rather than assumed.

## Open decisions

1. **Log level configuration.** Propose a `LOG_LEVEL` environment variable defaulting to `info`, with `debug` enabling provider request and response shapes minus content. Needs confirmation that configuration by environment variable is acceptable, since no other configuration currently works that way.
2. **Development pretty-printing.** Adding `pino-pretty` as a dev dependency would make `pnpm dev` substantially easier to read. It requires an approved spec under the dependency rule, so it is out of scope here unless explicitly wanted.
3. **Whether to log the tenant account identifier on every record.** It is necessary for multi-tenant debugging and is an internal identifier rather than personal data, but it does widen what a log aggregator holds per tenant.
