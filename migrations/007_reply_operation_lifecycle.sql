-- Makes a reply operation recoverable, and its outcome honest (Spec-015).
--
-- Two defects turned a transient failure into a permanent one. A claim was
-- held forever by whichever process inserted it, so a process that died
-- mid-request left a pending row nobody else could resolve and the key answered
-- 409 until someone ran SQL by hand. And 'pending' was doing duty for two
-- different things — in flight, and outcome unknown — so a timeout after send,
-- a crash after a confirmed publish, and a clean rejection were
-- indistinguishable to the client and to the operator.

-- The lease. A claim is now held for a bounded time rather than forever, so a
-- later request can resolve an operation whose owner is gone. Existing rows get
-- an already-expired lease: they are precisely the abandoned ones this exists
-- to release.
alter table reply_operations
  add column lease_expires_at timestamptz not null default now();

-- The provider's identifier for the reply, recorded between the publish and the
-- local write. It is what lets a later request tell "the reply was published
-- and stored, only the completion was lost" from "the reply was published and
-- nothing here knows where it went". The first is recoverable; the second is
-- not, and they must not look the same.
alter table reply_operations
  add column external_reply_id text;

-- The fourth state. 'failed' means the provider rejected the request, and tells
-- a client to retry with a new key. 'unknown' means nobody knows whether the
-- reply exists, and tells a client to stop and a human to look. Collapsing the
-- second into the first invites a duplicate publication under a customer's
-- name; collapsing it into 'pending' invites waiting forever.
alter table reply_operations
  drop constraint reply_operations_status_check,
  add constraint reply_operations_status_check
    check (status in ('pending', 'completed', 'failed', 'unknown'));

-- Recovery reads pending operations by key, which the unique index on
-- (account_id, idempotency_key) already serves. This index serves the operator
-- question instead: which operations need a human?
create index reply_operations_unresolved_idx
  on reply_operations (account_id, status, lease_expires_at)
  where status = 'pending' or status = 'unknown';
