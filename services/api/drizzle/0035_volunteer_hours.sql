-- =============================================================================
-- 0035_volunteer_hours.sql
-- -----------------------------------------------------------------------------
-- Volunteer-hours ledger + a per-(user, jurisdiction) rollup that backs "my hours"
-- and the per-jurisdiction leaderboard. Two tables:
--
--   volunteer_hours          the append/correct LEDGER. Every credited unit of time
--                            is one row: a report auto-award (0.1h, once per report),
--                            an event award (one row per attendee per cleanup,
--                            correctable), or a manual operator grant. `source`
--                            discriminates. Partial UNIQUE indexes enforce the two
--                            idempotency rules: at most one 'report' row per report,
--                            and at most one 'event' row per (cleanup, attendee).
--
--   user_jurisdiction_hours  the derived ROLLUP: SUM of a user's credited hours per
--                            jurisdiction. Maintained transactionally alongside the
--                            ledger (award = ledger insert + rollup upsert in one tx;
--                            an event re-log adjusts the rollup by the hours delta).
--                            It is what the leaderboard + "my hours" read, so neither
--                            re-aggregates the ledger on the read path.
--
-- Idempotent (IF NOT EXISTS everywhere): re-applying is a no-op. hours is
-- numeric(6,2) CHECK (> 0) so a non-positive credit can never land; the rollup is
-- numeric(8,2) to hold the summed total.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS volunteer_hours (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             uuid NOT NULL REFERENCES users(id),
  hours               numeric(6, 2) NOT NULL CHECK (hours > 0),
  source              text NOT NULL CHECK (source IN ('report', 'event', 'manual')),
  report_id           uuid REFERENCES reports(id),
  cleanup_id          uuid REFERENCES cleanups(id),
  jurisdiction_geoid  text REFERENCES jurisdictions(geoid),
  logged_by_user_id   uuid REFERENCES users(id),
  note                text,
  voided_at           timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now()
);

-- Once per report: at most one 'report' award may exist for a given report. The award insert uses
-- ON CONFLICT (report_id) WHERE source='report' DO NOTHING, so a replay inserts nothing.
CREATE UNIQUE INDEX IF NOT EXISTS volunteer_hours_report_uidx
  ON volunteer_hours (report_id) WHERE source = 'report';

-- One event award per attendee per cleanup, correctable: re-logging upserts the same row (adjusting the
-- hours), rather than stacking duplicate credits.
CREATE UNIQUE INDEX IF NOT EXISTS volunteer_hours_event_uidx
  ON volunteer_hours (cleanup_id, user_id) WHERE source = 'event';

-- "My ledger" reads by owner.
CREATE INDEX IF NOT EXISTS volunteer_hours_user_idx ON volunteer_hours (user_id);

CREATE TABLE IF NOT EXISTS user_jurisdiction_hours (
  user_id             uuid NOT NULL REFERENCES users(id),
  jurisdiction_geoid  text NOT NULL REFERENCES jurisdictions(geoid),
  total_hours         numeric(8, 2) NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, jurisdiction_geoid)
);

-- Leaderboard ranking: for a jurisdiction, order by hours DESC then user_id (a total order for stable
-- keyset/offset paging). The (geoid, total_hours DESC, user_id) prefix serves the WHERE + ORDER BY + paging
-- without a sort.
CREATE INDEX IF NOT EXISTS user_jurisdiction_hours_leaderboard_idx
  ON user_jurisdiction_hours (jurisdiction_geoid, total_hours DESC, user_id);
