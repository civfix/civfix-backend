-- =============================================================================
-- 0054_media_purpose_post.sql
-- -----------------------------------------------------------------------------
-- BUG (audit 2026-07-24): creating a post WITH media always failed.
--
-- 0016_user_verification.sql added media_assets.purpose with an inline
-- CHECK (purpose IN ('report','verification')). 0051_social_posts.sql introduced
-- the THIRD value 'post' everywhere EXCEPT that CHECK: the mirror
-- (src/db/schema/types.ts MEDIA_PURPOSE_VALUES), the shared enum, and the claim
-- path (post-repository.drizzle.ts createPost: UPDATE media_assets SET post_id =
-- $1, purpose = 'post') all carry it, so every createPost with mediaUploadIds
-- raised 23514 and aborted the create transaction -> 500.
--
-- Drop + re-add the widened CHECK, the same pattern as the earlier value-set
-- widenings 0024_content_reports_widen_moderation.sql (moderation_items kind /
-- subject_type) and 0029_mail_event_failed.sql (mail_events type).
--
-- `media_assets_purpose_check` is Postgres's default name for the unnamed inline
-- column CHECK 0016 added. DROP ... IF EXISTS keeps a partial or repeat apply
-- safe (the migrate runner wraps each file in one transaction).
--
-- Ordering rules: requires 0016_user_verification.sql (the purpose column).
-- Forward-only: there is no down migration in this suite.
-- =============================================================================

ALTER TABLE media_assets
  DROP CONSTRAINT IF EXISTS media_assets_purpose_check;

ALTER TABLE media_assets
  ADD CONSTRAINT media_assets_purpose_check
  CHECK (purpose IN ('report', 'verification', 'post'));
