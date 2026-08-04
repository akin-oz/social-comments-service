---
adr: 0012
title: Establish tenant context per database operation, not per request
status: accepted
---

# ADR-0012: Establish tenant context per database operation, not per request

## Context

`docs/database.md` and assumption A-011 require row-level security as defence in depth behind the repository's own `account_id` predicates. The migration creates policies that read `current_setting('app.account_id', true)`. Three things are missing, and together they mean the isolation the documentation claims does not exist:

1. **Nothing sets the value.** No code in `src/` writes `app.account_id`. The policies read a setting that is never populated.
2. **No transaction boundary exists.** `TransactionalSqlExecutor.transaction()` is declared and never called, and `SqlExecutor.query()` has no way to carry a tenant, so there is nowhere for a transaction-local setting to live.
3. **The owner bypasses the policies.** PostgreSQL exempts a table's owner from row-level security unless the table is set to `FORCE ROW LEVEL SECURITY`. The migration enables RLS but does neither that nor create a non-owner role, so an application connecting with the owning role — the default when a migration and the app share credentials — would satisfy every policy trivially.

The third is the most dangerous, because `\d` reports the policies as present and enabled. The configuration reads as secure and enforces nothing.

A design question has to be answered before any of this can be fixed: what is the scope of the tenant context?

## Decision

**Tenant context is established per database operation, inside a transaction the repository opens, and never spans a provider call.**

1. Replace `SqlExecutor` and `TransactionalSqlExecutor` with a single `Database` port:

   ```ts
   interface Database {
     withTenant<T>(accountId: AccountId, run: (tx: SqlSession) => Promise<T>): Promise<T>;
   }
   ```

   `withTenant` opens a transaction, sets `app.account_id` transaction-locally with `set_config(..., true)`, runs the callback, and commits or rolls back. A repository cannot reach the database without naming a tenant, so forgetting the context becomes a type error rather than a silent full-table read.

2. **The unit of scope is one repository operation, not one HTTP request.** Publishing a reply claims an idempotency key, calls the provider, stores the result, and completes the operation record. A request-scoped transaction would hold it open across an outbound HTTP call, pinning a connection for the provider's latency and turning a provider timeout into a long-lived idle transaction. The reply flow is deliberately not atomic across the provider call: that is what the reply-operation record and its idempotency key exist for.

3. **The application connects as a non-owner role, and tenant tables are set to `FORCE ROW LEVEL SECURITY`.** Either alone would be sufficient in principle; both are cheap, and the combination means neither a credential mistake nor a future migration that changes ownership silently disables isolation.

4. **Repository predicates stay.** Every query keeps its explicit `account_id = $n` condition. RLS is the backstop for a predicate that is forgotten or wrong, not a replacement for writing it.

## Consequences

Isolation becomes verifiable rather than asserted: a test can connect as the application role, set one tenant, and confirm another tenant's rows are invisible. That test is the only thing that distinguishes this from the current state, so it is a required part of the change rather than optional coverage.

The cost is a contract change through the Postgres repositories, and one transaction per repository operation rather than per request. For the read path that is a single transaction; for the reply path it is four short ones, which is the correct trade for not holding a transaction across a provider call.

Because the setting is transaction-local, a connection returned to the pool cannot leak tenant context into the next checkout. This is the reason for `set_config(..., true)` over `SET`, and it is the property that makes pooling safe here.

Operationally, migrations and the application now use different roles, so deployment has two credentials to manage instead of one. That is the price of the owner not bypassing its own policies.

## Implementation outcome

Decision 3 above was partly wrong, and this section is the authority.

`FORCE ROW LEVEL SECURITY` does not constrain a superuser. PostgreSQL exempts superusers and roles with `BYPASSRLS` from row-level security unconditionally, and `FORCE` only extends the policies to a table's _non-superuser_ owner. Measured against the local stack, where the owner is the PostgreSQL image's superuser:

```text
app role (comments_app), tenant A context  -> 0 of tenant B's comments
owner (superuser), tenant A context, FORCE on   -> 1
owner (superuser), tenant A context, FORCE off  -> 1
```

So the protection that actually works is the one this ADR gets right: **the service connects as `comments_app`, which is neither a superuser nor an owner**, and is therefore subject to the policies. That is what makes the isolation real, and it is what the integration tests assert.

`FORCE` is kept because it is not always redundant. Managed PostgreSQL commonly gives an owner role that is not a superuser, and there `FORCE` is exactly what stops the migration role from bypassing the policies. It is a safeguard for that case, not for this one.

The practical consequence is that a deployment must not run the service as a superuser. That is stronger than "not the owner" and belongs in the operational requirements.

## Alternatives considered

**Per-request transaction with request-scoped repositories.** Gives one coherent snapshot per request and would let the reply flow be atomic. Rejected because that atomicity is not wanted: the provider call must sit outside the transaction, and a transaction spanning it would couple database connection lifetime to provider latency.

**Setting `app.account_id` on connection checkout with a pool hook.** Fewer transactions, but the setting outlives the checkout unless carefully reset, and a missed reset is a cross-tenant read rather than an error. Transaction-local scope fails closed instead.

**Relying only on repository predicates and dropping RLS.** Simpler, and the predicates are already there. Rejected because A-011 treats tenant isolation as mandatory, and a single missed predicate in a future query is an unbounded data leak. A backstop that the database enforces is worth two credentials.

**Trusting RLS alone and dropping the predicates.** Rejected as fragile in the other direction: a superuser connection, a future `FORCE` being lifted, or a policy edit would remove all protection at once.
