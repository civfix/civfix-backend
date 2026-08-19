-- =============================================================================
-- 0087_media_finalized_at.sql
-- -----------------------------------------------------------------------------
-- FINDING F071: the media finalize path can run more than once for one asset
-- (retries, duplicate callbacks), and without a persisted "already finalized"
-- marker the side effects (count bumps, notifications) can double-fire. Add a
-- nullable finalized_at watermark; mediaapi's finalize becomes a conditional
-- `UPDATE ... SET finalized_at = now() WHERE finalized_at IS NULL RETURNING ...`
-- so exactly one caller wins and the rest see zero rows and no-op.
--
-- Nullable, no backfill (NULL = not yet finalized).
--
-- CANONICAL DDL: hand-authored source of truth. Mirror: schema/media.ts.
--
-- Conventions: additive ADD COLUMN IF NOT EXISTS; one transaction per file
-- (src/db/migrate.ts). Forward-only, no down.
--
-- Ordering rules: requires 0001_core.sql (media_assets base table).
-- =============================================================================

ALTER TABLE media_assets
  ADD COLUMN IF NOT EXISTS finalized_at timestamptz;
