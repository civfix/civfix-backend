-- =============================================================================
-- 0045_chat_reply_to.sql
-- -----------------------------------------------------------------------------
-- Quoted replies (D2): a message may quote an earlier message in the same room.
-- reply_to_id holds the quoted message's id; NULL means a plain (non-reply)
-- message.
--
-- NO foreign key: chat_messages is RANGE-partitioned with a composite
-- PK(id, created_at), so there is no single-column key to reference (the quoted
-- row may live in another partition) -- exactly like chat_message_reactions /
-- chat_message_mentions / report_message_forwards. In dm_messages' case the
-- quoted row is another row of the same thread. ids are globally unique uuids
-- and hydration happens app-side by id. App-level integrity holds.
--
-- NO new index: quoted-message hydration is a lookup by bare id, which rides
-- each partition's existing PK index.
--
-- This migration ONLY adds the columns. Nothing reads/writes them yet (the
-- reply plumbing lands in Task 2.3).
--
-- Every statement is idempotent / guarded so re-applying the file is a no-op.
-- =============================================================================

ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS reply_to_id uuid;
ALTER TABLE dm_messages ADD COLUMN IF NOT EXISTS reply_to_id uuid;
