-- =============================================================================
-- 0075_media_chat_created_at.sql
-- -----------------------------------------------------------------------------
-- FINDING F072: media_assets.chat_message_id carries the id of a chat/dm message
-- an attachment belongs to, but those message tables are RANGE-partitioned with a
-- COMPOSITE PK (id, created_at) — the id alone is not a key, so an authorization
-- probe that resolves an attachment to its message cannot prune to a partition and
-- has no unique target. Add the partition key alongside the id so a NEW attachment
-- records (chat_message_id, chat_message_created_at) and the probe can match the
-- full composite key. Nullable with NO backfill: pre-existing attachments keep a
-- NULL here and mediaapi's probe predicate is NULL-tolerant
-- (`AND ($2::timestamptz IS NULL OR created_at = $2)`) so they keep authorizing.
--
-- CANONICAL DDL: hand-authored source of truth. Mirror: schema/media.ts.
--
-- Conventions: additive ADD COLUMN IF NOT EXISTS; one transaction per file
-- (src/db/migrate.ts). Forward-only, no down.
--
-- Ordering rules: requires 0025_chat_message_media.sql (media_assets.chat_message_id).
-- =============================================================================

ALTER TABLE media_assets
  ADD COLUMN IF NOT EXISTS chat_message_created_at timestamptz;
