-- =============================================================================
-- 0147_org_eligibility.sql
-- -----------------------------------------------------------------------------
-- The section 316 good-standing gate: is this organization allowed to be
-- solicited for, right now, and what evidence says so.
--
-- Three tables:
--   org_eligibility             the CURRENT verdict (one row per org), derived
--                               purely from the evidence rows by the shared
--                               `evaluateEligibility` predicate.
--   org_eligibility_checks      APPEND-ONLY evidence (Rev. Proc. 2018-32 8.01).
--                               A row is NEVER updated and never deleted before
--                               its retention_until. It records which published
--                               list revision was consulted, the sha256 of the
--                               raw report and the object key it was archived
--                               under, so a verdict can be reconstructed exactly
--                               as it stood on the day a donation was authorized.
--   eligibility_source_revisions  "did the published list change" gate, so the
--                               Wednesday MNOS job is a no-op on an unchanged
--                               revision instead of re-appending evidence.
--
-- WHY APPEND-ONLY MATTERS: the evidence is the defence. If a charity is later
-- revoked, civfix must be able to show what the IRS/FTB/AG lists said at
-- authorization time. An UPDATE would destroy that. A unit test greps this
-- repository's source for `UPDATE org_eligibility_checks` and fails on a hit.
--
-- OFAC NEVER AUTO-BLOCKS: a SDN name match sets `review_required`, which is an
-- operator decision, because name collisions on that list are common.
--
-- RETENTION: checks 7 years, OFAC checks 10 years (D13). The archived raw report
-- object is deleted BEFORE its row, so a deleted row never orphans an object.
--
-- LOCK ORDER: see the banner in 0145_org_stripe_accounts.sql.
--
-- CANONICAL DDL: hand-authored source of truth. Mirrors:
-- schema/org_eligibility.ts, schema/org_eligibility_checks.ts,
-- schema/eligibility_source_revisions.ts.
--
-- Conventions: CREATE TABLE / INDEX IF NOT EXISTS; one concern per file;
-- non-CONCURRENTLY builds accepted (brand-new, empty tables). Forward-only.
-- Ordering rules: requires 0105_organizations.sql (organizations), 0001_core.sql
-- (users).
-- =============================================================================

CREATE TABLE IF NOT EXISTS org_eligibility (
  organization_id            uuid PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  verdict                    text NOT NULL DEFAULT 'unknown'
                               CHECK (verdict IN ('unknown','eligible','grace','ineligible','review_required')),
  reasons                    jsonb NOT NULL DEFAULT '[]'::jsonb,
  ein                        text,
  irs_legal_name             text,
  irs_address                jsonb,
  deductibility_code         text,
  foundation_code            text,
  group_exemption_subordinate boolean NOT NULL DEFAULT false,
  central_org_confirmed_at   timestamptz,
  central_org_confirmed_by   uuid REFERENCES users(id) ON DELETE SET NULL,
  mnos_first_seen_on         date,
  grace_expires_at           timestamptz,
  evaluated_at               timestamptz,
  next_check_at              timestamptz,
  created_at                 timestamptz NOT NULL DEFAULT now(),
  updated_at                 timestamptz NOT NULL DEFAULT now()
);

-- The import jobs stream-filter published lists down to EINs civfix has actually
-- onboarded; this is the lookup that does it.
CREATE INDEX IF NOT EXISTS org_eligibility_ein_idx
  ON org_eligibility (ein)
  WHERE ein IS NOT NULL;

CREATE INDEX IF NOT EXISTS org_eligibility_verdict_idx
  ON org_eligibility (verdict, updated_at DESC);

CREATE INDEX IF NOT EXISTS org_eligibility_next_check_idx
  ON org_eligibility (next_check_at)
  WHERE next_check_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS org_eligibility_grace_idx
  ON org_eligibility (grace_expires_at)
  WHERE grace_expires_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS org_eligibility_checks (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id      uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  source               text NOT NULL CHECK (source IN
                         ('irs_pub78','irs_eo_bmf','irs_auto_revocation','ftb_revoked',
                          'ca_ag_mnos','ofac_sdn','central_org_confirmation')),
  ein                  text,
  irs_legal_name       text,
  foundation_code      text,
  deductibility_code   text,
  source_revision_date date NOT NULL,
  raw_report_sha256    text,
  raw_report_key       text,
  matched              boolean NOT NULL,
  verdict_contribution text NOT NULL CHECK (verdict_contribution IN ('supports','disqualifies','neutral')),
  detail               text,
  checked_at           timestamptz NOT NULL DEFAULT now(),
  retention_until      timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS org_eligibility_checks_org_idx
  ON org_eligibility_checks (organization_id, checked_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS org_eligibility_checks_source_rev_idx
  ON org_eligibility_checks (source, source_revision_date);

CREATE INDEX IF NOT EXISTS org_eligibility_checks_retention_idx
  ON org_eligibility_checks (retention_until);

CREATE TABLE IF NOT EXISTS eligibility_source_revisions (
  source               text NOT NULL CHECK (source IN
                         ('irs_pub78','irs_eo_bmf','irs_auto_revocation','ftb_revoked',
                          'ca_ag_mnos','ofac_sdn','central_org_confirmation')),
  source_revision_date date NOT NULL,
  sha256               text NOT NULL,
  r2_key               text NOT NULL,
  row_count            bigint NOT NULL DEFAULT 0 CHECK (row_count >= 0),
  matched_count        bigint NOT NULL DEFAULT 0 CHECK (matched_count >= 0),
  imported_at          timestamptz NOT NULL DEFAULT now(),
  retention_until      timestamptz NOT NULL,
  PRIMARY KEY (source, source_revision_date)
);

CREATE INDEX IF NOT EXISTS eligibility_source_revisions_retention_idx
  ON eligibility_source_revisions (retention_until);

COMMENT ON TABLE org_eligibility_checks IS
  'APPEND-ONLY (Rev. Proc. 2018-32 section 8.01). Never UPDATE and never DELETE before retention_until: this is the evidence that a charity was in good standing at the moment a donation was authorized.';

COMMENT ON COLUMN org_eligibility_checks.raw_report_key IS
  'Object key of the archived published list under compliance/<source>/<revision>. The object is deleted BEFORE this row so a surviving row never names a missing object.';
