-- =============================================================================
-- 0042_conversation_mutes.sql
-- -----------------------------------------------------------------------------
-- Task D-B2: per-user, per-conversation mute. A user can mute notifications for
-- a single room (cleanup group chat, a DM thread, or a report chat) without
-- leaving/muting globally. room_kind + room_id together identify the room;
-- room_id is NOT a foreign key because it points into whichever table
-- room_kind selects (cleanups.id | dm_threads.id | reports.id) -- app-level
-- integrity, same reasoning as the no-FK message_id columns in
-- chat_message_reactions / chat_message_mentions / report_message_forwards.
--
-- Composite PK(user_id, room_kind, room_id) means a user mutes a given room at
-- most once; muting again is idempotent (upsert at the app layer).
--
-- This migration ONLY defines the table. Nothing reads/writes it yet (the mute
-- repo lands in D-E1).
--
-- Every statement is idempotent / guarded so re-applying the file is a no-op.
-- =============================================================================

CREATE TABLE IF NOT EXISTS conversation_mutes (
  user_id   uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  room_kind text NOT NULL,            -- 'cleanup' | 'dm' | 'report'
  room_id   uuid NOT NULL,
  muted_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, room_kind, room_id)
);
