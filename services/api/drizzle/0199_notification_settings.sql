-- =============================================================================
-- 0199_notification_settings.sql
-- -----------------------------------------------------------------------------
-- Per-category notification settings (epic #211, D4): each of the eleven
-- categories in @civfix/contract's NotificationCategorySchema is on or off,
-- with Push and Email checkboxes.
--
--   1. `notification_settings` (new): one row per (user, category) the user
--      has moved off its default. A missing row means the category's
--      NOTIFICATION_CATEGORY_DEFAULTS value, so nothing is written at sign-up.
--      `category` has no CHECK, like notifications.type: the app validates it
--      against the contract list. The primary key serves every read (one
--      user, or `user_id = ANY(...)` for a fan-out).
--
--   2. Backfill from the seven notification_prefs booleans, inline
--      (notification_prefs holds few rows). Only categories that end up
--      different from their default get a row:
--        push = false              -> Push unchecked in every category
--        report_updates = false    -> Push unchecked: reportUpdates, reportDiscussions
--        cleanup_chat = false      -> Push unchecked: groupChats, events, eventTeam
--        mentions = false          -> mentions Off
--        follows = false           -> Push unchecked: followers
--        post_interactions = false -> Push unchecked: likesAndReposts
--        host_broadcasts = false   -> hostAnnouncements Off
--      The defaults below are D1's, as the contract exports them at this
--      migration; the backfill never touches Email. ON CONFLICT DO NOTHING
--      keeps a re-run from overwriting a row the user changed since.
--
-- notification_prefs is left as it is: quiet hours stay there, and the old
-- prefs endpoints read and write the new table from #220 on.
--
-- LOCK TIMEOUT: the FK to users queues for a lock on users (a hot table), and
-- a queued request stalls every user read behind it while it waits for a long
-- reader. The timeout fails this file instead, and the deploy is retried. It
-- lasts only for this file's transaction.
--
-- ERASURE: account deletion is a soft delete, so the ON DELETE CASCADE never
-- fires there; #220 deletes the rows on erasure.
--
-- CANONICAL DDL: hand-authored source of truth. Mirrors:
-- schema/notification_settings.ts.
--
-- Conventions: one transaction per file. Forward-only, no down.
--
-- Ordering rules: requires the users table (0000) and notification_prefs with
-- all seven booleans (0134).
-- =============================================================================

SET LOCAL lock_timeout = '3s';

CREATE TABLE IF NOT EXISTS notification_settings (
  user_id    uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  category   text        NOT NULL,
  enabled    boolean     NOT NULL,
  push       boolean     NOT NULL,
  email      boolean     NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, category)
);

INSERT INTO notification_settings (user_id, category, enabled, push, email)
SELECT s.user_id, s.category, s.enabled, s.push, s.email
FROM (
  SELECT
    p.user_id,
    d.category,
    d.enabled AND CASE d.category
      WHEN 'mentions'          THEN p.mentions
      WHEN 'hostAnnouncements' THEN p.host_broadcasts
      ELSE true
    END AS enabled,
    d.push AND p.push AND CASE d.category
      WHEN 'reportUpdates'     THEN p.report_updates
      WHEN 'reportDiscussions' THEN p.report_updates
      WHEN 'groupChats'        THEN p.cleanup_chat
      WHEN 'events'            THEN p.cleanup_chat
      WHEN 'eventTeam'         THEN p.cleanup_chat
      WHEN 'followers'         THEN p.follows
      WHEN 'likesAndReposts'   THEN p.post_interactions
      ELSE true
    END AS push,
    d.email,
    d.enabled AS default_enabled,
    d.push AS default_push
  FROM notification_prefs p
  CROSS JOIN (VALUES
    ('reportUpdates',     true, true,  false),
    ('reportDiscussions', true, false, false),
    ('directMessages',    true, true,  false),
    ('mentions',          true, true,  false),
    ('groupChats',        true, false, false),
    ('events',            true, true,  true),
    ('hostAnnouncements', true, true,  false),
    ('eventTeam',         true, true,  false),
    ('followers',         true, false, false),
    ('likesAndReposts',   true, false, false),
    ('organizations',     true, false, true)
  ) AS d (category, enabled, push, email)
) s
WHERE s.enabled <> s.default_enabled OR s.push <> s.default_push
ON CONFLICT (user_id, category) DO NOTHING;
