-- =============================================================================
-- 0194_report_confirmations.sql
-- -----------------------------------------------------------------------------
-- "Me too" on a report (DECISIONS §60 in @civfix/shared, epic #156): a signed-in
-- resident confirms someone else's open public report, one confirmation per
-- account per report, and taps again to remove it.
--
--   1. `report_confirmations` (new): one row per (report, user). The composite
--      PK makes the toggle a single INSERT ... ON CONFLICT DO NOTHING or DELETE,
--      as with post_likes. The (user_id, created_at) index serves the user's
--      data export (newest first). Nobody's confirmations are ever listed by
--      report: no API returns who confirmed.
--
--   2. `reports.confirm_count`: the denormalized count, kept in step in the
--      same transaction as the row insert or delete (posts.like_count is the
--      precedent), so map pins and the pressing list read it without a join. A
--      constant DEFAULT makes the ADD COLUMN metadata-only: no table rewrite.
--
-- LOCK TIMEOUT: the FK to reports and the ADD COLUMN both queue for a lock on
-- reports (a hot table), and a queued ACCESS EXCLUSIVE request stalls every
-- report read behind it while it waits for a long reader. The timeout fails
-- this file instead, and the deploy is retried. It is set before the first
-- statement that touches reports and lasts only for this file's transaction.
--
-- NO INDEX ON reports: confirm_count is only ever read off rows another
-- predicate already found (the bbox candidates), never searched by.
--
-- ERASURE: account deletion is a soft delete, so the ON DELETE CASCADE never
-- fires there; a deleted account's confirmations are kept and still count
-- (docs/erasure-behavior.md).
--
-- CANONICAL DDL: hand-authored source of truth. Mirrors:
-- schema/report_confirmations.ts, schema/reports.ts.
--
-- Conventions: one transaction per file. Forward-only, no down.
--
-- Ordering rules: requires the reports and users tables (0000).
-- =============================================================================

SET LOCAL lock_timeout = '3s';

CREATE TABLE IF NOT EXISTS report_confirmations (
  report_id  uuid        NOT NULL REFERENCES reports (id) ON DELETE CASCADE,
  user_id    uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (report_id, user_id)
);

CREATE INDEX IF NOT EXISTS report_confirmations_user_created_idx
  ON report_confirmations (user_id, created_at);

ALTER TABLE reports ADD COLUMN IF NOT EXISTS confirm_count integer NOT NULL DEFAULT 0;
