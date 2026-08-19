-- =============================================================================
-- 0077_media_single_claim_validate.sql
-- -----------------------------------------------------------------------------
-- FINDING F017 / F049 (validation half). 0076 added media_single_claim_chk as
-- NOT VALID; validate it here in a SEPARATE file so a slow validation scan cannot
-- strand 0076 mid-apply. Trivial on pre-launch volumes. Guarded so a re-run (or a
-- run before 0076 on a partial history) is a no-op — VALIDATE has no IF EXISTS.
--
-- CANONICAL DDL: hand-authored source of truth. No shape change → no mirror edit.
--
-- Conventions: one transaction per file (src/db/migrate.ts). Forward-only, no down.
--
-- Ordering rules: requires 0076_media_single_claim_check.sql.
-- =============================================================================

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'media_single_claim_chk' AND conrelid = 'media_assets'::regclass
  ) THEN
    ALTER TABLE media_assets VALIDATE CONSTRAINT media_single_claim_chk;
  END IF;
END $$;
