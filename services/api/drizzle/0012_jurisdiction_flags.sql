-- =============================================================================
-- 0012_jurisdiction_flags.sql
-- -----------------------------------------------------------------------------
-- Operator "flag for review" state on a jurisdiction (the Jurisdictions directory
-- "Flag for review" action). Two nullable columns:
--
--   * flagged_at   timestamptz, nullable. Stamped now() when an operator flags the
--                  jurisdiction for review; NULL means not flagged. The directory
--                  row shows a "Flagged" chip when set.
--   * flag_reason  text, nullable. The optional reason captured with the flag;
--                  cleared (NULL) when the jurisdiction is unflagged.
--
-- Set/cleared via PATCH /admin/jurisdictions/:geoid (PatchJurisdictionRequest.flagged
-- + .flagReason). Purely advisory: it does NOT affect jurisdiction RESOLUTION or
-- report routing.
--
-- CANONICAL DDL: this hand-authored SQL is the source of truth. The Drizzle
-- definition in src/db/schema/jurisdictions.ts mirrors it for typed queries.
--
-- Ordering rules:
--   * Requires 0001_core.sql (jurisdictions) already applied.
--   * IF NOT EXISTS so a partial / repeat apply is safe; the migrate runner also
--     records applied files in _civfix_migrations.
-- =============================================================================

ALTER TABLE jurisdictions
  ADD COLUMN IF NOT EXISTS flagged_at  timestamptz,
  ADD COLUMN IF NOT EXISTS flag_reason text;
