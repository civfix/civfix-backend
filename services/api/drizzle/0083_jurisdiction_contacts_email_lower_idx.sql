-- =============================================================================
-- 0083_jurisdiction_contacts_email_lower_idx.sql
-- -----------------------------------------------------------------------------
-- FINDING F111: inbound reply routing and the contacts directory resolve a
-- contact by email case-insensitively (`lower(email) = lower($1)`), but
-- jurisdiction_contacts has no index over lower(email), so every lookup is a
-- sequential scan. Add the expression index.
--
-- CANONICAL DDL: hand-authored source of truth. Mirror: schema/jurisdiction_contacts.ts
-- (expression index expressed via sql`lower(email)`).
--
-- Conventions: additive CREATE INDEX IF NOT EXISTS; one transaction per file;
-- non-CONCURRENTLY build accepted (pre-launch, trivial rows). Forward-only, no down.
--
-- Ordering rules: requires 0007_admin_phase2.sql (jurisdiction_contacts).
-- =============================================================================

CREATE INDEX IF NOT EXISTS jurisdiction_contacts_email_lower_idx
  ON jurisdiction_contacts (lower(email));
