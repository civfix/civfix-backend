-- =============================================================================
-- 0137_host_exports_org_idx.sql
-- -----------------------------------------------------------------------------
-- Index for the ORG-scoped export list (`listOrgDonationExports`,
-- GET /v1/orgs/:id/donations/exports).
--
-- 0133 indexed host_exports by `cleanup_id` and by `requested_by`, but the
-- `donations` kind is scoped to an ORGANIZATION and carries `cleanup_id IS NULL`
-- - so the only list that can reach those rows filters on `organization_id`, and
-- without this it scans every export on the platform and sorts.
--
-- Partial on `organization_id IS NOT NULL`: event-scoped exports (the large
-- majority) are not in the list this serves, so they do not belong in the index.
-- Ordering columns match the query exactly (requested_at DESC, id DESC), so the
-- keyset reads straight off it.
--
-- Brand-new empty table at this point in the change set, so a non-CONCURRENTLY
-- build is fine (the whole 0130-0144 range creates it).
--
-- LOCK ORDER (binding on every writer): organizations -> organization_members
--   -> cleanups -> cleanup_members -> cleanup_guests -> cleanup_registrations
--   -> cleanup_registration_seats -> cleanup_answers -> cleanup_waitlist ->
--   cleanup_ticket_types -> cleanup_slots -> cleanup_slot_claims. host_exports is a leaf.
--
-- CANONICAL DDL: this file. Drizzle mirror: src/db/schema/host_exports.ts.
-- Ordering rules: requires 0133_host_exports.sql.
-- =============================================================================

CREATE INDEX IF NOT EXISTS host_exports_org_requested_idx
  ON host_exports (organization_id, requested_at DESC, id DESC)
  WHERE organization_id IS NOT NULL;
