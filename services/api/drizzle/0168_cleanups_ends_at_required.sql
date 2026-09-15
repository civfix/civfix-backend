-- =============================================================================
-- 0168_cleanups_ends_at_required.sql
-- -----------------------------------------------------------------------------
-- An event's public status becomes a CLOCK READING (DECISIONS §40): `active` is
-- "start <= now < end" and `done` is "now >= end". `cancelled` stays the only
-- stored decision. That makes ends_at load-bearing on every read path, so it can
-- no longer be NULL.
--
-- BACKFILL. Rows created before this migration may have no ends_at (the column
-- was optional). They are filled with scheduled_at + 4 hours -- the client's
-- DEFAULT_EVENT_DURATION_MS, the same default createCleanup now applies when a
-- caller omits endsAt. The UPDATE touches ONLY rows where ends_at IS NULL; it
-- never overwrites a value a host actually chose. No hours outcome changes: the
-- creditable-hours cap prefers completed_at whenever a legacy completion stamp
-- exists and only falls back to ends_at when it does not (DECISIONS §41).
--
-- ONE TRANSACTION IS FINE HERE. The runner takes one transaction per file, so
-- the backfill, the SET NOT NULL (which rewrites no rows -- it only validates)
-- and the two non-CONCURRENT index builds all take an ACCESS EXCLUSIVE lock on
-- `cleanups` together. That is acceptable because `cleanups` is a small, cold
-- table by the standards of the hot set (reports, chat_messages, media_assets,
-- users) -- the same justification 0135 made for its non-CONCURRENT build. If
-- cleanups ever grows to hot-table size this becomes an out-of-band job and this
-- file stays as the idempotent no-op it already is.
--
-- REMINDER INDEX REWORK. 0135's partial index was `WHERE status = 'upcoming'`,
-- which was correct only while 'upcoming' was the one live stored value. Legacy
-- rows an operator or the retired "mark completed" action wrote as 'active' were
-- silently skipped by both that index and the sweep's matching predicate, so a
-- future event in that state never got its reminders. The sweep now filters on
-- `status <> 'cancelled'` (its `scheduled_at > now()` predicate already excludes
-- past rows), and the index follows it.
--
-- cleanups_ends_at_idx supports the new derivation: every list filter, the
-- portfolio split and the no-show sweep now range-scan ends_at against now().
--
-- cleanups_status_idx (0001) stays -- the cancelled filters still use it -- and
-- so does the cleanups_ends_after_start_chk CHECK.
--
-- Forward-only and idempotent: re-running fills nothing, re-asserts NOT NULL and
-- no-ops both index builds.
-- =============================================================================

UPDATE cleanups SET ends_at = scheduled_at + interval '4 hours' WHERE ends_at IS NULL;

ALTER TABLE cleanups ALTER COLUMN ends_at SET NOT NULL;

CREATE INDEX IF NOT EXISTS cleanups_ends_at_idx ON cleanups (ends_at);

DROP INDEX IF EXISTS cleanups_reminder_sweep_idx;

CREATE INDEX IF NOT EXISTS cleanups_reminder_sweep_v2_idx
  ON cleanups (scheduled_at)
  WHERE status <> 'cancelled';

COMMENT ON COLUMN cleanups.ends_at IS 'Required. The event''s end instant; ends_at - scheduled_at bounds creditable volunteer hours and derives the public status (done once now >= ends_at). Rows created before 0168 were backfilled with scheduled_at + 4 h (the client-side DEFAULT_EVENT_DURATION_MS).';

COMMENT ON COLUMN cleanups.completed_at IS 'Legacy. Stamped by the retired host "mark completed" action before 0168; never written since. When present it is the true run-time and still wins over ends_at for the hours cap.';
