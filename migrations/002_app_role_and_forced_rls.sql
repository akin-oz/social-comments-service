-- Makes the row-level security enabled in 001 actually enforce (ADR-0012).
--
-- Two gaps are closed here. PostgreSQL exempts a table's owner from row-level
-- security, so an application connecting with the owning role satisfies every
-- policy trivially while `\d` still reports the policies as enabled. And the
-- policies read `app.account_id`, which nothing set until this change.
--
-- Migrations run as the owner; the service connects as comments_app, which is
-- neither a superuser nor an owner and is therefore subject to the policies.
-- That separation is what makes the isolation real.
--
-- FORCE does not constrain a superuser: PostgreSQL exempts superusers and
-- BYPASSRLS roles unconditionally, and FORCE only extends the policies to a
-- non-superuser owner. It is kept for managed PostgreSQL, where the owner
-- typically is not a superuser and FORCE is what stops the migration role from
-- bypassing the policies. A deployment must never run the service as a
-- superuser. See ADR-0012.

do $$
begin
  if not exists (select from pg_roles where rolname = 'comments_app') then
    create role comments_app login;
  end if;
end
$$;

grant usage on schema public to comments_app;

-- Read-only reference data: the service never writes tenants or connections.
grant select on accounts, social_accounts, posts to comments_app;

-- The service owns the comment snapshot and the reply audit trail.
grant select, insert, update on comments, reply_operations to comments_app;

alter table social_accounts force row level security;
alter table posts force row level security;
alter table comments force row level security;
alter table reply_operations force row level security;
