-- =============================================================================
-- 0065_void_report_volunteer_hours.sql
-- -----------------------------------------------------------------------------
-- FILING A REPORT IS NOT VOLUNTEER SERVICE. This migration retires the report
-- auto-award: it voids every `source='report'` credit ever written and rebuilds
-- the denormalized rollup from the surviving ledger.
--
-- SUPERSEDES 0035_volunteer_hours.sql's banner. That file describes
-- volunteer_hours as holding "a report auto-award (0.1h, once per report)" —
-- that sentence is HISTORY as of this migration and MUST NOT be reinstated. The
-- only writer of credited hours now is `logEventHours` (an event's organizer or
-- cohost crediting an attendee for time actually served). `awardReportHours` was
-- deleted from VolunteerHoursRepository and from BOTH implementations, not merely
-- unwired, so it cannot come back through a dependency seam.
--
-- WHY VOID RETROACTIVELY rather than only stopping the write: the rollup feeds a
-- PUBLIC per-jurisdiction leaderboard, the "Total volunteer hours" number on every
-- profile, and — worst — signed, publicly verifiable PDF service transcripts that
-- get handed to schools, employers and courts. Leaving 0.1h-per-filing in place
-- means every one of those overstates service, permanently and invisibly. The void
-- is reversible in principle (clear `voided_at`); a wrongly-issued transcript is
-- not. `hours numeric(6,2) CHECK (hours > 0)` (0035:29) forbids zeroing the rows,
-- so `voided_at` — dormant since 0035 and already filtered by EVERY read path — is
-- the in-schema remedy, and the explanatory `note` travels with each row.
--
-- STATEMENT 2 IS A RECOMPUTE, NOT A SUBTRACTION. Subtracting the report totals is
-- correct exactly once and silently wrong if replayed; a recompute is idempotent,
-- and it also repairs any pre-existing rollup drift. It IS authoritative: any
-- total_hours with no backing non-voided ledger row is erased. Verified safe —
-- `awardReportHours` (removed here) and `logEventHours` were the ONLY writers of
-- user_jurisdiction_hours anywhere in the codebase, there is no `source='manual'`
-- writer at all, and no script or worker touches either table, so no hand-made
-- operator grant can exist in the rollup alone.
--
-- Zeroed rows are LEFT IN PLACE rather than deleted: every read already filters
-- `total_hours > 0` (volunteer-hours-repository.drizzle.ts), and deleting would
-- race the event upsert's ON CONFLICT (user_id, jurisdiction_geoid) target.
--
-- EXPECT THE PUBLIC NUMBERS TO DROP. Report filings were the only hours most users
-- could accrue (event hours require a verified organizer/cohost to log them, and a
-- host cannot self-credit), so most jurisdiction leaderboards go thin or empty and
-- many profiles fall to 0. That is the correction, not a regression.
--
-- ALREADY-ISSUED CERTIFICATES ARE NOT TOUCHED. service_hours_certificates rows are
-- immutable snapshots and the verify endpoint reports them verbatim (0064:14-18),
-- so no migration can correct one; hand-editing `snapshot` / `total_hours` would
-- also break `document_sha256` against the stored PDF. DETECT any live certificate
-- that itemised a report row with:
--
--   SELECT id, code, user_id, issued_at, total_hours
--   FROM service_hours_certificates
--   WHERE revoked_at IS NULL
--     AND EXISTS (
--       SELECT 1 FROM jsonb_array_elements(snapshot->'rows') r
--       WHERE r->>'source' = 'report'
--     );
--
-- (valid because TranscriptModelRow carries `source` — certificate-model.ts). The
-- window is tiny: 0064 shipped 2026-07-28. Remedy per row is operational, NOT part
-- of this migration: revoke through the existing revoke path with reason
-- `ledger_corrected`, notify the holder, let them re-issue. After this void the
-- ledger fingerprint changes, so re-issue is not blocked by the
-- (user_id, ledger_fingerprint) WHERE revoked_at IS NULL idempotency index.
--
-- GOTCHA for anyone tempted to bring report crediting back: the 0035 partial index
-- `volunteer_hours_report_uidx ON (report_id) WHERE source='report'` does NOT
-- exclude voided rows. An `ON CONFLICT DO NOTHING` award would therefore silently
-- skip a report whose credit was voided here, rather than re-crediting it. Don't
-- bring it back.
--
-- NO `BEGIN;` / `COMMIT;` IN THIS FILE. src/db/migrate.ts wraps EVERY file in its
-- own begin/commit on a reserved connection together with the _civfix_migrations
-- bookkeeping INSERT; a file that opens its own transaction ends the runner's one
-- mid-flight. test/unit/migrations-transaction-control.test.ts keeps it that way.
--
-- Forward-only, and SAFE TO RE-APPLY: statement 1 matches nothing once every
-- report row is voided, and statement 2 is a pure recompute.
--
-- Ordering rules: requires 0035_volunteer_hours.sql (both tables).
-- =============================================================================

-- 1. Void every report-derived credit. `voided_at IS NULL` keeps the note of an
--    already-voided row intact; COALESCE never overwrites an existing note.
UPDATE volunteer_hours
SET voided_at = now(),
    note = COALESCE(
      note,
      'voided 2026-07-28: filing a report is not volunteer service (migration 0065)'
    )
WHERE source = 'report'
  AND voided_at IS NULL;

-- 2. Rebuild the rollup from the surviving ledger. COALESCE(...,0) covers a
--    (user, jurisdiction) pair whose every row is now void: it goes to 0 and stops
--    appearing anywhere, since all reads filter total_hours > 0.
UPDATE user_jurisdiction_hours ujh
SET total_hours = COALESCE(
  (
    SELECT SUM(vh.hours)
    FROM volunteer_hours vh
    WHERE vh.user_id = ujh.user_id
      AND vh.jurisdiction_geoid = ujh.jurisdiction_geoid
      AND vh.voided_at IS NULL
  ),
  0
);
