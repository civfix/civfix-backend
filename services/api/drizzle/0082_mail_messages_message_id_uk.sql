-- =============================================================================
-- 0082_mail_messages_message_id_uk.sql
-- -----------------------------------------------------------------------------
-- FINDING F102 (uniqueness half). Make the RFC Message-ID a DB invariant so a
-- redelivered inbound reply cannot duplicate a mail_messages row. adminmail's
-- insert switches to `ON CONFLICT (message_id) WHERE message_id IS NOT NULL DO
-- NOTHING RETURNING id` naming this partial unique index. Partial on
-- message_id IS NOT NULL because outbound rows may legitimately share a NULL id.
-- Runs AFTER 0081's dedupe so the build cannot fail on pre-existing duplicates.
--
-- Note: the existing NON-unique `mail_messages_message_id_idx (message_id) WHERE
-- message_id IS NOT NULL` (schema/mail.ts) stays; it is a redundant prefix of
-- this unique index but dropping it is a needless lock; noted for a future pass.
--
-- CANONICAL DDL: hand-authored source of truth. Mirror: schema/mail.ts.
--
-- Conventions: additive CREATE UNIQUE INDEX IF NOT EXISTS; one transaction per
-- file; non-CONCURRENTLY build accepted (pre-launch, trivial rows). Forward-only.
--
-- Ordering rules: requires 0081_mail_messages_dedupe.sql.
-- =============================================================================

CREATE UNIQUE INDEX IF NOT EXISTS mail_messages_message_id_uk
  ON mail_messages (message_id)
  WHERE message_id IS NOT NULL;
