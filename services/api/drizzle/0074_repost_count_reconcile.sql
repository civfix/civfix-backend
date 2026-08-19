-- =============================================================================
-- 0074_repost_count_reconcile.sql
-- -----------------------------------------------------------------------------
-- FINDING F054: posts.repost_count is a denormalized counter bumped in the same
-- txn as the repost insert/delete. With unrepost switching to a SOFT delete
-- (0069) and repost() reviving tombstones, any counter that drifted under the old
-- hard-delete semantics must be reconciled to the live-row truth. One-off
-- backfill mirroring 0066_backfill_post_reply_counts.sql's shape: a repost is a
-- posts row with kind='repost' and deleted_at IS NULL pointing at repost_of_id.
--
-- Runs AFTER 0069 (so "live repost" already means deleted_at IS NULL). Bounded by
-- posts size (trivial pre-launch). Idempotent: a second run updates only rows
-- whose stored count still disagrees, i.e. none.
--
-- CANONICAL DDL: hand-authored source of truth. Data-only, no shape change → no
-- mirror edit.
--
-- Conventions: one transaction per file (src/db/migrate.ts). Forward-only, no down.
--
-- Ordering rules: requires 0069_posts_repost_unique_softdelete.sql.
-- =============================================================================

UPDATE posts p
SET repost_count = c.n
FROM (
  SELECT repost_of_id, count(*)::int AS n
  FROM posts
  WHERE repost_of_id IS NOT NULL AND kind = 'repost' AND deleted_at IS NULL
  GROUP BY repost_of_id
) c
WHERE p.id = c.repost_of_id
  AND p.repost_count <> c.n;

UPDATE posts p
SET repost_count = 0
WHERE p.repost_count <> 0
  AND NOT EXISTS (
    SELECT 1 FROM posts r
    WHERE r.repost_of_id = p.id AND r.kind = 'repost' AND r.deleted_at IS NULL
  );
