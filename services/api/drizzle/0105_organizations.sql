-- =============================================================================
-- 0105_organizations.sql
-- -----------------------------------------------------------------------------
-- Host identity (W1.3). Until now a host was a bare users.id: there was no way to
-- say "this event is run by the Ballona Creek Trust", no way to verify that claim,
-- and no way for a second staffer to inherit the standing when the person who
-- created the event stops volunteering. Two NEW tables, no change to any existing
-- one.
--
--   organizations         the host entity. `slug` is a PUBLIC URL segment, so it is
--                         unique among live rows and never changes after creation.
--                         `verified_status`/`verified_kind` are the operator's
--                         decision, mirrored here from the winning org_verifications
--                         row (0106) so every read path is one row, not a join to a
--                         queue. Soft-deleted (deleted_at), never hard-deleted: an
--                         organization is attributed on published civic events.
--   organization_members  who acts for the organization. Exactly ONE owner per org
--                         is a partial unique index, not application logic - the
--                         owner is the only role that may manage payments, and a
--                         second owner row would silently double that authority.
--
-- Org standing is ADDITIVE to event standing (@civfix/shared/host capabilities):
-- an org owner holds the organizer capability set on every event the org owns, an
-- org admin the cohost set minus export. Nothing here grants anything on an event
-- the organization does not own - the join runs through cleanups.organization_id.
--
-- CANONICAL DDL: hand-authored source of truth. Mirrors: schema/organizations.ts,
-- schema/organization_members.ts.
--
-- Conventions: CREATE TABLE / CREATE INDEX IF NOT EXISTS; one concern per file;
-- non-CONCURRENTLY builds accepted (brand-new, empty tables - nothing to lock).
-- Forward-only, no down.
--
-- LOCK ORDER (binding on every writer): organizations -> organization_members
--   -> cleanups -> cleanup_members -> cleanup_guests -> cleanup_registrations
--   -> cleanup_registration_seats -> cleanup_answers -> cleanup_waitlist ->
--   cleanup_ticket_types -> cleanup_slots -> cleanup_slot_claims
--
-- Ordering rules: requires 0000_extensions.sql (citext, gen_random_uuid),
-- 0001_core.sql (users) and 0016_user_verification.sql (media_assets).
-- =============================================================================

CREATE TABLE IF NOT EXISTS organizations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug citext NOT NULL,
  name text NOT NULL,
  description text,
  website_url text,
  logo_media_id uuid REFERENCES media_assets(id) ON DELETE SET NULL,
  social_links jsonb,
  verified_status text NOT NULL DEFAULT 'unverified'
    CHECK (verified_status IN ('unverified', 'pending', 'verified', 'rejected')),
  verified_kind text
    CHECK (verified_kind IS NULL OR verified_kind IN ('nonprofit', 'government', 'community')),
  verified_at timestamptz,
  created_by uuid REFERENCES users(id),
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT organizations_website_https_chk
    CHECK (website_url IS NULL OR website_url LIKE 'https://%')
);

CREATE UNIQUE INDEX IF NOT EXISTS organizations_slug_uidx
  ON organizations (slug)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS organizations_verification_queue_idx
  ON organizations (verified_status, created_at DESC, id DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS organizations_created_by_idx
  ON organizations (created_by)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS organizations_logo_media_idx
  ON organizations (logo_media_id)
  WHERE logo_media_id IS NOT NULL;

COMMENT ON COLUMN organizations.slug IS
  'Public URL segment (GET /v1/orgs/by-slug/:slug). Unique among live rows; immutable after creation because it is a shared link.';
COMMENT ON COLUMN organizations.verified_status IS
  'Operator decision mirrored from the winning org_verifications row. Only a verified nonprofit may publish a donation link on its events.';

CREATE TABLE IF NOT EXISTS organization_members (
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id),
  role text NOT NULL CHECK (role IN ('owner', 'admin', 'member')),
  joined_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, user_id)
);

CREATE INDEX IF NOT EXISTS organization_members_user_idx
  ON organization_members (user_id);

CREATE UNIQUE INDEX IF NOT EXISTS organization_members_owner_uidx
  ON organization_members (organization_id)
  WHERE role = 'owner';

COMMENT ON INDEX organization_members_owner_uidx IS
  'Exactly one owner per organization. Enforced here rather than in the service because the owner role is the sole holder of manage_payments.';
