-- =============================================================================
-- 0046_chat_pins.sql
-- -----------------------------------------------------------------------------
-- Message pinning (P3): any message in any room may be pinned. A room can hold
-- MULTIPLE pins at once, so pin state lives ON the message row: pinned_at is
-- both the flag (NULL = not pinned) and the sort key for the room's pin list;
-- pinned_by records who pinned it (audit + "Pinned by X" copy).
--
-- NO foreign key on pinned_by: chat_messages is RANGE-partitioned (composite
-- PK(id, created_at)) and we keep the two mirrors' column shapes identical,
-- same stance as reply_to_id in 0045. App-level integrity holds (the pin route
-- only ever writes the authed user's id).
--
-- PARTIAL indexes keep the per-room "list pins" query cheap: pinned rows are a
-- tiny fraction of a room's messages, so a full (room, pinned_at) index would
-- be almost entirely dead weight; the WHERE pinned_at IS NOT NULL predicate
-- indexes only the pins. On the partitioned chat_messages parent, CREATE INDEX
-- cascades to every partition (and attaches to future ones); partial NON-unique
-- indexes are legal on partitioned tables (only unique indexes must embed the
-- partition key). The testcontainers bootstrap proves this on a real postgres.
-- A group_id pinned index for group chats ships with the groups migration
-- (0047), not here.
--
-- Nothing reads/writes these columns yet (pin routes land in Task 3.4).
--
-- Every statement is idempotent / guarded so re-applying the file is a no-op.
-- =============================================================================

ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS pinned_at timestamptz;
ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS pinned_by uuid;

ALTER TABLE dm_messages ADD COLUMN IF NOT EXISTS pinned_at timestamptz;
ALTER TABLE dm_messages ADD COLUMN IF NOT EXISTS pinned_by uuid;

CREATE INDEX IF NOT EXISTS chat_messages_cleanup_pinned_idx
  ON chat_messages (cleanup_id, pinned_at DESC)
  WHERE pinned_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS chat_messages_report_pinned_idx
  ON chat_messages (report_id, pinned_at DESC)
  WHERE pinned_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS dm_messages_thread_pinned_idx
  ON dm_messages (thread_id, pinned_at DESC)
  WHERE pinned_at IS NOT NULL;
