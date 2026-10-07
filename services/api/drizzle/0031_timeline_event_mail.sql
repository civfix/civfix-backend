-- =============================================================================
-- 0031_timeline_event_mail.sql
-- -----------------------------------------------------------------------------
-- Issue #56: richer report timeline + EVENT (cleanup) mail threading.
--   * report_timeline.kind / report_timeline.body (D13): stop truncating inbound
--     reply bodies: `note` stays the short preview, `body` holds the full text,
--     `kind` tags the entry type. Both NULLABLE so existing INSERTs stay green.
--   * mail_threads.cleanup_id (D10/D19): nullable FK so an event resource-request
--     thread routes a city reply back onto the cleanup (event) it belongs to,
--     mirroring the existing report_id linkage. Partial index mirrors
--     mail_threads_report_idx (0020).
--
-- CANONICAL DDL: this hand-authored SQL is the source of truth. The Drizzle
-- definitions under src/db/schema mirror it for typed queries / diff inspection.
--
-- Ordering rules:
--   * Requires 0001_core.sql (report_timeline, cleanups) and 0007_admin_phase2.sql
--     (mail_threads) already applied.
--   * Additive ALTERs + IF NOT EXISTS so a partial or repeat apply is safe.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- report_timeline full body (D13). `note` keeps the short collapsed preview;
-- `body` carries the full (untruncated) inbound text; `kind` tags the entry.
-- -----------------------------------------------------------------------------
ALTER TABLE report_timeline ADD COLUMN IF NOT EXISTS kind text;
ALTER TABLE report_timeline ADD COLUMN IF NOT EXISTS body text;

-- -----------------------------------------------------------------------------
-- mail_threads EVENT linkage (D10/D19). Nullable FK: only event resource-request
-- threads carry a cleanup_id (report threads carry report_id; digest/compose
-- threads carry neither). ON DELETE SET NULL mirrors the report_id behavior.
-- -----------------------------------------------------------------------------
ALTER TABLE mail_threads ADD COLUMN IF NOT EXISTS cleanup_id uuid
  REFERENCES cleanups (id) ON DELETE SET NULL;

-- Partial index over the linked rows only, mirroring mail_threads_report_idx
-- (0020): a city reply resolves to its event thread by cleanup_id.
CREATE INDEX IF NOT EXISTS mail_threads_cleanup_idx
  ON mail_threads (cleanup_id) WHERE cleanup_id IS NOT NULL;
