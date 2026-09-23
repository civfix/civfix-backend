-- =============================================================================
-- 0094_notifications_created_idx.sql
-- -----------------------------------------------------------------------------
-- REVIEW FOLLOW-UP (notifications retention lane): the sweep pages by AGE ALONE:
--   DELETE FROM notifications WHERE id IN (
--     SELECT id FROM notifications WHERE created_at < $1 LIMIT $2)
-- Every index on the table is user_id-LEADING (notifications_user_created_idx and
-- notifications_user_unread_idx from 0001_core.sql, notifications_feed_idx from
-- 0084), so none of them can serve a bare created_at range; the nightly sweep
-- seq-scans the largest write-heavy table in the schema, once per page, up to
-- maxPages times. Index created_at on its own, exactly as
-- idempotency_keys_created_idx (0037) does for that table's identical lane.
--
-- Deliberately NOT partial and NOT composite: the predicate has one column and no
-- companion filter, so a plain btree is both the smallest index that serves it and
-- the one the planner can range-scan forward from the oldest row.
--
-- CANONICAL DDL: hand-authored source of truth. Mirror: schema/notifications.ts.
--
-- Conventions: additive CREATE INDEX IF NOT EXISTS; one transaction per file;
-- non-CONCURRENTLY build accepted (pre-launch, trivial rows); on a live-traffic
-- box this one would be built out-of-band with CONCURRENTLY first, leaving this
-- file an idempotent no-op. Forward-only, no down.
--
-- Ordering rules: requires 0001_core.sql (notifications).
-- =============================================================================

CREATE INDEX IF NOT EXISTS notifications_created_idx
  ON notifications (created_at);
