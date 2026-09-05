-- =============================================================================
-- 0104_conversation_hides.sql
-- -----------------------------------------------------------------------------
-- Per-user, per-conversation HIDE: "Delete" on an inbox row removes the thread
-- from THAT user's list only. Nothing is deleted -- the room, its messages and
-- every other participant's inbox are untouched, which is also what the privacy
-- posture requires (chat deletes are tombstones, never cascades).
--
-- Shape mirrors conversation_mutes (0042) exactly: room_kind + room_id identify
-- the room, room_id is NOT a foreign key because it points into whichever table
-- room_kind selects (cleanups.id | dm_threads.id | reports.id | chat_groups.id),
-- and the composite PK means a user hides a given room at most once.
--
-- hidden_at is the WATERMARK, not a flag: the threads list drops a room whose
-- latest activity is at or before the stored instant, so a message that arrives
-- after the hide resurfaces the thread with no write on the send path.
--
-- Not a hot table (one row per user per hidden conversation) and the composite
-- PK index is the only access path the list query needs
-- (user_id = $1 AND room_kind = $2 AND room_id = ANY($3)), so no extra index.
--
-- CANONICAL DDL: hand-authored source of truth. Mirror: schema/conversation_hides.ts.
--
-- Every statement is idempotent so re-applying the file is a no-op. Forward-only,
-- no down. Ordering rules: requires 0001_core.sql (users).
-- =============================================================================

CREATE TABLE IF NOT EXISTS conversation_hides (
  user_id   uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  room_kind text NOT NULL,
  room_id   uuid NOT NULL,
  hidden_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, room_kind, room_id)
);

COMMENT ON COLUMN conversation_hides.hidden_at IS
  'When the viewer hid this conversation. A watermark, not a flag: the threads list hides the room only while its latest activity is at or before this instant, so new messages resurface it.';
