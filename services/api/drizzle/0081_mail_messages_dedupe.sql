-- =============================================================================
-- 0081_mail_messages_dedupe.sql
-- -----------------------------------------------------------------------------
-- FINDING F102 (dedupe half). An inbound reply webhook can be delivered more than
-- once (at-least-once), and mail_messages has no uniqueness on the RFC Message-ID,
-- so a redelivery inserts a duplicate message into the thread. Before adding the
-- partial UNIQUE index (0082) we must collapse any pre-existing duplicate
-- (message_id) rows, keeping the earliest (oldest created_at, then least id), or
-- the unique build would fail. This dedupe lives in a SEPARATE file BEFORE the
-- index so an index-build failure can never strand a half-applied file.
--
-- Only non-null message_id rows are deduped (the index is partial on message_id
-- IS NOT NULL; outbound rows without a Message-ID are untouched). created_at is
-- NOT NULL on mail_messages so a plain row-value comparison is safe here. On a
-- fresh DB this DELETE matches nothing.
--
-- CANONICAL DDL: hand-authored source of truth. Data-only → no mirror edit.
--
-- Conventions: one transaction per file (src/db/migrate.ts). Forward-only, no down.
--
-- Ordering rules: requires 0007_admin_phase2.sql (mail_messages).
-- =============================================================================

DELETE FROM mail_messages a
USING mail_messages b
WHERE a.message_id IS NOT NULL
  AND b.message_id IS NOT NULL
  AND a.message_id = b.message_id
  AND (a.created_at, a.id) > (b.created_at, b.id);
