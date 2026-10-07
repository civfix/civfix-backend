-- =============================================================================
-- 0084_notifications_feed_idx.sql
-- -----------------------------------------------------------------------------
-- FINDING F089: the notifications FEED query filters out the inbox-surfaced
-- messaging types and pages newest-first:
--   WHERE user_id = $1 AND type <> ALL(FEED_HIDDEN_NOTIFICATION_TYPES)
--   ORDER BY created_at DESC, id DESC
-- The existing indexes (notifications_user_created_idx, notifications_user_unread_idx)
-- don't encode the hidden-type exclusion, so the feed sorts/filters at scan time.
-- Add a PARTIAL index whose predicate excludes exactly the hidden types and whose
-- key matches the cursor (user_id, created_at DESC, id DESC).
--
-- PREDICATE PINNING: the literal list below MUST equal
-- FEED_HIDDEN_NOTIFICATION_TYPES (src/services/notification-helpers.ts). notif
-- pins the pair with an enums test (WIRING REQUEST to integration; see the
-- manifest). If a hidden type is added/removed, this index must be re-issued.
--
-- CANONICAL DDL: hand-authored source of truth. Mirror: schema/notifications.ts
-- (partial index over a literal type list; expressed via sql in the mirror).
--
-- Conventions: additive CREATE INDEX IF NOT EXISTS; one transaction per file;
-- non-CONCURRENTLY build accepted (pre-launch, trivial rows). Forward-only, no down.
--
-- Ordering rules: requires 0001_core.sql (notifications).
-- =============================================================================

CREATE INDEX IF NOT EXISTS notifications_feed_idx
  ON notifications (user_id, created_at DESC, id DESC)
  WHERE type <> ALL (ARRAY['dm', 'cleanup_chat', 'group_chat', 'report_chat']::text[]);
