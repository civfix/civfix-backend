-- =============================================================================
-- 0088_reports_hold_release_checked_at.sql
-- -----------------------------------------------------------------------------
-- FINDING F019: the held-anon release sweep scans held reports oldest-first with
-- NO progress marker, so it re-examines the same stuck-at-the-front reports every
-- pass and can starve. Add a nullable watermark the sweep stamps after checking a
-- report, and order NULLS FIRST so never-checked rows lead and a re-check of an
-- already-stamped row is deprioritized. abuse owns the query change; this file
-- only adds the column.
--
-- Nullable, no backfill (NULL = never checked → highest priority).
--
-- CANONICAL DDL: hand-authored source of truth. Mirror: schema/reports.ts.
--
-- Conventions: additive ADD COLUMN IF NOT EXISTS; one transaction per file
-- (src/db/migrate.ts). Forward-only, no down.
--
-- Ordering rules: requires 0001_core.sql (reports).
-- =============================================================================

ALTER TABLE reports
  ADD COLUMN IF NOT EXISTS hold_release_checked_at timestamptz;
