-- =============================================================================
-- 0095_media_stuck_sweep_rotation.sql
-- -----------------------------------------------------------------------------
-- FINDING F087b: media.stuck.sweep scans `status = 'validating'` rows with NO
-- ordering and NO progress marker, so a permanent resident (an upload intent
-- whose bytes never arrived, or an asset whose checks can never succeed) pins
-- the LIMIT-ed batch forever, starves genuinely stuck rows, and is re-enqueued
-- every 15 minutes for eternity.
--
-- Two columns, same shape as 0088's hold_release_checked_at rotation:
--   stuck_checked_at   nullable watermark; the sweep stamps every row it picks
--                      and orders `ASC NULLS FIRST`, so never-checked rows lead
--                      and a just-checked row goes to the back of the line.
--   stuck_check_count  monotonic pick counter; once it passes the worker's cap
--                      (MEDIA_STUCK_SWEEP_MAX_ATTEMPTS) the sweep terminalizes
--                      the asset as 'rejected' instead of re-enqueueing it
--                      forever (the pipeline's never-throw philosophy: bad
--                      state becomes a terminal status, not an infinite retry).
--
-- The sweep also narrows to `finalized_at IS NOT NULL` (0087's marker, wired by
-- this change set): a row is created 'validating' at PRESIGN time, before any
-- bytes exist, so an unfinalized row is an upload intent — the ORPHAN sweep's
-- job, never the stuck sweep's. Rows finalized BEFORE 0087 was wired carry a
-- NULL finalized_at, which would put them out of the sweep's scope forever --
-- and findOrphans skips any BOUND row, so a bound pre-0087 asset stuck at
-- 'validating' would have no reclaimer at all. The backfill below therefore
-- adopts exactly that stranded set (bound + still validating + never stamped);
-- unbound intents are deliberately left alone for the orphan sweep.
--
-- STALENESS IS KEYED ON finalized_at, NOT created_at (corrected in place; 0095
-- has never been applied outside local dev / testcontainers, both of which
-- rebuild from scratch). created_at is stamped at PRESIGN, so an upload that is
-- finalized an hour after its presign was instantly "stuck" and burned its
-- whole attempt budget before the worker had a chance; finalized_at is the
-- moment the pipeline actually owes a verdict, so every asset gets a full TTL
-- from finalize. The give-up decision inherits the same keying: stuck_check_count
-- only advances on a pick, and a pick now requires finalized_at < now() - TTL.
--
-- The finalize watermark is also load-bearing for CLAIMS: every media bind
-- predicate (report create, anon held-report create, post attach, chat/DM
-- attachment) accepts a 'validating' row only when finalized_at IS NOT NULL, so
-- a bearer of an upload id cannot bind a never-finalized intent — a row with no
-- bytes, no job, and (bound) no orphan-sweep coverage. 'ready' rows are accepted
-- unconditionally because a pre-0087 'ready' row can legitimately carry a NULL
-- finalized_at; 'ready' is post-pipeline by definition. Together with the
-- backfill below this makes "bound + validating" imply "finalized", which is
-- exactly the set the stuck sweep reclaims, so the finalize path no longer needs
-- (and no longer has) a clear-finalized rollback that could revoke an idempotent
-- success already returned to a concurrent caller.
--
-- The two new columns are nullable / defaulted with no backfill (NULL = never
-- checked -> highest priority). The one backfill here is on finalized_at, and
-- it only ever writes rows where it is NULL -- nothing is overwritten.
--
-- The partial index serves the sweep's exact claim query — the ORDER BY is
-- `stuck_checked_at ASC NULLS FIRST, finalized_at` over a tiny slice of a large,
-- write-heavy table, so without it every run sorts all validating rows; carrying
-- finalized_at in the index also serves the `finalized_at < cutoff` filter from
-- the index tuple instead of the heap.
--
-- CANONICAL DDL: hand-authored source of truth. Mirror: schema/media.ts.
--
-- Conventions: additive ADD COLUMN IF NOT EXISTS + CREATE INDEX IF NOT EXISTS;
-- one transaction per file (src/db/migrate.ts); non-CONCURRENTLY build accepted
-- (pre-launch, trivial rows) — on a live-traffic box this index would be built
-- out-of-band with CONCURRENTLY first, leaving that statement an idempotent
-- no-op. Forward-only, no down.
--
-- Ordering rules: requires 0001_core.sql (media_assets) and 0087 (finalized_at).
-- =============================================================================

ALTER TABLE media_assets
  ADD COLUMN IF NOT EXISTS stuck_checked_at timestamptz;

ALTER TABLE media_assets
  ADD COLUMN IF NOT EXISTS stuck_check_count integer NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS media_assets_stuck_sweep_idx
  ON media_assets (stuck_checked_at ASC NULLS FIRST, finalized_at)
  WHERE status = 'validating' AND finalized_at IS NOT NULL;

UPDATE media_assets
   SET finalized_at = created_at
 WHERE status = 'validating'
   AND finalized_at IS NULL
   AND (report_id IS NOT NULL OR chat_message_id IS NOT NULL OR post_id IS NOT NULL);
