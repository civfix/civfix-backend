-- =============================================================================
-- 0106_org_verifications.sql
-- -----------------------------------------------------------------------------
-- The operator-reviewed evidence behind organizations.verified_status (W1.3). One
-- NEW table; the decision itself is mirrored onto the organizations row by the
-- same transaction that writes the audit entry, so no read path joins this queue.
--
-- PRIVACY, load-bearing: `ein_number` and `documents` are WRITE-ONLY. No
-- organization-facing DTO, list, CSV or /me/data-export ever returns them; the
-- admin queue row carries only the EIN's last four digits plus the media IDS, and
-- an operator opens each document through the audited admin signed-URL media
-- route. `ein_number` is NULLed 90 days after a decision by the host retention
-- sweep (ein_scrubbed_at records that it happened) - the evidence has served its
-- purpose once the decision is recorded, and a tax identifier kept forever is a
-- breach waiting for a reason.
--
-- `documents` is a jsonb array of {"mediaId": uuid} whose assets carry
-- purpose = 'verification', which media-authorization.ts denies on the public
-- media path for every caller, exactly as individual verification selfies are.
--
-- CANONICAL DDL: hand-authored source of truth. Mirror: schema/org_verifications.ts.
--
-- Conventions: CREATE TABLE / CREATE INDEX IF NOT EXISTS; one concern per file;
-- non-CONCURRENTLY builds accepted (brand-new, empty table). Forward-only, no down.
--
-- LOCK ORDER (binding on every writer): organizations -> organization_members
--   -> cleanups -> cleanup_members -> cleanup_guests -> cleanup_registrations
--   -> cleanup_registration_seats -> cleanup_answers -> cleanup_waitlist ->
--   cleanup_ticket_types -> cleanup_slots -> cleanup_slot_claims
--
-- Ordering rules: requires 0105_organizations.sql and 0001_core.sql (users).
-- =============================================================================

CREATE TABLE IF NOT EXISTS org_verifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  status text NOT NULL
    CHECK (status IN ('unverified', 'pending', 'verified', 'rejected')),
  kind text NOT NULL CHECK (kind IN ('nonprofit', 'government', 'community')),
  ein_number text,
  ein_scrubbed_at timestamptz,
  documents jsonb NOT NULL DEFAULT '[]'::jsonb,
  note text,
  rejection_reason text,
  submitted_by uuid REFERENCES users(id),
  submitted_at timestamptz NOT NULL DEFAULT now(),
  reviewed_by uuid REFERENCES users(id),
  reviewed_at timestamptz,
  CONSTRAINT org_verifications_documents_array_chk
    CHECK (jsonb_typeof(documents) = 'array')
);

CREATE UNIQUE INDEX IF NOT EXISTS org_verifications_pending_uidx
  ON org_verifications (organization_id)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS org_verifications_queue_idx
  ON org_verifications (submitted_at DESC, id DESC)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS org_verifications_org_idx
  ON org_verifications (organization_id, submitted_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS org_verifications_ein_scrub_idx
  ON org_verifications (reviewed_at)
  WHERE ein_number IS NOT NULL AND ein_scrubbed_at IS NULL AND reviewed_at IS NOT NULL;

COMMENT ON COLUMN org_verifications.ein_number IS
  'WRITE-ONLY. Never returned by any DTO or export; only einLast4 reaches the operator queue. NULLed 90 days after reviewed_at by host.retention.sweep.';
COMMENT ON COLUMN org_verifications.documents IS
  'WRITE-ONLY jsonb array of {"mediaId": uuid}. Assets carry purpose = verification, which the public media path denies outright.';
COMMENT ON INDEX org_verifications_pending_uidx IS
  'At most one open application per organization - a second submission updates the open row rather than queueing a duplicate for the operator.';
