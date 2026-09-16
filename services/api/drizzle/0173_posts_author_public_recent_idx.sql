-- =============================================================================
-- 0173_posts_author_public_recent_idx.sql
-- -----------------------------------------------------------------------------
-- ISSUE #100 (ranked home feed): the ranked feed's in-network candidate pool
-- selects top-level PUBLIC posts by the viewer plus everyone the viewer
-- follows, newest-first, bounded by LIMIT.
--
-- Neither existing index serves that shape:
--   posts_author_created_idx (0051)  - author + created_at, but not partial on
--                                      reply_to_id / visibility, and no id tiebreak
--   posts_toplevel_recent_idx (0071) - the right ordering, but not author-keyed,
--                                      so an author-scoped pool scans it whole
--
-- This is the author-keyed twin of 0071: the same live top-level keyset,
-- narrowed to public rows and led by author_id so the IN (followees) probe stops
-- at the pool LIMIT instead of sorting.
--
-- NOT A HOT TABLE: `posts` is absent from the hot-table list in
-- docs/out-of-band-indexes.md, so this builds inline. If `posts` has grown large
-- by the time this deploys, build it with CREATE INDEX CONCURRENTLY first and
-- the IF NOT EXISTS guard turns this into a no-op.
--
-- CANONICAL DDL: hand-authored source of truth. Mirror: schema/posts.ts.
--
-- Conventions: one concern per file; one transaction per file. Forward-only,
-- no down.
--
-- Ordering rules: requires 0051_social_posts.sql.
-- =============================================================================

CREATE INDEX IF NOT EXISTS posts_author_public_recent_idx
  ON posts (author_id, created_at DESC, id DESC)
  WHERE deleted_at IS NULL AND reply_to_id IS NULL AND visibility = 'public';
