-- =============================================================================
-- 0021_report_type.sql
-- -----------------------------------------------------------------------------
-- Adds a fine-grained issue `type` to reports (coexists with the coarser
-- `category`). Mirrors the shared ReportTypeSchema:
--   dump | encampment | graffiti | infrastructure | pavement | vegetation | other
--
-- Each type maps to a category (REPORT_TYPE_TO_CATEGORY in @civfix/shared):
--   dump->trash, encampment->hazard, graffiti->graffiti, infrastructure->water,
--   pavement->hazard, vegetation->recycling, other->other.
--
-- NOT NULL. Because existing rows predate the column, we add it with a TEMPORARY
-- default so the ADD COLUMN succeeds on a populated table, BACKFILL each legacy
-- row to a representative fine type derived from its category (the inverse map
-- below; legacy reports need not preserve an exact fine type), then SET NOT NULL
-- and DROP the temporary default so new inserts MUST supply `type` explicitly.
--
-- Representative inverse backfill (category -> type):
--   trash->dump, hazard->encampment, graffiti->graffiti, water->infrastructure,
--   recycling->vegetation, other->other (and any unknown/null falls back to other).
--
-- CANONICAL DDL: this hand-authored SQL is the source of truth. The Drizzle
-- definition in src/db/schema/reports.ts mirrors it for typed queries.
--
-- Ordering rules:
--   * Requires 0001_core.sql (reports) already applied.
--   * IF NOT EXISTS so a partial / repeat apply is safe; the migrate runner also
--     records applied files in _civfix_migrations.
-- =============================================================================

-- 1) Add the column with a temporary default so the ADD COLUMN backfills existing rows.
ALTER TABLE reports ADD COLUMN IF NOT EXISTS type text NOT NULL DEFAULT 'other';

-- 2) Backfill legacy rows to a representative fine type derived from their category.
UPDATE reports
SET type = CASE category
  WHEN 'trash'     THEN 'dump'
  WHEN 'hazard'    THEN 'encampment'
  WHEN 'graffiti'  THEN 'graffiti'
  WHEN 'water'     THEN 'infrastructure'
  WHEN 'recycling' THEN 'vegetation'
  ELSE 'other'
END;

-- 3) Drop the temporary default so every new insert MUST supply `type` explicitly
--    (the column stays NOT NULL from step 1).
ALTER TABLE reports ALTER COLUMN type DROP DEFAULT;

-- NOTE: `category` carries no btree index in the schema, so `type` mirrors it (no index).
