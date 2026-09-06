-- =============================================================================
-- 0159_host_exports_run_token.sql
-- -----------------------------------------------------------------------------
-- A claim token so a slow export run cannot be overwritten by its own retry.
--
-- claimForRun moves a row to 'running'; markReady wrote the finished object's
-- key back on the sole condition that the row was still 'running'. A run that
-- legitimately outlives the job's visibility timeout is redelivered by pg-boss,
-- the second run reclaims the STALE row, and whichever finishes last overwrites
-- r2_key -- orphaning the other run's object in the bucket forever (it is never
-- reaped, because reaping reads r2_key from the row).
--
-- run_token is stamped fresh by every claim and required by markReady, so the
-- loser of that race writes nothing and deletes the object it just uploaded.
--
-- host_exports is empty on every environment at this point in the change set.
--
-- LOCK ORDER: host_exports
-- =============================================================================

ALTER TABLE host_exports
  ADD COLUMN IF NOT EXISTS run_token uuid;
