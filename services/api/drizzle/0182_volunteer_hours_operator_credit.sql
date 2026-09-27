-- =============================================================================
-- 0182_volunteer_hours_operator_credit.sql
-- -----------------------------------------------------------------------------
-- Operator credits and voids on the volunteer-hours ledger (admin panel).
--
-- An operator can now write two kinds of ledger row and void any event or
-- manual row:
--
--   source='event'   a credit for a real, ended event, written through the same
--                    void-aware upsert the host path uses. logged_by_user_id is
--                    the CivFix official account (what the volunteer sees);
--                    credited_by_operator_id is the human operator, which only
--                    the admin plane reads.
--   source='manual'  an adjustment for service outside any event. It has no
--                    cleanup and no jurisdiction (so it never reaches the
--                    user_jurisdiction_hours rollup or a leaderboard), and it
--                    carries the date the service was performed.
--
-- `note` (0035) holds the operator's credit reason. The void pair records who
-- voided a row and why; both stay on the admin plane and out of the data export.
--
-- Constraints:
--   * service_date is present on every manual row and on no other row. There
--     are zero manual rows before this migration (0065 verified no writer
--     existed), so the CHECK is added VALID: volunteer_hours is small and not a
--     hot table (docs/out-of-band-indexes.md), and the scan is milliseconds.
--   * void_reason is bounded at 1000 characters, the same bound the admin
--     reason field enforces at the boundary (DECISIONS §32).
--
-- No new index: the operator ledger read is keyset on (user_id, created_at DESC,
-- id DESC), which volunteer_hours_user_created_idx (0062) already serves, and
-- the new columns are never filtered on their own. ADD COLUMN of a nullable
-- column with no default is a catalog-only change.
--
-- CANONICAL DDL: mirrored in src/db/schema/volunteer-hours.ts.
--
-- Conventions: IF NOT EXISTS columns and pg_constraint-guarded constraints, so a
-- repeat apply is a no-op; one transaction per file (src/db/migrate.ts), no
-- BEGIN/COMMIT here. Forward-only, no down.
--
-- Ordering rules: requires 0035_volunteer_hours.sql and
-- 0053_volunteer_hours_audit.sql.
-- =============================================================================

ALTER TABLE volunteer_hours
  ADD COLUMN IF NOT EXISTS service_date date,
  ADD COLUMN IF NOT EXISTS credited_by_operator_id uuid REFERENCES users (id),
  ADD COLUMN IF NOT EXISTS voided_by_operator_id uuid REFERENCES users (id),
  ADD COLUMN IF NOT EXISTS void_reason text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'volunteer_hours_service_date_chk' AND conrelid = 'volunteer_hours'::regclass
  ) THEN
    ALTER TABLE volunteer_hours
      ADD CONSTRAINT volunteer_hours_service_date_chk
      CHECK ((source = 'manual') = (service_date IS NOT NULL));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'volunteer_hours_void_reason_len_chk' AND conrelid = 'volunteer_hours'::regclass
  ) THEN
    ALTER TABLE volunteer_hours
      ADD CONSTRAINT volunteer_hours_void_reason_len_chk
      CHECK (void_reason IS NULL OR char_length(void_reason) <= 1000);
  END IF;
END $$;

COMMENT ON COLUMN volunteer_hours.service_date IS
  'Manual rows only (required there, forbidden elsewhere): the date the service was performed. Transcripts date a manual row by this day.';
COMMENT ON COLUMN volunteer_hours.credited_by_operator_id IS
  'The operator who wrote this credit from the admin panel; NULL for host credits. Admin plane only: the volunteer sees logged_by_user_id (the CivFix official account).';
COMMENT ON COLUMN volunteer_hours.voided_by_operator_id IS
  'The operator who voided this row; set together with voided_at by the admin void path and cleared when a host or operator revives the row.';
COMMENT ON COLUMN volunteer_hours.void_reason IS
  'Internal reason for an operator void. Never shown to the volunteer and never exported.';
COMMENT ON COLUMN volunteer_hours_audit.new_hours IS
  'The credit AFTER this write. 0 records an operator void of the event row (the row itself keeps its hours, with voided_at set); a later revival journals previous_hours 0.';
