-- =============================================================================
-- 0198_report_fixed_votes.sql
-- -----------------------------------------------------------------------------
-- "This is fixed" on a report (DECISIONS §61 in @civfix/contract, epic #156
-- revision 1): a resident's vote on someone else's report is either "I see
-- this too" (a confirmation, kind 'seen') or "This is fixed" (kind 'fixed'),
-- never both.
--
--   1. `report_confirmations.kind`: the vote's kind. Existing rows are
--      confirmations, so the constant DEFAULT 'seen' fills them without a
--      table rewrite. The primary key stays (report_id, user_id): one vote per
--      account per report is a key fact, and moving a vote is one UPDATE of
--      kind and created_at, so created_at is when the vote took its kind.
--
--   2. `reports.fixed_count`: the 'fixed' rows, kept in step in the same
--      transaction as the row change, as confirm_count is. From now on
--      confirm_count counts only 'seen' rows (every existing row is 'seen').
--
--   3. `report_confirmations_report_created_idx (report_id, created_at DESC)`:
--      a report's last five votes for the pressing ranking, one index scan per
--      candidate report. report_confirmations is not a hot table, so it is
--      built in line.
--
-- LOCK TIMEOUT: the ADD COLUMN on reports (a hot table) queues for ACCESS
-- EXCLUSIVE, and a queued request stalls every report read behind it while it
-- waits for a long reader. The timeout fails this file instead, and the deploy
-- is retried. It lasts only for this file's transaction.
--
-- NO INDEX ON reports: fixed_count is only read off rows another predicate
-- already found; reports_pressing_idx (0195) is unchanged.
--
-- CANONICAL DDL: hand-authored source of truth. Mirrors:
-- schema/report_confirmations.ts, schema/reports.ts.
--
-- Conventions: one transaction per file. Forward-only, no down.
--
-- Ordering rules: requires 0194_report_confirmations.sql.
-- =============================================================================

SET LOCAL lock_timeout = '3s';

ALTER TABLE report_confirmations
  ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'seen'
    CONSTRAINT report_confirmations_kind_check CHECK (kind IN ('seen', 'fixed'));

CREATE INDEX IF NOT EXISTS report_confirmations_report_created_idx
  ON report_confirmations (report_id, created_at DESC);

ALTER TABLE reports ADD COLUMN IF NOT EXISTS fixed_count integer NOT NULL DEFAULT 0;
