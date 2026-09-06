-- =============================================================================
-- 0109_cleanup_team_invites.sql
-- -----------------------------------------------------------------------------
-- Event team invitations (W1.3). Co-hosts could only ever be promoted from people
-- who had ALREADY joined the event, and the new `staff` role has no join path at
-- all - so a host had no way to bring a colleague onto the team before the day.
-- One NEW table carries the invite lifecycle for both roles.
--
-- Only the SHA-256 of the invite token is stored (the crypto.ts house rule): a
-- table leak must not hand out live acceptances. The token itself exists once, in
-- the invite email.
--
-- `invited_email` is the one contact detail an event team surface could otherwise
-- leak - a member's address is never host-visible - so DTOs render it masked, and
-- the retention sweep NULLs it seven days after the invite expires or is accepted
-- (email_scrubbed_at records that it happened). The row survives the scrub: it is
-- the audit trail of who was given standing on the event.
--
-- The two partial unique indexes stop an invite storm from queueing dozens of
-- pending invites at one person; a re-invite updates the open row.
--
-- CANONICAL DDL: hand-authored source of truth. Mirror: schema/cleanup_team_invites.ts.
--
-- Conventions: CREATE TABLE / CREATE INDEX IF NOT EXISTS; one concern per file;
-- non-CONCURRENTLY builds accepted (brand-new, empty table). Forward-only, no down.
--
-- LOCK ORDER (binding on every writer): organizations -> organization_members
--   -> cleanups -> cleanup_members -> cleanup_guests -> cleanup_registrations
--   -> cleanup_registration_seats -> cleanup_answers -> cleanup_waitlist ->
--   cleanup_ticket_types -> cleanup_slots -> cleanup_slot_claims
--
-- Ordering rules: requires 0000_extensions.sql (citext, gen_random_uuid) and
-- 0001_core.sql (cleanups, users).
-- =============================================================================

CREATE TABLE IF NOT EXISTS cleanup_team_invites (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cleanup_id uuid NOT NULL REFERENCES cleanups(id) ON DELETE CASCADE,
  invited_user_id uuid REFERENCES users(id),
  invited_email citext,
  role text NOT NULL CHECK (role IN ('cohost', 'staff')),
  token_hash text NOT NULL,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'accepted', 'revoked', 'expired')),
  invited_by uuid REFERENCES users(id),
  expires_at timestamptz NOT NULL,
  accepted_at timestamptz,
  accepted_by uuid REFERENCES users(id),
  email_scrubbed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT cleanup_team_invites_target_chk CHECK (
    invited_user_id IS NOT NULL
    OR invited_email IS NOT NULL
    OR email_scrubbed_at IS NOT NULL
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS cleanup_team_invites_token_uidx
  ON cleanup_team_invites (token_hash);

CREATE INDEX IF NOT EXISTS cleanup_team_invites_cleanup_created_idx
  ON cleanup_team_invites (cleanup_id, created_at DESC, id DESC);

CREATE UNIQUE INDEX IF NOT EXISTS cleanup_team_invites_pending_user_uidx
  ON cleanup_team_invites (cleanup_id, invited_user_id)
  WHERE status = 'pending' AND invited_user_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS cleanup_team_invites_pending_email_uidx
  ON cleanup_team_invites (cleanup_id, invited_email)
  WHERE status = 'pending' AND invited_email IS NOT NULL;

CREATE INDEX IF NOT EXISTS cleanup_team_invites_expiry_idx
  ON cleanup_team_invites (expires_at)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS cleanup_team_invites_email_scrub_idx
  ON cleanup_team_invites (expires_at)
  WHERE invited_email IS NOT NULL AND email_scrubbed_at IS NULL;

COMMENT ON COLUMN cleanup_team_invites.token_hash IS
  'SHA-256 of the invite token. The token itself is never stored - accept re-hashes what the caller presents.';
COMMENT ON COLUMN cleanup_team_invites.invited_email IS
  'Masked in every DTO. NULLed by host.retention.sweep seven days after expiry or acceptance; the row itself is kept as the standing trail.';
