-- =============================================================================
-- 0176_posts_geom.sql
-- -----------------------------------------------------------------------------
-- ISSUE #100 (ranked home feed): the ranker scores a "nearby" term, but `posts`
-- carried no geometry at all. A post's only location was indirect (through
-- posts.report_id -> reports.geom or posts.event_id -> cleanups.geom), so a
-- proximity pool would need two joins and could not use a KNN order at all.
--
-- This denormalises that point onto the post row so the nearby candidate pool
-- is ONE bounded GIST/KNN scan (see feedCandidates in
-- services/post-repository.drizzle.ts). NULL for a post with no attachment.
--
-- NOT A HOT TABLE: `posts` is absent from the hot-table list in
-- docs/out-of-band-indexes.md (users, reports, chat_messages, dm_messages,
-- media_assets, notifications, sessions), so the partial GIST is built inline
-- here rather than out of band. If `posts` has grown large by the time this
-- deploys, build it with CREATE INDEX CONCURRENTLY first; the IF NOT EXISTS
-- guard below then turns this statement into a no-op.
--
-- NO BACKFILL HERE: one UPDATE over the whole table inside this file's single
-- transaction is a lock hazard. Existing rows are populated after the deploy is
-- healthy by `pnpm db:backfill:post-geom` (src/db/backfill-post-geom.ts), which
-- is keyset-paged, idempotent and safe to run while the API serves traffic. The
-- DO block raises a WARNING while rows remain unpopulated so a forgotten
-- backfill is loud instead of silent; the feed is correct without it, those
-- posts simply score no proximity term.
--
-- PRIVACY: no new class of data. The value is a copy of a coordinate this
-- platform already publishes at full precision on the linked report or event
-- DTO. It is never populated from a client-supplied coordinate, carries no
-- EXIF, and is never returned to any client; it only orders the feed. Any
-- future location-coarsening decision must cover this column too
-- (docs/location-coarsening-assessment.md).
--
-- CANONICAL DDL: hand-authored source of truth. Mirror: schema/posts.ts.
--
-- Conventions: additive ADD COLUMN IF NOT EXISTS; one concern per file; one
-- transaction per file. Forward-only, no down.
--
-- Ordering rules: requires 0051_social_posts.sql (posts).
-- =============================================================================

ALTER TABLE posts ADD COLUMN IF NOT EXISTS geom geometry(Point, 4326);

COMMENT ON COLUMN posts.geom IS
  'Denormalised from the linked report or event at insert time; NULL for a post with no attachment. Feed-ranking proximity only - never a user-supplied coordinate, never served to clients. Backfill: pnpm db:backfill:post-geom.';

CREATE INDEX IF NOT EXISTS posts_geom_gist
  ON posts USING gist (geom)
  WHERE geom IS NOT NULL AND deleted_at IS NULL AND reply_to_id IS NULL AND visibility = 'public';

DO $$
BEGIN
  PERFORM 1
  FROM posts p
  LEFT JOIN reports r ON r.id = p.report_id
  LEFT JOIN cleanups c ON c.id = p.event_id
  WHERE p.geom IS NULL AND COALESCE(r.geom, c.geom) IS NOT NULL
  LIMIT 1;

  IF FOUND THEN
    RAISE WARNING 'posts.geom is unpopulated for at least one attached post - run pnpm db:backfill:post-geom after this deploy is healthy; those posts score no feed proximity term until then';
  END IF;
END $$;
