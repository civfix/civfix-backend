-- =============================================================================
-- 0093_follows_people_pagination_idx.sql
-- -----------------------------------------------------------------------------
-- FINDING F158: the "following" list (a user's outbound follows) pages by
-- follower_id newest-first with the house keyset cursor. follows_people has
-- PK(follower_id, followee_id) and an index on followee_id ("who follows me"), but
-- NOTHING keyed for (follower_id, created_at DESC) — verified against the schema:
-- the pagination support is genuinely MISSING — so the list sorts at scan time.
-- Add the keyset index; social sorts by display name WITHIN a fetched page (no
-- users(display_name) index — deliberately out of scope).
--
-- CANONICAL DDL: hand-authored source of truth. Mirror: schema/follows.ts.
--
-- Conventions: additive CREATE INDEX IF NOT EXISTS; one transaction per file;
-- non-CONCURRENTLY build accepted (pre-launch, trivial rows). Forward-only, no down.
--
-- Ordering rules: requires 0001_core.sql (follows_people).
-- =============================================================================

CREATE INDEX IF NOT EXISTS follows_people_follower_created_idx
  ON follows_people (follower_id, created_at DESC, followee_id DESC);
