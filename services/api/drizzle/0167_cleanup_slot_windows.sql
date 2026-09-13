-- =============================================================================
-- 0167_cleanup_slot_windows.sql
-- -----------------------------------------------------------------------------
-- Issue #109: a signup slot may carry its own time window inside the event.
-- Both columns NULL = a role that spans the whole event (every slot before this
-- migration). Both-or-neither is a CHECK; "inside the event's scheduled_at/ends_at"
-- cannot be a CHECK (cross-table) and is enforced by cleanup-service toDesiredSlots.
--
-- Uniqueness moves from (event, title) to (event, title, window): two "Sweep"
-- shifts at different times are distinct to a human once the UI prints the time
-- next to the title, and two untimed "Sweep" rows are still rejected. The
-- reconcile's sentinel parking (title = id::text) is unaffected: the sentinel is
-- unique per row whatever the window.
--
-- EXPAND/CONTRACT (docs/migrations-expand-contract.md). That doc flags a validating
-- ADD CONSTRAINT ... CHECK and calls a tightening change a two-release job; both are
-- safe HERE, and this is why. Between the migrate step and the Caddy flip the PREVIOUS
-- image serves live traffic against this schema, so the test is always "what can the
-- OLD image do?".
--
--   * cleanup_slots_window_chk. The two columns it constrains are added by this very
--     file, so every pre-existing row is NULL/NULL, which satisfies the CHECK
--     vacuously — the validation scan cannot find a violating row. The old image has
--     no code path that names starts_at or ends_at, so every row it goes on writing is
--     NULL/NULL too and can never violate it. The scan takes ACCESS EXCLUSIVE, but
--     cleanup_slots is small and is not on the hot-table list in
--     docs/out-of-band-indexes.md, so it is a sub-second lock rather than a stall.
--   * DROP INDEX cleanup_slots_cleanup_title_uidx, then the window index. This LOOSENS
--     uniqueness rather than tightening it, so no write the old image makes can start
--     failing: for the untimed rows it is the only kind it writes, the new index's
--     COALESCE keys collapse to ('-infinity', 'infinity') and it enforces exactly the
--     old (cleanup_id, lower(title)) rule. The old image's duplicate-title mapping
--     also survives the rename: isSlotTitleConflict matches the old index name OR a
--     DETAIL containing 'lower(title)', and the new index's DETAIL reads
--     "Key (cleanup_id, lower(title), COALESCE(starts_at, ...), COALESCE(ends_at, ...))",
--     so a duplicate title still becomes the named 422 and never a leaked 500.
--     The two statements are in one file and therefore one transaction: there is no
--     window in which the table is unprotected.
--
-- Canonical DDL; mirror src/db/schema/cleanup_slots.ts. Idempotent, forward-only,
-- no transaction control (migrate.ts owns it). cleanup_slots is not a hot table
-- (docs/out-of-band-indexes.md), so the index is created inline.
-- Ordering: requires 0063_cleanup_slots.sql.
-- =============================================================================

ALTER TABLE cleanup_slots ADD COLUMN IF NOT EXISTS starts_at timestamptz;
ALTER TABLE cleanup_slots ADD COLUMN IF NOT EXISTS ends_at   timestamptz;

ALTER TABLE cleanup_slots DROP CONSTRAINT IF EXISTS cleanup_slots_window_chk;
ALTER TABLE cleanup_slots ADD  CONSTRAINT cleanup_slots_window_chk
  CHECK ((starts_at IS NULL) = (ends_at IS NULL) AND (ends_at IS NULL OR ends_at > starts_at));

DROP INDEX IF EXISTS cleanup_slots_cleanup_title_uidx;
CREATE UNIQUE INDEX IF NOT EXISTS cleanup_slots_cleanup_title_window_uidx
  ON cleanup_slots (
    cleanup_id,
    lower(title),
    COALESCE(starts_at, '-infinity'::timestamptz),
    COALESCE(ends_at,   'infinity'::timestamptz)
  );

COMMENT ON COLUMN cleanup_slots.starts_at IS
  'Shift start (instant). NULL with ends_at NULL = the slot spans the whole event.';
COMMENT ON COLUMN cleanup_slots.ends_at IS
  'Shift end (instant), > starts_at. Must lie inside cleanups.scheduled_at..ends_at (service-enforced).';
