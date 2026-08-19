-- =============================================================================
-- 0076_media_single_claim_check.sql
-- -----------------------------------------------------------------------------
-- FINDING F017 / F049: a media asset is meant to belong to at most ONE subject —
-- a report (report_id), a chat/dm message (chat_message_id), or a social post
-- (post_id). Nothing at the DB level stopped an asset from being claimed by two
-- lanes at once, which would let one upload leak across authorization domains.
-- Add a CHECK that at most one of the three binding columns is non-null.
--
-- NOTE — NOT A TOTAL INVARIANT: the avatar/profile-media lane stamps NONE of these
-- columns (an avatar is referenced from users.avatar_media_id / chat_groups.
-- avatar_media_id, not by a back-pointer here), so num_nonnulls = 0 is legitimate
-- and the CHECK only forbids a DOUBLE binding, not "unbound". It is a
-- cross-lane-exclusivity guard, not a "every asset is claimed" guarantee.
--
-- NOT VALID is mandatory here: the runner is one-transaction-per-file with no down
-- migration, so validating against the full table inside the deploy txn would risk
-- a long lock; 0077 validates separately. On pre-launch volumes both are trivial.
--
-- CANONICAL DDL: hand-authored source of truth. A CHECK constraint is not modeled
-- in the Drizzle mirror (schema/media.ts) — documented there as a NOTE for parity.
--
-- Conventions: guarded ADD CONSTRAINT so a repeat apply is a no-op; one
-- transaction per file (src/db/migrate.ts). Forward-only, no down.
--
-- Ordering rules: requires 0051_social_posts.sql (media_assets.post_id) and
-- 0025_chat_message_media.sql (media_assets.chat_message_id).
-- =============================================================================

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'media_single_claim_chk' AND conrelid = 'media_assets'::regclass
  ) THEN
    ALTER TABLE media_assets
      ADD CONSTRAINT media_single_claim_chk
      CHECK (num_nonnulls(report_id, chat_message_id, post_id) <= 1) NOT VALID;
  END IF;
END $$;
