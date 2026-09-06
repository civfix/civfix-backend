-- =============================================================================
-- 0152_donation_reconciliation_runs.sql
-- -----------------------------------------------------------------------------
-- Daily three-way reconciliation between (1) the local `donations` rows, (2) the
-- connected account's balance transactions and (3) the platform's application
-- fee objects. One row per run per organization.
--
-- civfix deliberately does NOT mirror Stripe's balance transactions into a local
-- ledger table: under direct charges the money never touches a civfix balance,
-- so a mirror would be a second source of truth to keep in sync with no
-- authority of its own. Instead each run ASSERTS the invariants and records only
-- the assertion outcome:
--   - every succeeded donation has a charge balance transaction of equal amount;
--   - every charge carrying a civfix_donation_id has a local row;
--   - every application fee matches fee_platform_minor net of refunds.
--
-- `divergences` is the alerting signal and is CRITICAL at > 0: a divergence
-- means either civfix charged a fee it cannot account for or a donor was charged
-- for a donation civfix has no record of. Neither is a warning.
--
-- CANONICAL DDL: hand-authored source of truth. Mirror:
-- schema/donation_reconciliation_runs.ts.
--
-- Conventions: CREATE TABLE / INDEX IF NOT EXISTS; one concern per file.
-- Forward-only. Ordering rules: requires 0105_organizations.sql, 0148_donations.sql.
-- =============================================================================

CREATE TABLE IF NOT EXISTS donation_reconciliation_runs (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id      uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  window_start         timestamptz NOT NULL,
  window_end           timestamptz NOT NULL,
  donations_checked    integer NOT NULL DEFAULT 0 CHECK (donations_checked >= 0),
  balance_transactions integer NOT NULL DEFAULT 0 CHECK (balance_transactions >= 0),
  application_fees     integer NOT NULL DEFAULT 0 CHECK (application_fees >= 0),
  divergences          integer NOT NULL DEFAULT 0 CHECK (divergences >= 0),
  divergence_detail    jsonb NOT NULL DEFAULT '[]'::jsonb,
  gross_minor          bigint NOT NULL DEFAULT 0,
  platform_fee_minor   bigint NOT NULL DEFAULT 0,
  status               text NOT NULL DEFAULT 'ok' CHECK (status IN ('ok','diverged','failed')),
  error                text,
  ran_at               timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT donation_reconciliation_runs_window_check CHECK (window_end >= window_start)
);

CREATE INDEX IF NOT EXISTS donation_reconciliation_runs_org_idx
  ON donation_reconciliation_runs (organization_id, ran_at DESC, id DESC);

-- Gauge source: civfix_payments_reconcile_divergences.
CREATE INDEX IF NOT EXISTS donation_reconciliation_runs_diverged_idx
  ON donation_reconciliation_runs (ran_at DESC)
  WHERE divergences > 0;
