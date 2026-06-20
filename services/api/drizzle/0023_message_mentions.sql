-- =============================================================================
-- 0023_message_mentions.sql
-- -----------------------------------------------------------------------------
-- User @-mentions in BOTH the per-report discussion (report_discussion_messages)
-- AND chat messages (the cleanup group chat + 1:1 DMs). Tagging a user by @handle
-- records a row here; the application notifies the tagged user (gated by blocks +
-- notification prefs). This is SEPARATE from the existing jurisdiction/city
-- @mention path (report_message_mentions, 0017), which forwards a message to the
-- responsible authority and is keyed by geoid, not user.
--
-- TWO tables (one per message family), mirroring the reactions split (0017 +
-- 0022) so each family's mentions live next to the messages they reference:
--
--   * report_message_user_mentions: a user @-mentioned in a DISCUSSION message.
--     message_id FKs report_discussion_messages (a plain uuid PK) ON DELETE
--     CASCADE, parallel to report_message_reactions. Composite PK
--     (message_id, mentioned_user_id) de-dupes a user named twice in one message.
--
--   * chat_message_mentions: a user @-mentioned in a CHAT message — the cleanup
--     group chat (chat_messages) OR a 1:1 DM (dm_messages). ONE table serves both
--     because a message id is a globally-unique uuid across both message tables,
--     exactly like chat_message_reactions (0022).
--
-- IMPORTANT — NO FK on chat_message_mentions.message_id. chat_messages and
-- dm_messages are DECLARATIVELY PARTITIONED BY RANGE(created_at) with COMPOSITE
-- PKs (id, created_at) (0002_chat_partitioning.sql / 0009_dm_and_privacy.sql), so
-- there is no single-column key to reference: a FK on message_id alone is
-- impossible. App-level integrity holds (nothing else FKs into those tables).
-- mentioned_user_id DOES FK to users (a plain uuid PK) ON DELETE CASCADE in BOTH
-- tables so a deleted user's mention rows are removed. report_message_user_mentions
-- additionally cascades from its discussion message.
--
-- CANONICAL DDL: this hand-authored SQL is the source of truth. The Drizzle
-- definitions under src/db/schema/message_mentions.ts mirror it for typed queries
-- / diff inspection only; they are NOT applied to create the database.
--
-- Conventions (match Phase 1/2): timestamptz, additive IF NOT EXISTS so a partial
-- or repeat apply is safe; the migrate runner (src/db/migrate.ts) records applied
-- files and wraps each file in one transaction.
--
-- Ordering rules:
--   * Requires 0001_core.sql (users).
--   * report_message_user_mentions requires 0017_report_discussion.sql
--     (report_discussion_messages).
--   * chat_message_mentions logically pairs with chat_messages (0002) +
--     dm_messages (0009) but takes no FK on them (see above), so it only hard-
--     requires users.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- report_message_user_mentions  (one row = one user @-mentioned in one discussion
-- message). message_id FKs the (non-partitioned) report_discussion_messages so a
-- deleted/cascaded message drops its mention rows. The composite PK de-dupes a
-- user named more than once in the same message. Parallel to
-- report_message_mentions (the city/geoid mention), but keyed by user.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS report_message_user_mentions (
  message_id        uuid NOT NULL REFERENCES report_discussion_messages (id) ON DELETE CASCADE,
  mentioned_user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  PRIMARY KEY (message_id, mentioned_user_id)
);

-- Reverse lookup: "messages that mention this user" (used by future mention feeds
-- + keeps the FK delete fast).
CREATE INDEX IF NOT EXISTS report_message_user_mentions_user_idx
  ON report_message_user_mentions (mentioned_user_id);

-- -----------------------------------------------------------------------------
-- chat_message_mentions  (one row = one user @-mentioned in one chat/dm message).
-- message_id is a chat_messages.id OR a dm_messages.id (uuids, globally unique);
-- intentionally NOT a foreign key (those tables are partitioned with composite
-- PKs). The composite PK (message_id, mentioned_user_id) de-dupes a user named
-- twice in the same message.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS chat_message_mentions (
  message_id        uuid NOT NULL,
  mentioned_user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  PRIMARY KEY (message_id, mentioned_user_id)
);

-- Reverse lookup: "chat/dm messages that mention this user".
CREATE INDEX IF NOT EXISTS chat_message_mentions_user_idx
  ON chat_message_mentions (mentioned_user_id);
