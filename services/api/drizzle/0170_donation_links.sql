-- =============================================================================
-- 0170_donation_links.sql
-- -----------------------------------------------------------------------------
-- WHY. The platform no longer processes donations. Money moves directly between
-- a donor and whoever is asking for it, through that party's own donation page,
-- so all civfix stores is an outbound https link. Events already carry one
-- (cleanups.donation_url, 0107). This file gives the other two subjects people
-- ask on behalf of the same field: an organization and a person.
--
-- Both columns copy 0107's shape exactly -- plain nullable text plus a
-- LIKE 'https://%' CHECK, so a link can never downgrade a reader to cleartext
-- and can never carry a javascript:/data: scheme. The constraints are added
-- NOT VALID: users and organizations are hot tables and a validating
-- ADD CONSTRAINT scans them inside the deploy transaction. Every row the
-- previous image wrote has NULL here (the columns are created by this file), so
-- each constraint holds by construction from the instant it exists and every
-- INSERT/UPDATE is checked from now on.
--
-- STILL OUTSTANDING (a later release, out of band, SHARE UPDATE EXCLUSIVE):
--   ALTER TABLE organizations VALIDATE CONSTRAINT organizations_donation_url_https_chk;
--   ALTER TABLE users VALIDATE CONSTRAINT users_donation_url_https_chk;
--
-- The donation, payout, eligibility and stripe tables are deliberately NOT
-- touched. Their code paths are gone; the rows are financial records the
-- organization keeps.
-- =============================================================================

ALTER TABLE organizations ADD COLUMN IF NOT EXISTS donation_url text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS donation_url text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'organizations_donation_url_https_chk'
      AND conrelid = 'organizations'::regclass
  ) THEN
    ALTER TABLE organizations
      ADD CONSTRAINT organizations_donation_url_https_chk
      CHECK (donation_url IS NULL OR donation_url LIKE 'https://%') NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'users_donation_url_https_chk' AND conrelid = 'users'::regclass
  ) THEN
    ALTER TABLE users
      ADD CONSTRAINT users_donation_url_https_chk
      CHECK (donation_url IS NULL OR donation_url LIKE 'https://%') NOT VALID;
  END IF;
END $$;

COMMENT ON COLUMN organizations.donation_url IS
  'Outbound https donation link shown on the organization page and inherited by its events. civfix never touches the money.';

COMMENT ON COLUMN users.donation_url IS
  'Outbound https donation link shown on the person profile. Cleared by softDeleteAndAnonymize. civfix never touches the money.';
