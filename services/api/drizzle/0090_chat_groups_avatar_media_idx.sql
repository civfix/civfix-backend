-- =============================================================================
-- 0090_chat_groups_avatar_media_idx.sql
-- -----------------------------------------------------------------------------
-- FINDING F002: chat_groups.avatar_media_id is an FK to media_assets, and the
-- media orphan-reaper (media-worker findOrphans) checks whether an asset is still
-- referenced as a group avatar. With no index on avatar_media_id that check does a
-- sequential scan of chat_groups per candidate asset. Add a partial index over the
-- non-null avatar references. (mw fixes the stale findOrphans comment — its half.)
--
-- CANONICAL DDL: hand-authored source of truth. Mirror: schema/chat-groups.ts.
--
-- Conventions: additive CREATE INDEX IF NOT EXISTS; one transaction per file;
-- non-CONCURRENTLY build accepted (pre-launch, trivial rows). Forward-only, no down.
--
-- Ordering rules: requires 0047_chat_groups.sql (chat_groups).
-- =============================================================================

CREATE INDEX IF NOT EXISTS chat_groups_avatar_media_idx
  ON chat_groups (avatar_media_id)
  WHERE avatar_media_id IS NOT NULL;
