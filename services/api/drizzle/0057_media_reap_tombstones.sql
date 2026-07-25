-- =============================================================================
-- 0057_media_reap_tombstones.sql
-- -----------------------------------------------------------------------------
-- DURABILITY (audit 2026-07-24 wave 2, media-worker LOW): the orphan sweep can
-- leak R2 objects permanently.
--
-- The sweep deletes the media_assets ROW FIRST and the physical objects second -
-- deliberately, because the old order (check references -> delete objects ->
-- delete row) let a concurrent commit attach a new row to the same r2_key between
-- the check and the delete, destroying a just-committed report's media. The cost
-- of the safe order is that once the row is gone NOTHING remembers the keys, so a
-- storage DELETE that fails is an object stranded in the bucket forever: unbilled
-- to any subject, invisible to every future sweep, and (being unreviewed
-- user-uploaded content) not something we want to keep.
--
-- media_reap_tombstones is that memory: one row per key whose physical delete
-- failed after its media row was reaped. The next orphan sweep retries them and
-- deletes the tombstone on success. `attempts` bounds the retry so a key R2 will
-- never accept (or one already gone) cannot be retried hourly forever - the row
-- is LEFT BEHIND at the cap, on purpose, as the operator-visible record that a
-- manual bucket cleanup is needed.
--
-- media_id is informational and deliberately NOT a foreign key: the media_assets
-- row is already deleted by the time a tombstone is written, so a FK could never
-- be satisfied. r2_key is the PK because the key IS the identity of the object to
-- delete, and two media rows can legitimately share one key (the sweep's
-- reference re-check) - a duplicate tombstone would just double the retries.
--
-- Conventions (match the rest of the suite): timestamptz, additive
-- IF NOT EXISTS so a partial or repeat apply is safe; the migrate runner
-- (src/db/migrate.ts) records applied files and wraps each file in one
-- transaction. Forward-only - there is no down migration in this suite.
--
-- CANONICAL DDL: this hand-authored SQL is the source of truth. The Drizzle mirror
-- lives in src/db/schema/media_reap_tombstones.ts.
--
-- Ordering rules: standalone (no FKs, no dependencies).
-- =============================================================================

CREATE TABLE IF NOT EXISTS media_reap_tombstones (
  r2_key          text        PRIMARY KEY,
  media_id        uuid,
  attempts        integer     NOT NULL DEFAULT 1,
  last_error      text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  last_attempt_at timestamptz NOT NULL DEFAULT now()
);

-- The retry scan is "not past the attempt cap, oldest first" (see
-- MediaWorkerRepo.listLeakedObjects). Leading with attempts keeps the capped rows
-- - the ones that accumulate - out of the scanned range entirely.
CREATE INDEX IF NOT EXISTS media_reap_tombstones_retry_idx
  ON media_reap_tombstones (attempts, created_at);
