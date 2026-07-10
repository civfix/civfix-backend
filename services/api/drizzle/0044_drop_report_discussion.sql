-- =============================================================================
-- 0044_drop_report_discussion.sql
-- -----------------------------------------------------------------------------
-- Remove the deprecated per-report DISCUSSION system. Report chat (the group-chat
-- surface introduced in 0036/0041/0042/0043) replaced it end-to-end, so the
-- discussion comment tables, the report-follow subscription table, and the
-- media_assets.discussion_message_id attachment column are all dead.
--
-- Tables dropped (created in 0017_report_discussion.sql + 0023_message_mentions.sql):
--   report_message_user_mentions  -- user @-mentions in a discussion message
--                                     (FK -> report_discussion_messages ON DELETE CASCADE)
--   report_message_mentions       -- jurisdiction/@city mention on a discussion message
--                                     (FK -> report_discussion_messages ON DELETE CASCADE)
--   report_message_reactions      -- emoji reactions on a discussion message
--                                     (FK -> report_discussion_messages ON DELETE CASCADE)
--   report_discussion_messages    -- the discussion comments/replies themselves
--   report_follows                -- per-report notify-me subscriptions
--
-- Column dropped:
--   media_assets.discussion_message_id  -- attached a media asset to a discussion
--                                          message (FK -> report_discussion_messages
--                                          ON DELETE SET NULL, added in 0017)
--
-- ORDER MATTERS: the three child tables (and the media column's FK) reference
-- report_discussion_messages, so they are dropped BEFORE the parent. Every
-- statement is guarded with IF EXISTS, so re-applying the file is a no-op.
-- =============================================================================

-- The @city/@user mention + reaction children FK report_discussion_messages; drop
-- them first so the parent drop does not trip a dependent-object error.
DROP TABLE IF EXISTS report_message_user_mentions;
DROP TABLE IF EXISTS report_message_mentions;
DROP TABLE IF EXISTS report_message_reactions;

-- media_assets.discussion_message_id FK'd report_discussion_messages; drop the
-- column (its index goes with it) before the parent table. Idempotent.
ALTER TABLE media_assets DROP COLUMN IF EXISTS discussion_message_id;

-- The discussion messages themselves (parent of the children dropped above).
DROP TABLE IF EXISTS report_discussion_messages;

-- Per-report notify-me subscriptions (independent of the discussion tables).
DROP TABLE IF EXISTS report_follows;
