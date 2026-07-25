-- =============================================================================
-- 0056_abuse_flags_worker_open_unique.sql
-- -----------------------------------------------------------------------------
-- SECURITY / OPERATIONS (audit 2026-07-24 wave 2, media-worker issue 3): the
-- media.checks job writes its abuse_flags BEFORE the terminal media status, so a
-- persist failure after the flags land is retried by pg-boss (retryLimit 5) and
-- re-inserts the SAME flag. The anon hold-release gate counts OPEN flags, so the
-- duplicates are not cosmetic: a moderator has to clear N rows to publish one
-- report, and every extra row is another chance to leave it held forever.
--
-- The flag-first order is deliberate (writing the status first leaves a window
-- where the gate sees "all media ready, zero flags" and publishes a report whose
-- media was supposed to carry a review flag), and the job is otherwise
-- idempotent, so the right place to absorb the retry is the database: at most one
-- OPEN worker-raised flag per (subject_type, subject_id, reason), which lets
-- insertAbuseFlag use ON CONFLICT DO NOTHING (media-worker-repo.ts).
--
-- SCOPED TO source = 'worker' ON PURPOSE. The other writers must keep inserting
-- freely: admin discovery "start task" inserts ('report', id, 'manual', 'api')
-- with NO existing-flag guard (discovery-repository.drizzle.ts), so a
-- source-agnostic unique index would turn a repeat operator click into a 500,
-- and a future user_report lane must be able to record N reporters raising the
-- same reason against one subject. Only the worker lane is at-least-once, and
-- only the worker lane is deduped.
--
-- Collapse any pre-existing duplicate OPEN worker rows first (keep the earliest)
-- so the unique index can build; on a fresh DB this DELETE is a no-op.
-- created_at is NULLable (0001_core.sql: DEFAULT now(), no NOT NULL), hence the
-- COALESCE - a plain `>` comparison is NULL for a NULL-timestamped pair and would
-- leave exactly the duplicates this has to remove.
--
-- Conventions (match the rest of the suite): additive IF NOT EXISTS so a partial
-- or repeat apply is safe; the migrate runner (src/db/migrate.ts) records applied
-- files and wraps each file in one transaction (which is also why the index is
-- built without CONCURRENTLY). Forward-only - there is no down migration.
--
-- Ordering rules: requires 0001_core.sql (abuse_flags).
-- =============================================================================

DELETE FROM abuse_flags a
USING abuse_flags b
WHERE a.resolved_at IS NULL
  AND b.resolved_at IS NULL
  AND a.source = 'worker'
  AND b.source = 'worker'
  AND a.subject_type = b.subject_type
  AND a.subject_id = b.subject_id
  AND a.reason = b.reason
  AND (COALESCE(a.created_at, '-infinity'::timestamptz), a.id)
    > (COALESCE(b.created_at, '-infinity'::timestamptz), b.id);

CREATE UNIQUE INDEX IF NOT EXISTS abuse_flags_worker_open_subject_reason_key
  ON abuse_flags (subject_type, subject_id, reason)
  WHERE resolved_at IS NULL AND source = 'worker';
