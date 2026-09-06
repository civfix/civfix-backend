-- =============================================================================
-- 0134_host_messaging_switches.sql
-- -----------------------------------------------------------------------------
-- The two switches that stop host messaging (W2.6), one operator-facing and one
-- resident-facing.
--
--   user_moderation.host_messaging_suspended
--       Per-host operator kill switch. A suspended host can still compose and
--       still see their drafts, but compose refuses, plan refuses and an
--       in-flight chunk re-checks it and suppresses the remainder -- an abusive
--       blast is stopped mid-send, not merely prevented from starting. The
--       REASON and the actor live in audit_log (host.messaging_suspended /
--       host.messaging_restored), not on this row: the moderation side table
--       carries state, the audit log carries the story.
--       Read FAIL-CLOSED: if the lookup errors, messaging is refused.
--
--   notification_prefs.host_broadcasts
--       The resident's own "messages from event organizers" switch, sitting
--       beside the existing per-category push prefs. DEFAULT true, so an existing
--       row keeps working; the contract's NotificationPrefsDTO defaults it too,
--       so an older client that PATCHes without the key does not clear it.
--       Bulk kinds honour it. The critical kinds (event_updated, event_cancelled)
--       do not -- those are service messages about something the person signed up
--       for, and the platform would be lying to them by staying silent.
--
-- Both are plain boolean adds with defaults, so they are non-blocking on a large
-- table in PG11+ (the default is stored in the catalog, not rewritten per row).
--
-- CANONICAL DDL: hand-authored source of truth. Mirrors: schema/user_moderation.ts,
-- schema/notification_prefs.ts.
-- =============================================================================

ALTER TABLE user_moderation
  ADD COLUMN IF NOT EXISTS host_messaging_suspended boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS user_moderation_host_messaging_idx
  ON user_moderation (user_id)
  WHERE host_messaging_suspended = true;

ALTER TABLE notification_prefs
  ADD COLUMN IF NOT EXISTS host_broadcasts boolean NOT NULL DEFAULT true;
