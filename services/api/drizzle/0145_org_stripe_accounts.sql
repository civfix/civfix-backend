-- =============================================================================
-- 0145_org_stripe_accounts.sql
-- -----------------------------------------------------------------------------
-- Stripe Connect account state for an organization, under DIRECT CHARGES: the
-- organization is the merchant of record, funds never enter a civfix balance,
-- and civfix takes a disclosed application fee on top. This table is the local
-- mirror of the connected Account object; Stripe remains authoritative and every
-- write here happens after a fresh `retrieveAccount` (webhooks are triggers, not
-- data sources).
--
-- Separate table (not columns on `organizations`) on purpose: the requirement
-- arrays and the capabilities map are jsonb that would sit in the organizations
-- TOAST chain and be detoasted by every ordinary org read.
--
-- ON DELETE RESTRICT is a DATA-LOSS GUARD, not a style choice. An organization
-- row that still owns a connected account and seven years of donation records
-- must not be deletable by a cascade from anywhere; the org soft-delete path
-- (deleted_at) is the only supported removal.
--
-- LOCK ORDER (binding on every writer, W1.2 + W4.B): organizations ->
-- organization_members -> cleanups -> cleanup_members -> cleanup_guests ->
-- cleanup_registrations -> cleanup_registration_seats -> cleanup_answers ->
-- cleanup_waitlist -> cleanup_ticket_types -> cleanup_slots ->
-- cleanup_slot_claims -> org_stripe_accounts
-- -> org_donation_settings -> org_eligibility -> org_eligibility_checks ->
-- donations -> donation_refunds -> donation_disputes. A donation transaction
-- never touches cleanups*.
--
-- CANONICAL DDL: hand-authored source of truth. Mirror:
-- schema/org_stripe_accounts.ts.
--
-- Conventions: CREATE TABLE / INDEX IF NOT EXISTS; one concern per file;
-- non-CONCURRENTLY builds accepted (brand-new, empty table). Forward-only, no
-- down. Ordering rules: requires 0105_organizations.sql (organizations).
-- =============================================================================

CREATE TABLE IF NOT EXISTS org_stripe_accounts (
  organization_id       uuid PRIMARY KEY REFERENCES organizations(id) ON DELETE RESTRICT,
  stripe_account_id     text NOT NULL,
  livemode              boolean NOT NULL DEFAULT false,
  details_submitted     boolean NOT NULL DEFAULT false,
  charges_enabled       boolean NOT NULL DEFAULT false,
  payouts_enabled       boolean NOT NULL DEFAULT false,
  disabled_reason       text,
  currently_due         jsonb NOT NULL DEFAULT '[]'::jsonb,
  past_due              jsonb NOT NULL DEFAULT '[]'::jsonb,
  pending_verification  jsonb NOT NULL DEFAULT '[]'::jsonb,
  future_currently_due  jsonb NOT NULL DEFAULT '[]'::jsonb,
  capabilities          jsonb NOT NULL DEFAULT '{}'::jsonb,
  current_deadline      timestamptz,
  onboarding_state      text NOT NULL DEFAULT 'not_started'
                          CHECK (onboarding_state IN ('not_started','onboarding','ready','at_risk','blocked')),
  payment_method_domains jsonb NOT NULL DEFAULT '[]'::jsonb,
  deauthorized_at       timestamptz,
  reconciled_through    timestamptz,
  last_account_event_id text,
  last_synced_at        timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS org_stripe_accounts_account_uidx
  ON org_stripe_accounts (stripe_account_id);

-- Operator queue + the account-sync sweep both ask "which orgs are not ready".
CREATE INDEX IF NOT EXISTS org_stripe_accounts_not_ready_idx
  ON org_stripe_accounts (onboarding_state, updated_at DESC)
  WHERE onboarding_state <> 'ready';

COMMENT ON COLUMN org_stripe_accounts.payment_method_domains IS
  'Registered Apple Pay / Google Pay domains for THIS connected account: [{domain,id,enabled,registeredAt}]. Under direct charges the registration is per-org, so an unregistered domain silently loses wallets rather than erroring.';

COMMENT ON COLUMN org_stripe_accounts.reconciled_through IS
  'High-water mark for payments.reconcile: balance transactions on this connected account are compared against local donations from this instant forward.';
