-- =============================================================================
-- 0018_event_reports_and_kind.sql
-- -----------------------------------------------------------------------------
-- Event <-> report linking + event kinds. The user-facing "event" is the
-- cleanups domain; this migration adds the connective tissue between a cleanup
-- and the civic reports it organizes around:
--
--   * cleanups.event_kind  - distinguishes a "cleanup" (the report-linkable
--     kind) from "other_volunteer" (a distinct map marker with no report links).
--     Defaults to 'cleanup' so every existing row + the existing create flow are
--     unchanged. CHECK pins it to the two contract values (EVENT_KIND_VALUES).
--
--   * cleanup_reports  - the junction table that IS the durable source of truth
--     for an event<->report link (linked_by_user_id + linked_at). A cleanup's
--     "Reports we'll handle" gallery and a report's "Cleanup events" gallery both
--     read it. The report-side timeline entry is SYNTHESIZED on the client from
--     ReportDTO.linkedEvents[] (no report_timeline write); the EVENT side gets a
--     real cleanup_timeline row (kind 'report_linked'/'report_unlinked'), which
--     is free-text so no enum/CHECK change is needed there.
--
-- Mirrors the cleanup_members composite-uniqueness + reverse-index pattern: a
-- report links to a cleanup at most once (UNIQUE(cleanup_id, report_id)) and both
-- directions are indexed (cleanup_id for the event gallery, report_id for the
-- report gallery). Deleting either side cascades the junction row away.
--
-- CANONICAL DDL: this hand-authored SQL is the source of truth. The Drizzle
-- definitions under src/db/schema mirror it for typed queries / diff inspection
-- (src/db/schema/cleanup_reports.ts + the event_kind column in cleanups.ts).
--
-- Conventions (match Phase 1/2): timestamptz, gen_random_uuid() defaults
-- (pgcrypto, enabled in 0000_extensions.sql), status/kind CHECK constraints,
-- additive IF NOT EXISTS so a partial or repeat apply is safe; the migrate runner
-- (src/db/migrate.ts) records applied files and wraps each file in one transaction.
--
-- Ordering rules:
--   * Requires 0000_extensions.sql (pgcrypto for gen_random_uuid()).
--   * Requires 0001_core.sql (cleanups, reports, users).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- cleanups.event_kind  (cleanup vs other_volunteer). DEFAULT 'cleanup' keeps every
-- existing row + the create flow that does not send it unchanged. The CHECK pins
-- the column to the two contract values; only eventKind='cleanup' events may link
-- reports / show the gallery (the service rejects linking on other_volunteer).
-- -----------------------------------------------------------------------------
ALTER TABLE cleanups
  ADD COLUMN IF NOT EXISTS event_kind text NOT NULL DEFAULT 'cleanup'
  CHECK (event_kind IN ('cleanup', 'other_volunteer'));

-- -----------------------------------------------------------------------------
-- cleanup_reports  (event <-> report junction; the durable source of truth for a
-- link). One row per (cleanup, report); UNIQUE(cleanup_id, report_id) makes a
-- re-link a single ON CONFLICT DO NOTHING. `linked_by_user_id` is the actor
-- (nullable; no cascade so the link survives a soft-deleted actor) and `linked_at`
-- stamps when the link was made (carried into the LinkedReportRef / LinkedEventRef
-- so the client can synthesize the report-side "Linked to cleanup X" timeline node).
-- Deleting either the cleanup or the report cascades the junction row away.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS cleanup_reports (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  cleanup_id        uuid        NOT NULL REFERENCES cleanups (id) ON DELETE CASCADE,
  report_id         uuid        NOT NULL REFERENCES reports (id)  ON DELETE CASCADE,
  linked_by_user_id uuid        REFERENCES users (id),
  linked_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (cleanup_id, report_id)
);
-- Reverse indexes: the event-detail gallery scans by cleanup_id; the report-detail
-- gallery (+ the batched ANY(report_id) hydration) scans by report_id.
CREATE INDEX IF NOT EXISTS cleanup_reports_cleanup_idx ON cleanup_reports (cleanup_id);
CREATE INDEX IF NOT EXISTS cleanup_reports_report_idx  ON cleanup_reports (report_id);
