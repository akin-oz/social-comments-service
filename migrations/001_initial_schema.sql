-- PostgreSQL 16+. Run each migration in order with a single controlled runner.
create table accounts (
  id uuid primary key,
  external_tenant_id text not null unique,
  created_at timestamptz not null default now()
);

create table social_accounts (
  id uuid primary key,
  account_id uuid not null references accounts(id),
  platform text not null,
  external_account_id text not null,
  credential_reference text not null,
  created_at timestamptz not null default now(),
  unique (account_id, platform, external_account_id)
);

create table posts (
  id uuid primary key,
  account_id uuid not null references accounts(id),
  social_account_id uuid not null references social_accounts(id),
  external_post_id text not null,
  status text not null,
  published_at timestamptz,
  unique (social_account_id, external_post_id)
);

create table comments (
  id uuid primary key,
  account_id uuid not null references accounts(id),
  post_id uuid not null references posts(id),
  social_account_id uuid not null references social_accounts(id),
  external_comment_id text not null,
  external_parent_comment_id text,
  author_external_id text not null,
  author_display_name text not null,
  body text not null,
  published_at timestamptz not null,
  updated_at timestamptz not null,
  last_seen_at timestamptz not null default now(),
  unique (social_account_id, external_comment_id)
);

create index comments_post_cursor_idx on comments (account_id, post_id, published_at, id);

create table reply_operations (
  id uuid primary key,
  account_id uuid not null references accounts(id),
  comment_id uuid not null references comments(id),
  idempotency_key text not null,
  request_fingerprint text not null,
  status text not null check (status in ('pending', 'completed', 'failed')),
  resulting_comment_id uuid references comments(id),
  failure_code text,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  unique (account_id, idempotency_key)
);

-- The application sets this transaction-local value only from trusted auth context.
alter table social_accounts enable row level security;
alter table posts enable row level security;
alter table comments enable row level security;
alter table reply_operations enable row level security;

create policy social_accounts_tenant_isolation on social_accounts
  using (account_id = nullif(current_setting('app.account_id', true), '')::uuid)
  with check (account_id = nullif(current_setting('app.account_id', true), '')::uuid);
create policy posts_tenant_isolation on posts
  using (account_id = nullif(current_setting('app.account_id', true), '')::uuid)
  with check (account_id = nullif(current_setting('app.account_id', true), '')::uuid);
create policy comments_tenant_isolation on comments
  using (account_id = nullif(current_setting('app.account_id', true), '')::uuid)
  with check (account_id = nullif(current_setting('app.account_id', true), '')::uuid);
create policy reply_operations_tenant_isolation on reply_operations
  using (account_id = nullif(current_setting('app.account_id', true), '')::uuid)
  with check (account_id = nullif(current_setting('app.account_id', true), '')::uuid);
