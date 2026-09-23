-- =============================================================================
-- 0192_broadcast_deliveries_broadcast_created_idx.sql
-- -----------------------------------------------------------------------------
-- The host's delivery log pages one broadcast's deliveries newest-first with
-- the house keyset cursor:
--
--   WHERE broadcast_id = $1 [AND status = ..] [AND channel = ..]
--     [AND (created_at, id) < (..)] ORDER BY created_at DESC, id DESC LIMIT n
--
-- broadcast_deliveries_rollup_idx (broadcast_id, channel, status) made every
-- page fetch and sort all of the broadcast's deliveries (up to recipients x
-- channels). With this index a keyset page is an index range. Cost: one more
-- index maintained on every delivery insert.
--
-- NOT A HOT TABLE: `broadcast_deliveries` is absent from the hot-table list in
-- docs/out-of-band-indexes.md, so this builds inline. If it has grown large by
-- the time this deploys, build it with CREATE INDEX CONCURRENTLY first and the
-- IF NOT EXISTS guard turns this into a no-op.
--
-- CANONICAL DDL: hand-authored source of truth. Mirror: schema/broadcast_deliveries.ts.
--
-- Conventions: one concern per file; one transaction per file. Forward-only,
-- no down.
--
-- Ordering rules: requires 0130_broadcasts.sql.
-- =============================================================================

CREATE INDEX IF NOT EXISTS broadcast_deliveries_broadcast_created_idx
  ON broadcast_deliveries (broadcast_id, created_at DESC, id DESC);
