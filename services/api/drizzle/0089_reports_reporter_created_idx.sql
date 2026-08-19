-- =============================================================================
-- 0089_reports_reporter_created_idx.sql
-- -----------------------------------------------------------------------------
-- FINDING F026: "my reports" (a signed-in user's own reports, newest-first) and
-- the per-reporter rate/abuse checks scan by reporter_user_id ordered by
-- created_at. The existing reports_reporter_idx (reporter_user_id) alone has no
-- created_at, so it sorts at scan time. Add a composite partial index keyed for
-- the access pattern, partial on reporter_user_id IS NOT NULL (anon reports carry
-- a NULL reporter and never use this path).
--
-- HOT TABLE: reports is one of the flagged hot tables. Per the coordinator's
-- release decision, an in-migration non-CONCURRENTLY CREATE INDEX is accepted
-- because prod is pre-launch with trivial row counts (reports count recorded in
-- the delivery report). NOT for a live-traffic environment without a CONCURRENTLY
-- out-of-band build first (the IF NOT EXISTS below then no-ops).
--
-- CANONICAL DDL: hand-authored source of truth. Mirror: schema/reports.ts.
--
-- Conventions: additive CREATE INDEX IF NOT EXISTS; one transaction per file
-- (src/db/migrate.ts). Forward-only, no down.
--
-- Ordering rules: requires 0001_core.sql (reports).
-- =============================================================================

CREATE INDEX IF NOT EXISTS reports_reporter_created_idx
  ON reports (reporter_user_id, created_at)
  WHERE reporter_user_id IS NOT NULL;
