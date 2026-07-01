-- =============================================================================
-- 0036_report_chat.sql
-- -----------------------------------------------------------------------------
-- Report group chat: extend the partitioned chat_messages table with a SECOND
-- scope. A chat row now belongs to EITHER a cleanup (the existing group chat) OR
-- a report (the new telegram-style report chat that replaces the REST
-- report-discussion). Exactly one of (cleanup_id, report_id) is set.
--
-- This DEPRECATES report_discussion_messages (kept, NOT dropped, for rollback
-- safety); its non-deleted, human-authored rows are flattened into chat_messages
-- below so history survives the cutover.
--
-- Every statement is idempotent / guarded so re-applying the file is a no-op.
-- =============================================================================

-- New report scope. Nullable (a cleanup row leaves it NULL). Add the column and its
-- foreign key SEPARATELY, each guarded, so re-apply is a no-op and the FK add is
-- unambiguous on the partitioned parent (FKs FROM a partitioned table -> a normal
-- table are supported on PG 11+; the box is PG 16).
ALTER TABLE chat_messages
  ADD COLUMN IF NOT EXISTS report_id uuid;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chat_messages_report_id_fkey'
  ) THEN
    ALTER TABLE chat_messages
      ADD CONSTRAINT chat_messages_report_id_fkey
      FOREIGN KEY (report_id) REFERENCES reports (id);
  END IF;
END $$;

-- cleanup_id is no longer mandatory: a report row leaves it NULL.
ALTER TABLE chat_messages
  ALTER COLUMN cleanup_id DROP NOT NULL;

-- Exactly-one-of scope: (cleanup_id XOR report_id). Every existing cleanup row has
-- cleanup_id set + report_id NULL -> (false <> true) = true -> already satisfied,
-- so adding the constraint validates cleanly. Guarded so re-apply is a no-op (a
-- partitioned parent has no ADD CONSTRAINT IF NOT EXISTS).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chat_messages_scope_chk'
  ) THEN
    ALTER TABLE chat_messages
      ADD CONSTRAINT chat_messages_scope_chk
      CHECK ((cleanup_id IS NULL) <> (report_id IS NULL));
  END IF;
END $$;

-- Report-scoped history pagination (newest-first within a report). Declared on the
-- partitioned parent so it propagates to every current and future partition.
CREATE INDEX IF NOT EXISTS chat_messages_report_created_idx
  ON chat_messages (report_id, created_at DESC);

-- Data migration: flatten the deprecated report_discussion_messages into report
-- chat. Copy only NON-deleted, human-authored rows (skip system/null-author +
-- soft-deleted), preserving id + created_at so identity is stable. Replies lose
-- their threading (chat is flat) but keep their content. ON CONFLICT DO NOTHING
-- keys on the (id, created_at) PK so a re-run inserts nothing.
INSERT INTO chat_messages (id, report_id, sender_id, body, kind, created_at)
SELECT id, report_id, author_user_id, body, 'text', created_at
FROM report_discussion_messages
WHERE deleted_at IS NULL
  AND author_user_id IS NOT NULL
ON CONFLICT DO NOTHING;
