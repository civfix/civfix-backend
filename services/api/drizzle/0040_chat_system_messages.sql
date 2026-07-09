-- =============================================================================
-- 0040_chat_system_messages.sql
-- -----------------------------------------------------------------------------
-- Task D-B1: widen chat_messages (already report-polymorphic since 0036) so it can
-- also store sender-less SYSTEM messages -- report status/timeline events posted
-- into the report chat as first-class chat rows instead of being rendered
-- out-of-band. A system message has no author, so sender_id must become nullable,
-- and it carries a small structured payload (status / kind / body) instead of a
-- free-text body from a user.
--
-- This migration ONLY widens storage + the DB-layer enum mirrors. Nothing produces
-- system_* rows yet (that lands in D-C1/D-D1) and nothing renders them yet, so
-- system_status/system_kind/system_body stay NULL on every row created here.
--
-- Every statement is idempotent / guarded so re-applying the file is a no-op.
-- =============================================================================

-- System messages have no author: sender_id is no longer mandatory. Already idempotent
-- (dropping a constraint that is already absent is a no-op).
ALTER TABLE chat_messages
  ALTER COLUMN sender_id DROP NOT NULL;

-- Structured system-event payload. All nullable; NULL on every non-system row.
--   system_status -- the report status the event represents (e.g. "acknowledged").
--   system_kind   -- discriminator for the kind of system event (e.g. "status").
--   system_body   -- optional rendered/fallback text for the event.
ALTER TABLE chat_messages
  ADD COLUMN IF NOT EXISTS system_status text,
  ADD COLUMN IF NOT EXISTS system_kind text,
  ADD COLUMN IF NOT EXISTS system_body text;
