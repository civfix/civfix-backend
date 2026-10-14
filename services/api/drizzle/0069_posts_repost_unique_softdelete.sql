-- =============================================================================
-- 0069_posts_repost_unique_softdelete.sql
-- -----------------------------------------------------------------------------
-- FINDING F003 / F148 / F054 (one design): unrepost becomes a SOFT delete
-- (tombstone), not a hard row delete. The original repost-toggle unique index
-- `posts_repost_unique_idx (author_id, repost_of_id) WHERE kind='repost'` (0051)
-- counts tombstoned reposts, so once a user un-reposts (deleted_at set) they can
-- NEVER repost the same target again: the partial unique still matches the dead
-- row. Rebuild it to ignore tombstones: at most one LIVE repost per (author,
-- target). repost() then revives a tombstone via
-- `ON CONFLICT ... DO UPDATE SET deleted_at = NULL` naming this predicate.
--
-- WHY THE REBUILD CANNOT FAIL: the old index already guaranteed at most one
-- repost row per (author_id, repost_of_id); the new predicate is strictly more
-- permissive (a subset: live rows only), so no duplicate can exist to violate it.
--
-- CANONICAL DDL: hand-authored source of truth. Mirror: schema/posts.ts
-- (posts_repost_unique_idx WHERE clause gains `AND deleted_at IS NULL`).
--
-- Conventions: one transaction per file (src/db/migrate.ts); non-CONCURRENTLY
-- index build accepted for this pre-launch release (posts row count trivial,
-- recorded in the delivery report). Forward-only, no down.
--
-- Ordering rules: requires 0051_social_posts.sql.
-- =============================================================================

DROP INDEX IF EXISTS posts_repost_unique_idx;

CREATE UNIQUE INDEX IF NOT EXISTS posts_repost_unique_idx
  ON posts (author_id, repost_of_id)
  WHERE kind = 'repost' AND deleted_at IS NULL;
