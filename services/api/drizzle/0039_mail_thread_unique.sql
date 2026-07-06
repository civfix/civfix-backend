-- =============================================================================
-- 0039_mail_thread_unique.sql
-- -----------------------------------------------------------------------------
-- F73: make "at most one mail thread per subject" a DB invariant, so the
-- find-or-create paths are race-safe via ON CONFLICT instead of the old
-- SELECT-then-INSERT (which could create duplicate threads under concurrency).
-- Three disjoint subjects: a report, a cleanup event, or a jurisdiction-only
-- (geoid) thread with no report/cleanup.
--
-- Before adding the partial UNIQUE indexes, MERGE any pre-existing duplicates
-- into the newest survivor per subject: repoint both child tables
-- (mail_messages ON DELETE CASCADE, mail_events ON DELETE SET NULL) onto the
-- survivor, then delete the losers so no messages/events are orphaned or lost.
-- On a fresh DB every merge is a no-op. Temp tables are transaction-scoped
-- (ON COMMIT DROP) and the runner wraps each file in one transaction.
-- =============================================================================

-- 1) Report-scoped duplicates.
CREATE TEMP TABLE _mt_merge_report ON COMMIT DROP AS
SELECT t.id AS loser, s.id AS survivor
FROM mail_threads t
JOIN LATERAL (
  SELECT id FROM mail_threads x
  WHERE x.report_id = t.report_id
  ORDER BY x.created_at DESC, x.id DESC
  LIMIT 1
) s ON true
WHERE t.report_id IS NOT NULL AND t.id <> s.id;
UPDATE mail_messages m SET thread_id = mm.survivor FROM _mt_merge_report mm WHERE m.thread_id = mm.loser;
UPDATE mail_events e SET thread_id = mm.survivor FROM _mt_merge_report mm WHERE e.thread_id = mm.loser;
DELETE FROM mail_threads WHERE id IN (SELECT loser FROM _mt_merge_report);

-- 2) Cleanup-scoped duplicates.
CREATE TEMP TABLE _mt_merge_cleanup ON COMMIT DROP AS
SELECT t.id AS loser, s.id AS survivor
FROM mail_threads t
JOIN LATERAL (
  SELECT id FROM mail_threads x
  WHERE x.cleanup_id = t.cleanup_id
  ORDER BY x.created_at DESC, x.id DESC
  LIMIT 1
) s ON true
WHERE t.cleanup_id IS NOT NULL AND t.id <> s.id;
UPDATE mail_messages m SET thread_id = mm.survivor FROM _mt_merge_cleanup mm WHERE m.thread_id = mm.loser;
UPDATE mail_events e SET thread_id = mm.survivor FROM _mt_merge_cleanup mm WHERE e.thread_id = mm.loser;
DELETE FROM mail_threads WHERE id IN (SELECT loser FROM _mt_merge_cleanup);

-- 3) Jurisdiction-only duplicates (no report, no cleanup).
CREATE TEMP TABLE _mt_merge_geoid ON COMMIT DROP AS
SELECT t.id AS loser, s.id AS survivor
FROM mail_threads t
JOIN LATERAL (
  SELECT id FROM mail_threads x
  WHERE x.jurisdiction_geoid = t.jurisdiction_geoid
    AND x.report_id IS NULL AND x.cleanup_id IS NULL
  ORDER BY x.created_at DESC, x.id DESC
  LIMIT 1
) s ON true
WHERE t.report_id IS NULL AND t.cleanup_id IS NULL
  AND t.jurisdiction_geoid IS NOT NULL AND t.id <> s.id;
UPDATE mail_messages m SET thread_id = mm.survivor FROM _mt_merge_geoid mm WHERE m.thread_id = mm.loser;
UPDATE mail_events e SET thread_id = mm.survivor FROM _mt_merge_geoid mm WHERE e.thread_id = mm.loser;
DELETE FROM mail_threads WHERE id IN (SELECT loser FROM _mt_merge_geoid);

-- 4) The partial UNIQUE indexes the ON CONFLICT paths arbitrate on.
CREATE UNIQUE INDEX IF NOT EXISTS mail_threads_report_uk
  ON mail_threads (report_id)
  WHERE report_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS mail_threads_cleanup_uk
  ON mail_threads (cleanup_id)
  WHERE cleanup_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS mail_threads_geoid_only_uk
  ON mail_threads (jurisdiction_geoid)
  WHERE report_id IS NULL AND cleanup_id IS NULL AND jurisdiction_geoid IS NOT NULL;
