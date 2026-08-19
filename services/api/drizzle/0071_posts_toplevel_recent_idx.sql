-- =============================================================================
-- 0071_posts_toplevel_recent_idx.sql
-- -----------------------------------------------------------------------------
-- FINDING F013: the home/public feed pages TOP-LEVEL posts (replies excluded)
-- newest-first with the house keyset cursor (created_at DESC, id DESC). The
-- existing `posts_public_recent_idx (created_at DESC) WHERE deleted_at IS NULL
-- AND visibility='public'` (0051) is visibility-scoped and lacks the id tiebreak,
-- so the reply-excluding home feed falls back to a sort. Add a partial index keyed
-- for the exact cursor over live top-level rows. Deliberately NOT visibility-
-- filtered so the authenticated home feed (which mixes visibilities) shares it;
-- the public feed adds `visibility='public'` in its own WHERE (social's half).
--
-- CANONICAL DDL: hand-authored source of truth. Mirror: schema/posts.ts.
--
-- Conventions: one transaction per file; non-CONCURRENTLY build accepted
-- (pre-launch, trivial rows). Forward-only, no down.
--
-- Ordering rules: requires 0051_social_posts.sql.
-- =============================================================================

CREATE INDEX IF NOT EXISTS posts_toplevel_recent_idx
  ON posts (created_at DESC, id DESC)
  WHERE deleted_at IS NULL AND reply_to_id IS NULL;
