-- =============================================================================
-- 0166_org_payouts.sql
-- -----------------------------------------------------------------------------
-- An AUDIT MIRROR of the Stripe Payout objects on an organization's connected
-- account (0.43.0, DECISIONS §34). It is not a ledger civfix reconciles against
-- and it never holds a balance: §26 stands unchanged, the payout executes ON the
-- connected account (Stripe-Account header) and moves the ORGANIZATION's own
-- money to the ORGANIZATION's own bank. civfix is the button, not the custodian.
--
-- MONEY IS INTEGER MINOR UNITS ONLY, same as `donations`: `bigint` +
-- `char(3) CHECK 'USD'`. No numeric, no float, no decimal string.
--
-- THE ROW IS WRITTEN BEFORE STRIPE IS CALLED. `(organization_id,
-- idempotency_key)` is unique, so a client that retries a payout replays the
-- first row instead of moving real money twice; the Stripe call carries the same
-- key, so a crash between the INSERT and the response cannot double-pay either.
-- `stripe_payout_id` is therefore NULL until Stripe answers, and unique once it
-- is set (payout ids are globally unique).
--
-- `requested_by` IS NULLABLE ON PURPOSE. A payout made from the organization's
-- own Stripe dashboard, or by the automatic schedule, arrives here only through
-- the `payout.*` connect webhooks, which know an account but no civfix user. A
-- NOT NULL column would have forced the webhook to either invent an actor or
-- drop the payout from the history the org is shown.
--
-- ON DELETE RESTRICT on the organization is the same DATA-LOSS GUARD as
-- `donations`: an org with a money-movement history is removed by the soft-delete
-- path or not at all. `requested_by` is SET NULL because account erasure
-- anonymizes the person without touching the financial record.
--
-- LOCK ORDER: see the banner in 0145_org_stripe_accounts.sql. `org_payouts` sits
-- last, after `donations`; a payout transaction touches nothing else.
--
-- CANONICAL DDL: hand-authored source of truth. Mirror: schema/org_payouts.ts.
--
-- Conventions: CREATE TABLE / INDEX IF NOT EXISTS; one concern per file;
-- non-CONCURRENTLY builds accepted (brand-new, empty table). Forward-only, no
-- down. Ordering rules: requires 0105_organizations.sql (organizations),
-- 0001_core.sql (users), 0000_extensions.sql (gen_random_uuid).
-- =============================================================================

CREATE TABLE IF NOT EXISTS org_payouts (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id   uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  stripe_account_id text NOT NULL,
  stripe_payout_id  text,
  amount_minor      bigint NOT NULL CHECK (amount_minor > 0),
  currency          char(3) NOT NULL DEFAULT 'USD' CHECK (currency = 'USD'),
  status            text NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending','in_transit','paid','failed','canceled')),
  arrival_date      timestamptz,
  failure_message   text,
  requested_by      uuid REFERENCES users(id) ON DELETE SET NULL,
  idempotency_key   uuid,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS org_payouts_stripe_payout_uidx
  ON org_payouts (stripe_payout_id)
  WHERE stripe_payout_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS org_payouts_idempotency_uidx
  ON org_payouts (organization_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS org_payouts_org_recent_idx
  ON org_payouts (organization_id, created_at DESC, id DESC);

COMMENT ON COLUMN org_payouts.stripe_payout_id IS
  'NULL between the local INSERT and the Stripe response. A row that stays NULL with status ''pending'' is a payout whose outcome civfix never observed; the same idempotency key replays it safely.';

COMMENT ON COLUMN org_payouts.failure_message IS
  'civfix-authored, user-safe copy. Raw Stripe error text is never stored here: it can name the connected account and its bank.';

COMMENT ON COLUMN org_payouts.requested_by IS
  'NULL for a payout created outside civfix (the org''s Stripe dashboard, or the account''s automatic schedule) and discovered through a payout.* connect webhook.';
