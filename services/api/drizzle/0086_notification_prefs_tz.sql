-- =============================================================================
-- 0086_notification_prefs_tz.sql
-- -----------------------------------------------------------------------------
-- FINDING F086: quiet-hours suppression compares the current time against
-- notification_prefs.quiet_start/quiet_end, but those are `time` (no zone) values
-- and there is no per-user timezone, so suppression was evaluated in the server's
-- zone — silencing (or failing to silence) users at the wrong wall-clock hour. Add
-- a nullable `tz` (IANA name). notif's code disables suppression entirely when tz
-- IS NULL (never suppress at a guessed hour) and evaluates quiet hours in the
-- user's zone when set.
--
-- Nullable, no backfill. Not PII beyond coarse locale (retention note recorded in
-- the manifest). The shared contract field is `.optional()` (F086 additivity).
--
-- CANONICAL DDL: hand-authored source of truth. Mirror: schema/notification_prefs.ts.
--
-- Conventions: additive ADD COLUMN IF NOT EXISTS; one transaction per file
-- (src/db/migrate.ts). Forward-only, no down.
--
-- Ordering rules: requires 0001_core.sql (notification_prefs).
-- =============================================================================

ALTER TABLE notification_prefs
  ADD COLUMN IF NOT EXISTS tz text;
