-- =============================================================================
-- 0098_sweep_predicate_indexes.sql
-- -----------------------------------------------------------------------------
-- FINDING H13 (supporting index) + the audit's "sweep predicates have no index"
-- medium: the hourly orphan sweep (findOrphans / deleteOrphan in
-- services/media-worker-repo.ts) scans media_assets for rows with NO binding
-- older than the orphan TTL, and the nightly retention sweep scans email_otps
-- for consumed/expired rows. Neither predicate had a supporting index, so both
-- ran a sequential scan every run.
--
-- media_assets is a HOT table, and a plain CREATE INDEX takes ACCESS EXCLUSIVE
-- for the whole build. The DO block below therefore builds the index INSIDE the
-- migration only while the table is still small (the pre-launch case, where the
-- build is instant); on a table past the threshold it does nothing and logs the
-- exact out-of-band command instead. The command is idempotent with this file:
--
--     CREATE INDEX CONCURRENTLY IF NOT EXISTS media_assets_orphan_sweep_idx
--       ON media_assets (created_at)
--       WHERE report_id IS NULL
--         AND chat_message_id IS NULL
--         AND post_id IS NULL
--         AND purpose <> 'verification';
--
-- (run it OUTSIDE a transaction, then re-run the migration set: the guard sees
-- the index and no-ops). docs/media-served-key.md carries the same command in
-- the deploy runbook.
--
-- The index predicate is the STABLE part of the orphan predicate — the two
-- avatar NOT EXISTS probes and the `created_at < cutoff` bound are evaluated on
-- the (now much smaller) candidate set; created_at is the index key so the age
-- bound is served from the index tuple.
--
-- email_otps is a small, high-churn table (1h TTL after consume/expiry), so its
-- two indexes are built inline: one on expires_at and one partial on
-- consumed_at, which Postgres can BitmapOr for the sweep's
-- `consumed_at IS NOT NULL OR expires_at < cutoff` predicate.
--
-- CANONICAL DDL: hand-authored source of truth. Mirror: schema/media.ts,
-- schema/email-otps.ts.
--
-- Conventions: additive CREATE INDEX IF NOT EXISTS; one transaction per file
-- (src/db/migrate.ts), so no CONCURRENTLY inside this file. Forward-only, no down.
--
-- Ordering rules: requires 0001_core.sql (media_assets) and the email_otps table.
-- =============================================================================

DO $$
DECLARE
  approx_rows bigint;
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_class WHERE relname = 'media_assets_orphan_sweep_idx'
  ) THEN
    RETURN;
  END IF;

  SELECT GREATEST(COALESCE(c.reltuples, 0), 0)::bigint INTO approx_rows
  FROM pg_class c WHERE c.relname = 'media_assets' AND c.relkind = 'r';

  IF approx_rows > 100000 THEN
    RAISE NOTICE 'media_assets has ~% rows: skipping the in-migration index build. Build it out of band with CREATE INDEX CONCURRENTLY IF NOT EXISTS media_assets_orphan_sweep_idx ON media_assets (created_at) WHERE report_id IS NULL AND chat_message_id IS NULL AND post_id IS NULL AND purpose <> ''verification''; then re-run the migrations.', approx_rows;
    RETURN;
  END IF;

  CREATE INDEX media_assets_orphan_sweep_idx
    ON media_assets (created_at)
    WHERE report_id IS NULL
      AND chat_message_id IS NULL
      AND post_id IS NULL
      AND purpose <> 'verification';
END
$$;

CREATE INDEX IF NOT EXISTS email_otps_expires_idx
  ON email_otps (expires_at);

CREATE INDEX IF NOT EXISTS email_otps_consumed_idx
  ON email_otps (consumed_at)
  WHERE consumed_at IS NOT NULL;
