-- =============================================================================
-- 0005_report_claim_code.sql
-- -----------------------------------------------------------------------------
-- Moves the anonymous-report claim code from a single per-TOKEN column to a
-- per-REPORT column, so each of the up-to-5 reports an anon token may submit is
-- independently status-queryable and claimable.
--
-- BACKGROUND (the bug this fixes): the claim code used to live on
-- anon_tokens.claim_code, a single column overwritten on every submit. With a
-- per-token report cap of 5, only the LATEST report's code survived, so the four
-- earlier reports could neither be status-queried (/anon/reports/:id/status) nor
-- claimed (/claim/report). The cap is a TOKEN property and stays on anon_tokens
-- (its atomic UPDATE ... WHERE report_count < cap is untouched); only the claim
-- code moves to the report row, which is where a per-report secret belongs.
--
--   * claim_code  text, nullable. The single-use secret minted at report insert
--                 and returned in AnonReportResponse.claimCode. NULL once the
--                 report is claimed (single-use consume) or for non-anon reports.
--   * reports_claim_code_key  a PARTIAL UNIQUE index (WHERE claim_code IS NOT NULL)
--                 so an active code resolves to exactly one report (the claim
--                 lookup selects FOR UPDATE by this column) while the many rows
--                 with a NULL code do not collide. The 256-bit code is globally
--                 unguessable, so uniqueness is effectively guaranteed by the RNG;
--                 the index makes the lookup an index seek and enforces the
--                 invariant defensively.
--
-- anon_tokens.claim_code is intentionally LEFT in place (dropping a column is a
-- heavier, riskier migration and it is harmless): it is simply no longer written
-- or read for status/claim. The repository now stamps + verifies + consumes the
-- code on reports.claim_code exclusively.
--
-- CANONICAL DDL: this hand-authored SQL is the source of truth. The Drizzle
-- definition in src/db/schema/reports.ts mirrors it for typed queries.
--
-- Ordering rules:
--   * Requires 0001_core.sql (reports) already applied.
--   * IF NOT EXISTS so a partial / repeat apply is safe; the migrate runner also
--     records applied files in _civfix_migrations.
-- =============================================================================

ALTER TABLE reports ADD COLUMN IF NOT EXISTS claim_code text;

CREATE UNIQUE INDEX IF NOT EXISTS reports_claim_code_key
  ON reports (claim_code)
  WHERE claim_code IS NOT NULL;
