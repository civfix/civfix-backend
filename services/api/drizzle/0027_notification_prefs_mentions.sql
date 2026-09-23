-- =============================================================================
-- 0027_notification_prefs_mentions.sql
-- -----------------------------------------------------------------------------
-- Add the dedicated `mentions` notification preference to notification_prefs.
-- This is the per-user toggle for the @-mention bell (raised by the discussion
-- and chat mention notifiers). NOT NULL DEFAULT true so existing rows opt in
-- automatically (same posture as the other per-channel toggles); no backfill
-- statement needed, the DEFAULT fills every existing row.
--
-- CANONICAL DDL: this hand-authored SQL is the source of truth. The Drizzle
-- definition in src/db/schema/notification_prefs.ts mirrors it
-- (mentions boolean .notNull().default(true)) for typed queries.
--
-- Ordering rules:
--   * Requires 0001_core.sql (notification_prefs table) already applied.
--   * Single additive ADD COLUMN IF NOT EXISTS, idempotent on re-apply. The
--     migrate runner records applied files in _civfix_migrations and wraps each
--     file in one transaction.
-- =============================================================================

ALTER TABLE notification_prefs
  ADD COLUMN IF NOT EXISTS mentions boolean NOT NULL DEFAULT true;
