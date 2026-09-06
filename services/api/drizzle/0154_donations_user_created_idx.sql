-- =============================================================================
-- 0154_donations_user_created_idx.sql
-- -----------------------------------------------------------------------------
-- The donor-facing "my donations" list pages on (created_at, id), not on
-- (charged_at, id): a failed or expired checkout has a NULL charged_at, and a
-- row comparison against NULL yields NULL, which silently truncated every page
-- after such a row. `donations_org_created_idx` already covers the organization
-- list; this is the matching index for the per-user list.
--
-- CANONICAL DDL: hand-authored source of truth. Mirror: schema/donations.ts.
--
-- Conventions: CREATE INDEX IF NOT EXISTS; one concern per file; the table is
-- still empty in every environment, so a non-CONCURRENTLY build is accepted.
-- Forward-only. Ordering rules: requires 0148_donations.sql.
-- =============================================================================

CREATE INDEX IF NOT EXISTS donations_user_created_idx
  ON donations (user_id, created_at DESC, id DESC)
  WHERE user_id IS NOT NULL;
