-- =============================================================================
-- 0200_notifications_unread_page_index_guard.sql
-- -----------------------------------------------------------------------------
-- The notifications page's unread dot (GET /notifications/unread, hasUnread
-- in notification-repository.drizzle.ts) and Mark all read (POST
-- /notifications/read-all, markAllRead) both look for a user's unread rows of
-- the types the page lists, which leaves out the chat types (dm, cleanup_chat,
-- group_chat, report_chat). notifications_user_unread_idx covers every unread
-- row, so a user with many unread chat rows would walk all of them to answer.
--
-- notifications_user_unread_page_idx is a partial btree over (user_id) for
-- exactly the unread page rows. Both statements spell its predicate with the
-- same literals, which is what lets the planner prove it.
--
-- INDEX IS NOT CREATED HERE. `notifications` is a hot table and every
-- migration runs in one transaction, where CREATE INDEX CONCURRENTLY is not
-- allowed; a plain CREATE INDEX would hold ACCESS EXCLUSIVE for the build and
-- stall every notification read and write. It is built OUT OF BAND
-- (docs/out-of-band-indexes.md). The DO block creates nothing: it RAISES A
-- WARNING in the deploy log while the index is missing. The queries are
-- correct without it, only slower.
--
-- CANONICAL DDL: hand-authored source of truth. No Drizzle mirror (no DDL).
--
-- Conventions: one concern per file; one transaction per file. Forward-only,
-- no down.
--
-- Ordering rules: none (notifications exists since 0001_core.sql).
-- =============================================================================

DO $$
BEGIN
  IF to_regclass('public.notifications_user_unread_page_idx') IS NULL THEN
    RAISE WARNING 'notifications_user_unread_page_idx is missing - build it out of band with CREATE INDEX CONCURRENTLY (docs/out-of-band-indexes.md); the unread dot and Mark all read check every unread notification of the user until then';
  END IF;
END $$;
