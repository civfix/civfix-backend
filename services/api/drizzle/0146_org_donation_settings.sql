-- =============================================================================
-- 0146_org_donation_settings.sql
-- -----------------------------------------------------------------------------
-- Per-organization donation configuration, plus the Gov. Code section 12599.9
-- (11 CCR 318) agreement change log.
--
-- WHAT AN ORG MAY AUTHOR IS DELIBERATELY NARROW. Every legally required
-- disclosure -- recipient legal name, EIN, deductibility statement, "may not
-- receive" notice, fee itemization -- is GENERATED from verified evidence
-- (org_eligibility, 0147) and is not writable here. An org may set a mission
-- blurb, a designation note, its own refund policy text, the donation bounds and
-- the suggested amounts. Nothing else.
--
-- FEE-RAISE SAFETY: `agreed_fee_bps` is the fee the organization accepted in a
-- versioned agreement. Checkout charges min(env DONATION_PLATFORM_FEE_BPS,
-- agreed_fee_bps), so raising the platform fee by editing a SOPS value CANNOT
-- raise what an existing org is charged: it takes a new agreement version and a
-- section 318 change notification, logged in org_donation_agreement_changes.
--
-- `disabled_reason` records WHY donations are off, because the auto-re-enable
-- rule is reason-scoped: eligibility may re-enable only what eligibility
-- disabled, never an operator or org decision.
--
-- LOCK ORDER: see the banner in 0145_org_stripe_accounts.sql.
--
-- CANONICAL DDL: hand-authored source of truth. Mirrors:
-- schema/org_donation_settings.ts, schema/org_donation_agreement_changes.ts.
--
-- Conventions: CREATE TABLE / INDEX IF NOT EXISTS; one concern per file;
-- non-CONCURRENTLY builds accepted (brand-new, empty tables). Forward-only.
-- Ordering rules: requires 0105_organizations.sql (organizations) and
-- 0001_core.sql (users).
-- =============================================================================

CREATE TABLE IF NOT EXISTS org_donation_settings (
  organization_id         uuid PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  enabled                 boolean NOT NULL DEFAULT false,
  disabled_reason         text
                            CHECK (disabled_reason IS NULL OR disabled_reason IN
                              ('org','operator','eligibility','stripe_blocked','deauthorized')),
  disabled_at             timestamptz,
  disabled_by             uuid REFERENCES users(id) ON DELETE SET NULL,
  disabled_reason_text    text CHECK (disabled_reason_text IS NULL OR length(disabled_reason_text) <= 1000),
  donor_sharing_default   boolean NOT NULL DEFAULT false,
  mission_blurb           text CHECK (mission_blurb IS NULL OR length(mission_blurb) <= 280),
  designation_note        text CHECK (designation_note IS NULL OR length(designation_note) <= 280),
  refund_policy_text      text CHECK (refund_policy_text IS NULL OR length(refund_policy_text) <= 500),
  agreed_fee_bps          integer NOT NULL DEFAULT 500 CHECK (agreed_fee_bps BETWEEN 0 AND 2000),
  consent_agreement_version text,
  consent_accepted_at     timestamptz,
  consent_accepted_by     uuid REFERENCES users(id) ON DELETE SET NULL,
  min_amount_minor        bigint NOT NULL DEFAULT 500 CHECK (min_amount_minor >= 500),
  max_amount_minor        bigint NOT NULL DEFAULT 1000000 CHECK (max_amount_minor > 0),
  suggested_amounts_minor bigint[] NOT NULL DEFAULT '{}',
  currency                char(3) NOT NULL DEFAULT 'USD' CHECK (currency = 'USD'),
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT org_donation_settings_amount_order_check CHECK (max_amount_minor >= min_amount_minor),
  CONSTRAINT org_donation_settings_suggested_len_check
    CHECK (array_length(suggested_amounts_minor, 1) IS NULL OR array_length(suggested_amounts_minor, 1) <= 6),
  CONSTRAINT org_donation_settings_disabled_shape_check
    CHECK (enabled OR disabled_reason IS NOT NULL OR disabled_at IS NULL)
);

CREATE INDEX IF NOT EXISTS org_donation_settings_enabled_idx
  ON org_donation_settings (organization_id)
  WHERE enabled;

-- 11 CCR 318 change-notification log: every acceptance and every subsequent
-- version change is appended, never updated, so "which text did this charity
-- agree to, and when were they told it changed" is answerable years later.
CREATE TABLE IF NOT EXISTS org_donation_agreement_changes (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  from_version     text,
  to_version       text NOT NULL,
  document_sha256  text NOT NULL,
  change_kind      text NOT NULL CHECK (change_kind IN ('accepted','version_published','fee_changed','revoked')),
  fee_bps_before   integer CHECK (fee_bps_before IS NULL OR fee_bps_before BETWEEN 0 AND 2000),
  fee_bps_after    integer CHECK (fee_bps_after IS NULL OR fee_bps_after BETWEEN 0 AND 2000),
  actor_user_id    uuid REFERENCES users(id) ON DELETE SET NULL,
  notified_at      timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS org_donation_agreement_changes_org_idx
  ON org_donation_agreement_changes (organization_id, created_at DESC, id DESC);

COMMENT ON COLUMN org_donation_settings.agreed_fee_bps IS
  'The platform fee this organization ACCEPTED in a versioned agreement. Checkout charges min(env DONATION_PLATFORM_FEE_BPS, agreed_fee_bps): an env raise above this value is refused down to this value and alerts, because a fee increase requires a new agreement version, not a secrets edit.';
