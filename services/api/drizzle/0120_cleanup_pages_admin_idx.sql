-- =============================================================================
-- 0120_cleanup_pages_admin_idx.sql
-- -----------------------------------------------------------------------------
-- Index for the operator page-moderation queue (`adminListEventPages`,
-- GET /v1/admin/pages).
--
-- 0119's two indexes are partial - `WHERE status = 'published'` and
-- `WHERE flagged_at IS NOT NULL` - so neither can serve the operator list, which
-- deliberately spans EVERY status (an unpublished or flagged page is exactly the
-- one an operator needs to find). That list orders and pages on
-- COALESCE(published_at, updated_at) DESC, id DESC so a never-published draft
-- still keysets deterministically, which is what this expression index backs.
--
-- Brand-new empty table in this change set, so a non-CONCURRENTLY build is fine.
--
-- LOCK ORDER (binding on every writer): organizations -> organization_members
--   -> cleanups -> cleanup_members -> cleanup_guests -> cleanup_registrations
--   -> cleanup_registration_seats -> cleanup_answers -> cleanup_waitlist ->
--   cleanup_ticket_types -> cleanup_slots -> cleanup_slot_claims. cleanup_pages is a leaf.
--
-- CANONICAL DDL: this file. Drizzle mirror: src/db/schema/cleanup_pages.ts.
-- Ordering rules: requires 0119_cleanup_pages.sql.
-- =============================================================================

CREATE INDEX IF NOT EXISTS cleanup_pages_admin_queue_idx
  ON cleanup_pages ((COALESCE(published_at, updated_at)) DESC, id DESC);
