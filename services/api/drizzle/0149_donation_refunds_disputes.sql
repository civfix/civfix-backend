-- =============================================================================
-- 0149_donation_refunds_disputes.sql
-- -----------------------------------------------------------------------------
-- civfix does NOT issue refunds. Under direct charges the organization is the
-- merchant of record and refunds happen in the organization's own Stripe
-- dashboard; there is deliberately no `createRefund` on the Payments seam, which
-- removes "a stolen operator cookie is a refund key" by construction.
--
-- These two tables therefore only RECORD what Stripe reports, and drive the one
-- reaction civfix owes the donor: a PROPORTIONAL refund of the civfix
-- application fee, so a partially refunded donation is not charged full
-- platform fee on money the donor got back.
--
--   donation_refunds   one row per Stripe refund id, plus the state of the
--                      matching application-fee refund attempt (`pending` ->
--                      `done` | `skipped` | `failed`). `skipped` is the normal
--                      terminal state when Stripe already reversed the fee.
--   donation_disputes  one row per dispute id. The organization's balance is
--                      debited, not civfix's. An early-fraud warning is recorded
--                      and alerted but NEVER auto-refunded: the org is the
--                      merchant and that decision is theirs.
--
-- ON DELETE RESTRICT on donation_id: a donation that has been refunded or
-- disputed is exactly the row that must survive longest.
--
-- Neither table is ever reaped: refunds and disputes have no retention_until.
--
-- LOCK ORDER: see the banner in 0145_org_stripe_accounts.sql.
--
-- CANONICAL DDL: hand-authored source of truth. Mirrors:
-- schema/donation_refunds.ts, schema/donation_disputes.ts.
--
-- Conventions: CREATE TABLE / INDEX IF NOT EXISTS; one concern per file;
-- non-CONCURRENTLY builds accepted (brand-new, empty tables). Forward-only.
-- Ordering rules: requires 0148_donations.sql.
-- =============================================================================

CREATE TABLE IF NOT EXISTS donation_refunds (
  id                     text PRIMARY KEY,
  donation_id            uuid NOT NULL REFERENCES donations(id) ON DELETE RESTRICT,
  amount_minor           bigint NOT NULL CHECK (amount_minor > 0),
  currency               char(3) NOT NULL DEFAULT 'USD' CHECK (currency = 'USD'),
  status                 text NOT NULL,
  reason                 text,
  app_fee_refund_id      text,
  app_fee_refund_minor   bigint NOT NULL DEFAULT 0 CHECK (app_fee_refund_minor >= 0),
  app_fee_refund_state   text NOT NULL DEFAULT 'pending'
                           CHECK (app_fee_refund_state IN ('pending','done','skipped','failed')),
  app_fee_refund_error   text,
  refunded_at            timestamptz,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS donation_refunds_donation_idx
  ON donation_refunds (donation_id, created_at DESC);

CREATE INDEX IF NOT EXISTS donation_refunds_app_fee_pending_idx
  ON donation_refunds (created_at)
  WHERE app_fee_refund_state IN ('pending','failed');

CREATE TABLE IF NOT EXISTS donation_disputes (
  id                   text PRIMARY KEY,
  donation_id          uuid NOT NULL REFERENCES donations(id) ON DELETE RESTRICT,
  amount_minor         bigint NOT NULL CHECK (amount_minor >= 0),
  currency             char(3) NOT NULL DEFAULT 'USD' CHECK (currency = 'USD'),
  reason               text,
  status               text NOT NULL,
  state                text NOT NULL DEFAULT 'open'
                         CHECK (state IN ('none','open','won','lost','warning')),
  opened_at            timestamptz,
  closed_at            timestamptz,
  funds_withdrawn_at   timestamptz,
  funds_reinstated_at  timestamptz,
  evidence_due_by      timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS donation_disputes_donation_idx
  ON donation_disputes (donation_id, created_at DESC);

CREATE INDEX IF NOT EXISTS donation_disputes_open_idx
  ON donation_disputes (evidence_due_by)
  WHERE state = 'open';

COMMENT ON TABLE donation_refunds IS
  'Records refunds the ORGANIZATION issued in its own Stripe dashboard. civfix has no refund API by design. The only civfix-side effect is the proportional application-fee refund tracked by app_fee_refund_state.';
