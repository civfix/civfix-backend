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
-- for the whole build, so this file does NOT create that index: it only RAISEs a
-- WARNING while it is missing (the house pattern, docs/out-of-band-indexes.md).
-- Nothing breaks without it - the sweep stays correct and falls back to a
-- sequential scan. Build it by hand, outside any transaction:
--
--     CREATE INDEX CONCURRENTLY IF NOT EXISTS media_assets_orphan_sweep_idx
--       ON media_assets (created_at)
--       WHERE report_id IS NULL
--         AND chat_message_id IS NULL
--         AND post_id IS NULL
--         AND purpose <> 'verification';
--
-- docs/out-of-band-indexes.md carries the same command plus the verification
-- steps; re-running this migration afterwards simply stops warning.
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
-- schema/otp.ts.
--
-- Conventions: additive CREATE INDEX IF NOT EXISTS; one transaction per file
-- (src/db/migrate.ts), so no CONCURRENTLY inside this file. Forward-only, no down.
--
-- Ordering rules: requires 0001_core.sql (media_assets) and the email_otps table.
-- =============================================================================

DO $$
BEGIN
  IF to_regclass('public.media_assets_orphan_sweep_idx') IS NULL THEN
    RAISE WARNING 'media_assets_orphan_sweep_idx is missing - build it out of band with CREATE INDEX CONCURRENTLY (docs/out-of-band-indexes.md); the hourly orphan sweep sequentially scans media_assets until then';
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS email_otps_expires_idx
  ON email_otps (expires_at);

CREATE INDEX IF NOT EXISTS email_otps_consumed_idx
  ON email_otps (consumed_at)
  WHERE consumed_at IS NOT NULL;
