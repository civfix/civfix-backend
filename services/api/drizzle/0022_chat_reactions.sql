-- =============================================================================
-- 0022_chat_reactions.sql
-- -----------------------------------------------------------------------------
-- Emoji reactions on CHAT messages: the cleanup group chat (chat_messages) AND
-- 1:1 direct messages (dm_messages). ONE table serves both: a message id is a
-- globally-unique uuid across both message tables, so a (message_id, user_id,
-- emoji) row is unambiguous regardless of which table the message lives in.
--
-- Mirrors report_message_reactions (0017_report_discussion.sql): composite PK
-- (message_id, user_id, emoji) makes a reaction idempotent and the toggle a
-- single DELETE / INSERT. `emoji` stores one of the ASCII reaction enum names
-- (like|heart|celebrate|support|insightful|concerned), NOT a raw glyph; the
-- allowed set is enforced in the application layer (REACTION_EMOJIS).
--
-- IMPORTANT: NO FK TO THE MESSAGE TABLES. chat_messages and dm_messages are
-- DECLARATIVELY PARTITIONED BY RANGE(created_at) with COMPOSITE PKs
-- (id, created_at) (see 0002_chat_partitioning.sql / 0009_dm_and_privacy.sql), so
-- there is no single-column key to reference: a FK on message_id alone is
-- impossible. We therefore use app-level integrity (no FK into the partitioned
-- tables), exactly like nothing else FKs into them. user_id DOES FK to users
-- (a plain uuid PK) with ON DELETE CASCADE so a deleted user's reactions are
-- removed. There is no cascade from a deleted message (it would need a FK); chat
-- messages are soft-deleted (deleted_at) and orphan reaction rows are harmless
-- (the reads aggregate only for a live message id), matching the partitioned-table
-- no-FK convention.
--
-- CANONICAL DDL: this hand-authored SQL is the source of truth. The Drizzle
-- definition under src/db/schema/chat_reactions.ts mirrors it for typed queries /
-- diff inspection only; it is NOT applied to create the database.
--
-- Conventions (match Phase 1/2): timestamptz, additive IF NOT EXISTS so a partial
-- or repeat apply is safe; the migrate runner (src/db/migrate.ts) records applied
-- files and wraps each file in one transaction.
--
-- Ordering rules:
--   * Requires 0001_core.sql (users).
--   * Logically pairs with chat_messages (0002) + dm_messages (0009), but takes
--     no FK on them (see above), so it only hard-requires users.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- chat_message_reactions  (one row = one user's one emoji on one chat/dm message).
-- message_id is a chat_messages.id OR a dm_messages.id (uuids, globally unique);
-- intentionally NOT a foreign key (those tables are partitioned with composite
-- PKs). The composite PK (message_id, user_id, emoji) de-dupes and makes the
-- toggle a single DELETE / INSERT.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS chat_message_reactions (
  message_id uuid        NOT NULL,
  user_id    uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  emoji      text        NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (message_id, user_id, emoji)
);
