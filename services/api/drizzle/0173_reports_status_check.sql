-- =============================================================================
-- 0173_reports_status_check.sql
-- -----------------------------------------------------------------------------
-- The report lifecycle is enforced in the service layer (the shared contract's
-- ADMIN_REPORT_STATUS_TRANSITIONS / canTransitionReportStatus), but nothing at
-- the DB level stopped a typo or a future writer from parking a report on a
-- status no reader understands — the admin list buckets, the citizen map filter
-- and the timeline icon mapper all switch on this column and silently drop a
-- value they do not know. Pin the VALUE SET here; the transition graph stays in
-- code, where the actor and the reason live.
--
-- NOT VALID is mandatory: `reports` is a HOT table and the runner is
-- one-transaction-per-file during deploy, so validating the whole table inside
-- the deploy txn would take an ACCESS EXCLUSIVE-adjacent lock for the length of
-- a full scan. NOT VALID takes the lock only briefly and still enforces the
-- CHECK on every INSERT and UPDATE from here on; the pre-existing rows are
-- already inside the set (the enum has not changed since the contract's 0.20.0).
--
-- VALIDATE is an OPTIONAL out-of-band step, not a follow-up migration: run
--   ALTER TABLE reports VALIDATE CONSTRAINT reports_status_chk;
-- by hand on a quiet box if the constraint ever needs to be trusted for
-- planning or for a partition attach. It takes a SHARE UPDATE EXCLUSIVE lock
-- and scans, so it never belongs in a deploy transaction.
--
-- CANONICAL DDL: hand-authored source of truth, mirrored in
-- src/db/schema/reports.ts (drizzle check()).
--
-- Conventions: guarded ADD CONSTRAINT so a repeat apply is a no-op; one
-- transaction per file (src/db/migrate.ts). Forward-only, no down.
-- =============================================================================

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'reports_status_chk' AND conrelid = 'reports'::regclass
  ) THEN
    ALTER TABLE reports
      ADD CONSTRAINT reports_status_chk
      CHECK (status IN (
        'submitted', 'held', 'published', 'acknowledged', 'in_progress', 'resolved', 'rejected'
      )) NOT VALID;
  END IF;
END $$;
