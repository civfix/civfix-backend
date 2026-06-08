-- -----------------------------------------------------------------------------
-- 0008_chat_read_state
--
-- Persist the per-(member, cleanup) chat read watermark so unread counts decrement
-- when a conversation is viewed AND survive an API restart / span multiple instances
-- (Phase 1 stored the watermark process-locally, so it reset on restart). The column
-- is the timestamp of the newest message the member has read; GET /threads counts
-- messages from OTHERS with created_at strictly after max(joined_at, last_read_at).
--
-- Additive + nullable (NULL = never marked read -> unread baseline is joined_at), so
-- the change is backward compatible and the ALTER is instant (no table rewrite, no
-- default backfill). IF NOT EXISTS keeps the migration re-runnable.
-- -----------------------------------------------------------------------------

ALTER TABLE cleanup_members
  ADD COLUMN IF NOT EXISTS last_read_at timestamptz;
