-- =============================================================================
-- 0092_anon_tokens_claim_code_null.sql
-- -----------------------------------------------------------------------------
-- FINDING F150 (part 2): anon_tokens.claim_code is a DEAD plaintext column — the
-- per-report claim secret moved to reports.claim_code (0005) and now to its hash
-- (0091); nothing reads anon_tokens.claim_code anymore. NULL it out so no stale
-- plaintext secret sits in the token table. The column DROP is deferred to the
-- same follow-up release that drops reports.claim_code.
--
-- Idempotent: a second run matches zero rows (all already NULL).
--
-- CANONICAL DDL: hand-authored source of truth. Data-only (column still exists) →
-- no mirror shape change; schema/anon.ts keeps claimCode with a deprecation NOTE.
--
-- Conventions: one transaction per file (src/db/migrate.ts). Forward-only, no down.
--
-- Ordering rules: requires 0001_core.sql (anon_tokens).
-- =============================================================================

UPDATE anon_tokens
SET claim_code = NULL
WHERE claim_code IS NOT NULL;
