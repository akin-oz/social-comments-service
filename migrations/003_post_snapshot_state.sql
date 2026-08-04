-- Records how much of a post's provider comment stream has been read into the
-- local snapshot (Spec-013).
--
-- Without this the service forgets what hydration learned, keeping it only
-- inside a cursor handed to one client. A caller starting pagination fresh then
-- cannot be told whether the provider holds more, and was reported an
-- incomplete post as a complete one.
--
-- An existing row has read nothing, so the defaults make the next read hydrate.
alter table posts
  add column provider_cursor text,
  add column provider_exhausted boolean not null default false;

-- The service now advances this state, so it needs to write to posts. Its other
-- privileges are unchanged and row-level security still applies to it.
grant update (provider_cursor, provider_exhausted) on posts to comments_app;
