-- =============================================================================
-- 0032_report_encampment_category.sql
-- -----------------------------------------------------------------------------
-- "Encampment" becomes its own report CATEGORY (previously it folded into the
-- coral "hazard" bucket, so encampment + pavement-distress pins shared one
-- color/icon on the map). The shared taxonomy now maps:
--   encampment (type) -> encampment (category)    [was: -> hazard]
-- while pavement-distress stays type=pavement -> category=hazard.
--
-- `reports.category` is a free-text column (no CHECK / pg enum), so no DDL is
-- needed for the new value - only this data backfill to realign existing rows
-- with the new type->category mapping. `type` is the canonical fine-grained
-- value (set at creation; representative-backfilled for pre-0021 rows), so we
-- derive category from it.
--
-- Only the encampment mapping changed; every other type->category pair is
-- unchanged, so their categories are already correct. We therefore touch only
-- the encampment rows.
--
-- NOTE (legacy rows): 0021 representative-backfilled pre-0021 `hazard` rows to
-- type='encampment' (the exact fine type was unrecoverable). Those rows are
-- realigned to category='encampment' here, consistent with the type we have.
--
-- Idempotent: a plain conditional UPDATE; re-applying is a no-op (the migrate
-- runner also records applied files in _civfix_migrations).
--
-- Ordering rules:
--   * Requires 0001_core.sql (reports) and 0021_report_type.sql (reports.type).
-- =============================================================================

UPDATE reports
SET category = 'encampment'
WHERE type = 'encampment'
  AND category <> 'encampment';
