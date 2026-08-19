-- =============================================================================
-- 0091_report_claim_code_hash.sql
-- -----------------------------------------------------------------------------
-- FINDING F150: reports.claim_code stores the single-use anon claim secret in
-- PLAINTEXT, and a DB/backup/log leak hands an attacker every unclaimed report.
-- Store a SHA-256 hash instead and resolve a presented code by hashing it. This
-- release is STAGED: add the hash column + backfill + a partial unique index NOW;
-- code switches to matching on the hash. NULLing out and DROPPING the plaintext
-- reports.claim_code column is deferred to a FOLLOW-UP release (this release's
-- code needs nothing from the plaintext column after the switch, but dropping it
-- mid-release would break the migrate→restart window). Do NOT drop it here.
--
-- sha256() is a Postgres 11+ core built-in (no pgcrypto needed). Backfill hashes
-- every existing non-null plaintext code; idempotent via the
-- `claim_code_hash IS NULL` guard. The partial unique index resolves a hash to
-- exactly one report and tolerates the all-NULL pre-backfill / non-anon state.
--
-- CANONICAL DDL: hand-authored source of truth. Mirror: schema/reports.ts
-- (claim_code_hash column + reports_claim_code_hash_key). The existing plaintext
-- claim_code column + reports_claim_code_key stay (drop deferred).
--
-- Conventions: additive ADD COLUMN / CREATE INDEX IF NOT EXISTS; one transaction
-- per file; non-CONCURRENTLY build accepted (pre-launch, trivial rows).
-- Forward-only, no down.
--
-- Ordering rules: requires 0001_core.sql / 0005 (reports.claim_code).
-- =============================================================================

ALTER TABLE reports
  ADD COLUMN IF NOT EXISTS claim_code_hash text;

UPDATE reports
SET claim_code_hash = encode(sha256(claim_code::bytea), 'hex')
WHERE claim_code IS NOT NULL AND claim_code_hash IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS reports_claim_code_hash_key
  ON reports (claim_code_hash)
  WHERE claim_code_hash IS NOT NULL;
