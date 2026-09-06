-- =============================================================================
-- 0156_org_eligibility_ein_provenance.sql
-- -----------------------------------------------------------------------------
-- WHERE the EIN civfix screens an organization under came from. The EIN is
-- copied into org_eligibility the moment an operator approves a nonprofit
-- verification (org_verifications.ein_number is scrubbed 90 days later) or is
-- set/corrected by an operator. Provenance is part of the Rev. Proc. 2018-32
-- evidence trail: a verdict is only as good as the identifier it was computed
-- for, and an operator must be able to see who asserted it and when.
--
-- CANONICAL DDL: hand-authored source of truth. Mirror: schema/org_eligibility.ts.
-- Also carries contributions_deductible, written by every evaluation.
-- Idempotent (ADD COLUMN IF NOT EXISTS); forward-only; no data rewrite.
-- Ordering rules: requires 0147_org_eligibility.sql.
-- =============================================================================

ALTER TABLE org_eligibility
  ADD COLUMN IF NOT EXISTS ein_source text
    CHECK (ein_source IN ('org_verification', 'operator'));

ALTER TABLE org_eligibility
  ADD COLUMN IF NOT EXISTS ein_set_at timestamptz;

ALTER TABLE org_eligibility
  ADD COLUMN IF NOT EXISTS ein_set_by uuid REFERENCES users(id) ON DELETE SET NULL;

-- Deductibility is a property of the exemption EVIDENCE (Pub 78 listing or a
-- deductible BMF code), never of the verdict: an OFAC review flag does not
-- change whether a gift is deductible, and receipts/donate pages read this
-- column instead of inferring it from the verdict.
ALTER TABLE org_eligibility
  ADD COLUMN IF NOT EXISTS contributions_deductible boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN org_eligibility.ein_source IS
  'Who asserted the EIN civfix screens under: the approved org_verifications application, or an operator correction. Changing the EIN resets the verdict to unknown; evidence rows for the previous EIN are kept but no longer read.';
