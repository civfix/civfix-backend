-- =============================================================================
-- 0186_follows_people_followee_created_idx.sql
-- -----------------------------------------------------------------------------
-- The followers list pages a user's inbound follows newest-first with the house
-- keyset cursor on (f.created_at, f.follower_id). The only followee-keyed index
-- was follows_people_followee_idx (followee_id), so every page fetched and
-- top-N sorted all of the user's follower edges. This is the followee-keyed
-- twin of 0093: the page becomes an index range that stops at LIMIT + 1.
-- created_at is nullable; a DESC key sorts NULLS FIRST, matching the ORDER BY.
--
-- NOT A HOT TABLE: `follows_people` is absent from the hot-table list in
-- docs/out-of-band-indexes.md, so this builds inline. If it has grown large by
-- the time this deploys, build it with CREATE INDEX CONCURRENTLY first and the
-- IF NOT EXISTS guard turns this into a no-op.
--
-- CANONICAL DDL: hand-authored source of truth. Mirror: schema/follows.ts.
--
-- Conventions: one concern per file; one transaction per file. Forward-only,
-- no down.
--
-- Ordering rules: requires 0001_core.sql (follows_people).
-- =============================================================================

CREATE INDEX IF NOT EXISTS follows_people_followee_created_idx
  ON follows_people (followee_id, created_at DESC, follower_id DESC);
