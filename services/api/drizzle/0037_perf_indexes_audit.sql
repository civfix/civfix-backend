-- =============================================================================
-- 0037_perf_indexes_audit.sql
-- -----------------------------------------------------------------------------
-- Missing-index remediation from the backend audit. Adds the FK-child, keyset,
-- and trigram indexes that back hot query / referential-action / GDPR-export
-- paths which today fall back to a Seq Scan.
--
-- Follows the established convention (see 0013/0014 headers): a NEW file (applied
-- migrations are immutable), plain CREATE INDEX IF NOT EXISTS (idempotent; no
-- CONCURRENTLY, matching the rest of the set on these tables). The btree/FK/keyset
-- indexes below are mirrored in the Drizzle schema under src/db/schema; the GIN
-- trigram indexes are raw-SQL-only and intentionally NOT mirrored (gin_trgm_ops
-- opclass form, per the 0014 convention documented in reports.ts/audit.ts).
-- =============================================================================

-- F22: media_assets.r2_key: orphan-sweep probes referenced-by-others by r2_key.
CREATE INDEX IF NOT EXISTS media_assets_r2_key_idx
  ON media_assets (r2_key);

-- F50: media_assets.chat_message_id: the column is NULL for the vast majority of
-- rows (only chat-attached media set it), so make the existing index PARTIAL.
DROP INDEX IF EXISTS media_assets_chat_message_idx;
CREATE INDEX IF NOT EXISTS media_assets_chat_message_idx
  ON media_assets (chat_message_id)
  WHERE chat_message_id IS NOT NULL;

-- F42: audit_log.action / .target: the operator audit view filters by infix
-- ILIKE, which the plain btree audit_log_action_idx cannot serve. Trigram GIN
-- makes the substring search index-assisted (pg_trgm enabled in 0014).
CREATE INDEX IF NOT EXISTS audit_log_action_trgm_idx
  ON audit_log USING gin (action gin_trgm_ops);
CREATE INDEX IF NOT EXISTS audit_log_target_trgm_idx
  ON audit_log USING gin (target gin_trgm_ops)
  WHERE target IS NOT NULL;

-- F63: reports.addr: public report search ILIKEs the street address.
CREATE INDEX IF NOT EXISTS reports_addr_trgm_idx
  ON reports USING gin (addr gin_trgm_ops)
  WHERE addr IS NOT NULL;

-- F47: FK-child columns with ON DELETE CASCADE / hard-delete but no covering
-- index (a user/geoid delete would seq-scan these tables per referencing row).
CREATE INDEX IF NOT EXISTS report_message_reactions_user_idx
  ON report_message_reactions (user_id);
CREATE INDEX IF NOT EXISTS report_message_mentions_geoid_idx
  ON report_message_mentions (geoid);
CREATE INDEX IF NOT EXISTS users_avatar_media_idx
  ON users (avatar_media_id)
  WHERE avatar_media_id IS NOT NULL;

-- F49: chat_message_reactions.user_id: ON DELETE CASCADE FK, no covering index.
CREATE INDEX IF NOT EXISTS chat_message_reactions_user_idx
  ON chat_message_reactions (user_id);

-- F55: dm_messages.sender_id: GDPR export / "my DMs" full-scanned every monthly
-- partition. Keyset-shaped (sender, created_at DESC, id DESC). Propagates to
-- partitions (declaratively partitioned parent).
CREATE INDEX IF NOT EXISTS dm_messages_sender_created_idx
  ON dm_messages (sender_id, created_at DESC, id DESC);

-- F56: report_discussion_messages.author_user_id: GDPR export seq-scanned the
-- comments table (author is NULL for system-authored entries -> partial).
CREATE INDEX IF NOT EXISTS report_discussion_messages_author_created_idx
  ON report_discussion_messages (author_user_id, created_at DESC)
  WHERE author_user_id IS NOT NULL;

-- F67 (follow-up): the retention sweep deletes idempotency_keys by created_at;
-- index it so the steady-state sweep is an index range scan, not a seq scan.
CREATE INDEX IF NOT EXISTS idempotency_keys_created_idx
  ON idempotency_keys (created_at);
