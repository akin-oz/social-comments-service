-- Gives snapshot exhaustion a lifetime (Spec-014).
--
-- provider_exhausted was a one-way latch: once a post had been read through,
-- nothing ever set it back, so every comment published afterwards stayed
-- invisible indefinitely and without error. Recording when the stream was
-- completed lets a later read decide the snapshot is stale and start again.
alter table posts add column provider_completed_at timestamptz;

grant update (provider_cursor, provider_exhausted, provider_completed_at) on posts to comments_app;
