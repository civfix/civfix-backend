-- =============================================================================
-- 0195_reports_pressing_idx.sql
-- -----------------------------------------------------------------------------
-- The pressing list (GET /reports/pressing, findPressing in
-- report-repository.drizzle.ts) used to rank only the newest 2000 public
-- reports in the bbox, so in a busy area an older, heavily confirmed report
-- fell out of the list behind newer unconfirmed ones. It now filters the
-- confirmed reports first and ranks them, which needs its own index to stay
-- bounded: 0194 left reports unindexed on confirm_count because the window was
-- the bound.
--
-- reports_pressing_idx is a partial btree over the rows the list can return
-- (confirm_count >= 1, public, not deleted) in the list's own order. A wide
-- bbox walks it until 20 rows match; a narrow bbox keeps using
-- reports_geom_gist. The walk is bounded by the index, which holds every
-- confirmed public report ever (resolved ones keep their count), a small
-- share of the table.
--
-- INDEX IS NOT CREATED HERE. `reports` is a hot table and every migration runs
-- in one transaction, where CREATE INDEX CONCURRENTLY is not allowed; a plain
-- CREATE INDEX would hold ACCESS EXCLUSIVE for the build and stall every report
-- read. It is built OUT OF BAND (docs/out-of-band-indexes.md). The DO block
-- creates nothing: it RAISES A WARNING in the deploy log while the index is
-- missing. The query is correct without it, only slower.
--
-- CANONICAL DDL: hand-authored source of truth. No Drizzle mirror (no DDL).
--
-- Conventions: one concern per file; one transaction per file. Forward-only,
-- no down.
--
-- Ordering rules: requires 0194_report_confirmations.sql (confirm_count).
-- =============================================================================

DO $$
BEGIN
  IF to_regclass('public.reports_pressing_idx') IS NULL THEN
    RAISE WARNING 'reports_pressing_idx is missing - build it out of band with CREATE INDEX CONCURRENTLY (docs/out-of-band-indexes.md); the pressing list checks every report in the bbox until then';
  END IF;
END $$;
