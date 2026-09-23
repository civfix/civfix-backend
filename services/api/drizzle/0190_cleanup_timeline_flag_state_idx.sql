-- =============================================================================
-- 0190_cleanup_timeline_flag_state_idx.sql
-- -----------------------------------------------------------------------------
-- An event's operator flag state is its newest flag/unflag timeline entry
-- (admin-event-repository.drizzle.ts flaggedEventExpr):
--
--   WHERE ct.cleanup_id = c.id AND ct.kind IN ('flag', 'unflag')
--   ORDER BY ct.created_at DESC, ct.id DESC LIMIT 1
--
-- It is evaluated per cleanup by the admin events list, detail, bucket counts,
-- the flagged-only filter and the admin home pins. Through
-- cleanup_timeline_cleanup_idx (cleanup_id, created_at) each probe walked the
-- whole timeline of the cleanup; a never-flagged cleanup read all of it. With
-- the predicate and order matched exactly, each probe reads at most one entry.
--
-- NOT A HOT TABLE: `cleanup_timeline` is absent from the hot-table list in
-- docs/out-of-band-indexes.md, so this builds inline. If it has grown large by
-- the time this deploys, build it with CREATE INDEX CONCURRENTLY first and the
-- IF NOT EXISTS guard turns this into a no-op.
--
-- CANONICAL DDL: hand-authored source of truth. Mirror: schema/cleanup_timeline.ts.
--
-- Conventions: one concern per file; one transaction per file. Forward-only,
-- no down.
--
-- Ordering rules: requires 0007_admin_phase2.sql (cleanup_timeline).
-- =============================================================================

CREATE INDEX IF NOT EXISTS cleanup_timeline_flag_state_idx
  ON cleanup_timeline (cleanup_id, created_at DESC, id DESC)
  WHERE kind IN ('flag', 'unflag');
