-- Closes the isolation perimeter and the schema gaps the application was
-- compensating for (Spec-018).
--
-- Three things happen here: the service role's attributes stop being taken on
-- trust, row-level security reaches the last table the role can read, and the
-- constraints the application already assumes become the database's rules
-- rather than the application's habits.

-- 1. Pin the service role.
--
-- Migration 002 creates comments_app only when the name is free, so a
-- pre-existing role of that name holding SUPERUSER or BYPASSRLS silently
-- defeats every policy while the migration reports success. The whole isolation
-- story rests on this role being ordinary, so the attributes are asserted
-- unconditionally rather than assumed from the moment of creation.
--
-- This deliberately alters a role an operator may have created themselves. A
-- comments_app with elevated rights is not a configuration choice this schema
-- can honour: it makes the policies decorative.
do $$
begin
  if not exists (select from pg_roles where rolname = 'comments_app') then
    create role comments_app login;
  end if;
end
$$;

-- Pinning SUPERUSER/BYPASSRLS off requires SUPERUSER, which the migrating role
-- is deliberately not on managed PostgreSQL — the deployment ADR-0012 names as
-- the one that matters. So the pin runs when it can and warns when it cannot,
-- rather than aborting the whole migration where it is needed most. What is not
-- conditional is the assertion below: any role can read pg_roles, so the
-- guarantee that comments_app is ordinary is checked unconditionally and the
-- migration fails loudly if it is violated, whether or not this run could set
-- it. (nocreatedb/nocreaterole are ordinary attributes and need no superuser.)
alter role comments_app nocreatedb nocreaterole;

do $$
begin
  alter role comments_app nosuperuser nobypassrls;
exception
  when insufficient_privilege then
    raise warning 'could not clear SUPERUSER/BYPASSRLS on comments_app (not superuser); relying on the assertion below and on it having been created without them';
end
$$;

do $$
declare
  elevated boolean;
begin
  select rolsuper or rolbypassrls into elevated from pg_roles where rolname = 'comments_app';
  if elevated then
    raise exception 'comments_app holds SUPERUSER or BYPASSRLS, which defeats every row-level security policy; refusing to complete migration 006';
  end if;
end
$$;

-- 2. Extend row-level security to accounts.
--
-- No live query reads this table, which is exactly why the policy is worth
-- adding: the next query is written by someone who assumes the perimeter is
-- complete. The policy keys on the row's own identifier, since an account row
-- is its own tenant.
alter table accounts enable row level security;
alter table accounts force row level security;

create policy accounts_tenant_isolation on accounts
  using (id = nullif(current_setting('app.account_id', true), '')::uuid)
  with check (id = nullif(current_setting('app.account_id', true), '')::uuid);

-- 3. Constrain platform at the database.
--
-- The domain has a closed set and the validator enforces it, but the validator
-- is one code path and the column is the shared fact.
alter table social_accounts
  add constraint social_accounts_platform_check
  check (platform in ('facebook', 'instagram', 'linkedin', 'x', 'youtube'));

-- 4. Index the reply-operation foreign keys.
--
-- PostgreSQL indexes the referenced side of a foreign key, never the
-- referencing side, so every one of these was a sequential scan on lookup and
-- on any delete of the parent row.
create index reply_operations_comment_idx on reply_operations (account_id, comment_id);
create index reply_operations_resulting_comment_idx
  on reply_operations (resulting_comment_id)
  where resulting_comment_id is not null;

-- 5. State the deletion semantics.
--
-- Every foreign key had PostgreSQL's default, which means deletion behaviour
-- was whatever the default happens to be rather than a decision anyone made.
-- The rule chosen: deleting a tenant deletes everything that tenant owns, and
-- within a tenant a post owns its comments — but the record of something
-- published under a customer's name does not vanish quietly.
--
-- reply_operations uses NO ACTION rather than RESTRICT on purpose. Both refuse
-- to let a comment be deleted out from under an operation that references it;
-- the difference is when the check runs. RESTRICT fires immediately and would
-- make deleting a whole account impossible, because the account's cascade
-- removes the operations and the comments in one statement. NO ACTION defers to
-- the end of the statement, by which point the operations are already gone. So
-- deleting one comment with a reply behind it fails, and deleting a tenant
-- succeeds — which is the pair of behaviours actually wanted.

alter table social_accounts
  drop constraint social_accounts_account_id_fkey,
  add constraint social_accounts_account_id_fkey
    foreign key (account_id) references accounts (id) on delete cascade;

alter table posts
  drop constraint posts_account_id_fkey,
  add constraint posts_account_id_fkey
    foreign key (account_id) references accounts (id) on delete cascade,
  drop constraint posts_social_account_id_fkey,
  add constraint posts_social_account_id_fkey
    foreign key (social_account_id) references social_accounts (id) on delete cascade;

alter table comments
  drop constraint comments_account_id_fkey,
  add constraint comments_account_id_fkey
    foreign key (account_id) references accounts (id) on delete cascade,
  drop constraint comments_post_id_fkey,
  add constraint comments_post_id_fkey
    foreign key (post_id) references posts (id) on delete cascade,
  drop constraint comments_social_account_id_fkey,
  add constraint comments_social_account_id_fkey
    foreign key (social_account_id) references social_accounts (id) on delete cascade;

alter table reply_operations
  drop constraint reply_operations_account_id_fkey,
  add constraint reply_operations_account_id_fkey
    foreign key (account_id) references accounts (id) on delete cascade,
  drop constraint reply_operations_comment_id_fkey,
  add constraint reply_operations_comment_id_fkey
    foreign key (comment_id) references comments (id) on delete no action,
  drop constraint reply_operations_resulting_comment_id_fkey,
  add constraint reply_operations_resulting_comment_id_fkey
    foreign key (resulting_comment_id) references comments (id) on delete no action;
