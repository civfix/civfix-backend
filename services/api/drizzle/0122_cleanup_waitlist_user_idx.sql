-- =============================================================================
-- 0122_cleanup_waitlist_user_idx.sql
-- -----------------------------------------------------------------------------
-- Index for the two predicates that scan cleanup_waitlist by person rather than
-- by ticket type: `leaveWaitlist` (cleanup_id + user_id) and the account-erasure
-- release sweep (user_id). 0117 indexes (ticket_type_id, created_at, id) and the
-- two partial uniques on the ACTIVE statuses only, so neither can serve a lookup
-- that must also see cancelled/expired rows.
--
-- Partial on user_id IS NOT NULL: guest waitlist rows carry a null user_id and
-- are found through cleanup_guests instead.
--
-- Small table today (the platform is pre-launch), so a non-CONCURRENTLY build is
-- fine inside the one-transaction-per-file migration runner.
--
-- LOCK ORDER (binding on every writer): organizations -> organization_members
--   -> cleanups -> cleanup_members -> cleanup_guests -> cleanup_registrations
--   -> cleanup_registration_seats -> cleanup_answers -> cleanup_waitlist ->
--   cleanup_ticket_types -> cleanup_slots -> cleanup_slot_claims.
--
-- CANONICAL DDL: this file. Drizzle mirror: src/db/schema/cleanup_waitlist.ts.
-- Ordering rules: requires 0117_cleanup_waitlist.sql.
-- =============================================================================

CREATE INDEX IF NOT EXISTS cleanup_waitlist_user_idx
  ON cleanup_waitlist (user_id, created_at DESC)
  WHERE user_id IS NOT NULL;
