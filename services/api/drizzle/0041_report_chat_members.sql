-- =============================================================================
-- 0041_report_chat_members.sql
-- -----------------------------------------------------------------------------
-- Task D-B2: report-chat membership (Join). Explicit membership for the
-- report group chat, mirroring cleanup_members (0001_core.sql) but scoped to a
-- report instead of a cleanup. A user JOINS a report's chat (view-only vs
-- posting is gated by membership); role distinguishes the report's owner
-- (auto-member on report creation, later task) from regular joiners. Composite
-- PK(report_id, user_id) means a user joins a report's chat at most once.
--
-- last_read_at mirrors cleanup_members' chat read watermark (NULL = never
-- read; unread baseline falls back to joined_at).
--
-- This migration ONLY defines the table. Nothing reads/writes it yet (the
-- membership repo lands in D-C1).
--
-- Every statement is idempotent / guarded so re-applying the file is a no-op.
-- =============================================================================

CREATE TABLE IF NOT EXISTS report_chat_members (
  report_id    uuid NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
  user_id      uuid NOT NULL REFERENCES users(id)   ON DELETE CASCADE,
  role         text NOT NULL DEFAULT 'member',
  joined_at    timestamptz NOT NULL DEFAULT now(),
  last_read_at timestamptz,
  PRIMARY KEY (report_id, user_id)
);

CREATE INDEX IF NOT EXISTS report_chat_members_user_idx ON report_chat_members (user_id);
