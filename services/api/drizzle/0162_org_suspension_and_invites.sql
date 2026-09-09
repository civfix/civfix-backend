-- =============================================================================
-- 0162_org_suspension_and_invites.sql
-- -----------------------------------------------------------------------------
-- Admin org management + org invites (@civfix/shared 0.41.0, DECISIONS §32).
--
-- 1. organizations.suspended_at / suspended_reason / suspended_by
--    Suspension is an OPERATOR FLAG, not a status: it never touches
--    verified_status, so lifting it restores exactly what was there, and it is
--    distinct from deleted_at (reversible vs. not). While set, every org-scoped
--    write (self-service edits, invites, verification applications, linking a
--    new event, donations) is refused; members still read the org with
--    suspended=true and non-members get a 404 on the public page.
--    Three nullable column adds on a small table: no rewrite, no default.
--
-- 2. organization_invites
--    0.40.0's inviteOrganizationMember with identifierKind=email stored NOTHING
--    for an address with no account, so the invite was a silent no-op. This
--    table is the pending record, mirroring cleanup_team_invites (0109): only
--    the SHA-256 of the single-use token is stored, the token itself exists once
--    in the invite email. `email` is citext so a re-invite of the same address
--    in a different casing hits the partial unique index rather than queueing a
--    duplicate. `user_id` is filled at acceptance (the account that signed in
--    with the invited address), never at creation - an email invite is a claim
--    on an account, not on the address.
--
-- CANONICAL DDL: hand-authored source of truth. Mirrors:
-- schema/organizations.ts, schema/organization_invites.ts.
--
-- Conventions: ADD COLUMN / CREATE TABLE / CREATE INDEX IF NOT EXISTS; one
-- concern per file; non-CONCURRENTLY builds accepted (small table + brand-new
-- empty table). Forward-only, no down.
--
-- LOCK ORDER (binding on every writer): organizations -> organization_members
--   -> organization_invites -> cleanups -> ...
--
-- Ordering rules: requires 0000_extensions.sql (citext, gen_random_uuid),
-- 0001_core.sql (users) and 0105 (organizations).
-- =============================================================================

ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS suspended_at timestamptz;

ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS suspended_reason text;

ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS suspended_by uuid REFERENCES users(id);

CREATE INDEX IF NOT EXISTS organizations_suspended_idx
  ON organizations (suspended_at DESC, id DESC)
  WHERE suspended_at IS NOT NULL AND deleted_at IS NULL;

COMMENT ON COLUMN organizations.suspended_at IS
  'Operator suspension flag (adminSetOrgSuspended). NULL = not suspended. Independent of verified_status and deleted_at; clearing it restores the org exactly.';
COMMENT ON COLUMN organizations.suspended_reason IS
  'Operator-supplied reason shown to the org''s members and in the admin console. NULL whenever suspended_at is NULL.';

CREATE TABLE IF NOT EXISTS organization_invites (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  email citext,
  user_id uuid REFERENCES users(id),
  role text NOT NULL CHECK (role IN ('admin', 'member')),
  token_hash text NOT NULL,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'accepted', 'revoked', 'expired')),
  invited_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  accepted_at timestamptz,
  revoked_at timestamptz,
  CONSTRAINT organization_invites_target_chk CHECK (email IS NOT NULL OR user_id IS NOT NULL)
);

CREATE UNIQUE INDEX IF NOT EXISTS organization_invites_token_uidx
  ON organization_invites (token_hash);

CREATE INDEX IF NOT EXISTS organization_invites_org_idx
  ON organization_invites (organization_id, created_at DESC, id DESC);

CREATE UNIQUE INDEX IF NOT EXISTS organization_invites_pending_email_uidx
  ON organization_invites (organization_id, email)
  WHERE status = 'pending' AND email IS NOT NULL;

CREATE INDEX IF NOT EXISTS organization_invites_expiry_idx
  ON organization_invites (expires_at)
  WHERE status = 'pending';

COMMENT ON COLUMN organization_invites.token_hash IS
  'SHA-256 of the invite token. The token itself is never stored - accept re-hashes what the caller presents.';
COMMENT ON COLUMN organization_invites.user_id IS
  'The account that accepted the invite (set at acceptance). NULL while pending: an email invite is a claim on whichever account signs in with that verified address.';
