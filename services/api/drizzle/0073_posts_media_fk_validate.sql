-- =============================================================================
-- 0073_posts_media_fk_validate.sql
-- -----------------------------------------------------------------------------
-- FINDING F148 (validation half). 0072 added the four swapped FKs as NOT VALID so
-- the deploy transaction never blocked on a full-table validation scan. Validate
-- them here, in a SEPARATE file, so a slow VALIDATE can't strand 0072 mid-apply
-- (each file is its own transaction + bookkeeping row). Trivial on pre-launch
-- volumes. Guarded so re-running (or running before 0072 on a partial history) is
-- a no-op rather than an error; VALIDATE has no IF EXISTS of its own.
--
-- CANONICAL DDL: hand-authored source of truth. No shape change → no mirror edit
-- beyond 0072's onDelete hints.
--
-- Conventions: one transaction per file (src/db/migrate.ts). Forward-only, no down.
--
-- Ordering rules: requires 0072_posts_media_fk_swap.sql.
-- =============================================================================

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'posts_reply_to_id_fk') THEN
    ALTER TABLE posts VALIDATE CONSTRAINT posts_reply_to_id_fk;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'posts_thread_root_id_fk') THEN
    ALTER TABLE posts VALIDATE CONSTRAINT posts_thread_root_id_fk;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'posts_repost_of_id_fk') THEN
    ALTER TABLE posts VALIDATE CONSTRAINT posts_repost_of_id_fk;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'media_assets_post_id_fk') THEN
    ALTER TABLE media_assets VALIDATE CONSTRAINT media_assets_post_id_fk;
  END IF;
END $$;
