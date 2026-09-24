-- =============================================================================
-- 0070_posts_reply_to_fk_idx.sql
-- -----------------------------------------------------------------------------
-- FINDING F151: posts.reply_to_id is a self-FK (posts→posts) but the only index
-- covering it was `posts_reply_to_idx (reply_to_id, created_at) WHERE deleted_at
-- IS NULL` (0051), a PARTIAL index that excludes tombstoned rows. Postgres uses
-- an index to enforce/scan an ON DELETE FK action only when it covers ALL rows,
-- so the delete-time lookup for reply_to_id children (and the F148 RESTRICT swap
-- in 0072) has no usable index and does a sequential scan of posts. Add a plain
-- partial-on-NOT-NULL index that covers every reply row regardless of deleted_at.
--
-- CANONICAL DDL: hand-authored source of truth. Mirror: schema/posts.ts.
--
-- Conventions: one transaction per file; non-CONCURRENTLY build accepted
-- (pre-launch, trivial rows). Forward-only, no down.
--
-- Ordering rules: requires 0051_social_posts.sql.
-- =============================================================================

CREATE INDEX IF NOT EXISTS posts_reply_to_fk_idx
  ON posts (reply_to_id)
  WHERE reply_to_id IS NOT NULL;
