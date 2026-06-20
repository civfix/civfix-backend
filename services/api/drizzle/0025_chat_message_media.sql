-- -----------------------------------------------------------------------------
-- 0025_chat_message_media
--
-- Attach media (image/video) to a cleanup-chat OR direct-message message, reusing
-- the SHARED media_assets table (the same intake/finalize/EXIF-strip pipeline as
-- report + discussion attachments). A message claims its uploads by stamping
-- media_assets.chat_message_id; the read path serves only status='ready' rows.
--
-- WHY A BARE uuid COLUMN (no foreign key), unlike media_assets.discussion_message_id
-- (0017, a real FK to report_discussion_messages.id):
--   chat_messages (0002) and dm_messages (0009) are DECLARATIVELY PARTITIONED BY
--   RANGE(created_at) with a COMPOSITE PK(id, created_at). There is no single-column
--   key to FOREIGN KEY against, so - exactly like chat_message_reactions (0022) and
--   chat_message_mentions (0023) - this column carries the message id with NO FK and
--   relies on app-level integrity. ONE column serves BOTH room kinds: a cleanup-chat
--   id and a dm id are both globally-unique uuids, and every read is scoped to a
--   single message id, so the two id spaces never collide.
--
-- Additive sibling of report_id / discussion_message_id. There is no ON DELETE policy
-- to mirror (no FK): messages soft-delete (deleted_at) and a tombstoned message serves
-- zero attachments, so nothing needs to cascade. Do NOT overload report_id /
-- discussion_message_id - a chat attachment belongs to its message.
--
-- Mirrors the Drizzle definition in src/db/schema/media.ts (chatMessageId +
-- media_assets_chat_message_idx). Idempotent (ADD COLUMN / CREATE INDEX IF NOT EXISTS).
-- -----------------------------------------------------------------------------

ALTER TABLE media_assets
  ADD COLUMN IF NOT EXISTS chat_message_id uuid;

CREATE INDEX IF NOT EXISTS media_assets_chat_message_idx
  ON media_assets (chat_message_id);
