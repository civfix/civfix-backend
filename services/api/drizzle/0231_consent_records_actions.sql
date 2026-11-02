-- =============================================================================
-- 0231_consent_records_actions.sql
-- -----------------------------------------------------------------------------
-- WHY. Accounts now record that they accepted or acknowledged a legal document
-- version in consent_records (epic #232, DECISIONS D6): `action` says which,
-- and the surface CHECK gains the four places it happens: `signup`, `prompt`
-- (the re-acceptance screen), `notice` (the banner) and `event_registration`
-- (consent given when signing up for an event). Existing rows, none of which
-- an account wrote, become `accepted`.
--
-- Two indexes serve the new reads, both partial on `subject_kind = 'user'`:
-- `consent_records_user_type_idx` for what one person owes (GET /me/legal),
-- and `consent_records_document_idx` for the admin count of accounts that
-- accepted a version.
--
-- 0151's table COMMENT said erasure NULLs user_id. It never did: account
-- deletion is a soft delete, and the records stay with the anonymized account
-- as the legal record, like event_consents. The COMMENT now says so.
--
-- Still no IP address and no user agent (0151's header explains why).
--
-- consent_records is not on the hot-table list and holds no account rows yet:
-- the constant default makes ADD COLUMN catalog-only, and the re-added CHECK
-- and the two indexes build inline in milliseconds.
--
-- CANONICAL DDL: hand-authored source of truth. Mirrors:
-- schema/consent_records.ts, schema/types-legal.ts.
--
-- Conventions: one transaction per file; idempotent. Forward-only, no down.
-- Ordering rules: requires 0151_legal_documents_consents.sql (consent_records).
-- =============================================================================

ALTER TABLE consent_records
  ADD COLUMN IF NOT EXISTS action text NOT NULL DEFAULT 'accepted'
    CHECK (action IN ('accepted','acknowledged'));

ALTER TABLE consent_records DROP CONSTRAINT IF EXISTS consent_records_surface_check;
ALTER TABLE consent_records ADD CONSTRAINT consent_records_surface_check CHECK (surface IN
  ('web_donate','web_org_settings','web_register','mobile_register','onboarding',
   'signup','prompt','notice','event_registration'));

CREATE INDEX IF NOT EXISTS consent_records_user_type_idx
  ON consent_records (user_id, document_type, accepted_at DESC)
  WHERE subject_kind = 'user';

CREATE INDEX IF NOT EXISTS consent_records_document_idx
  ON consent_records (document_type, document_version)
  WHERE subject_kind = 'user';

COMMENT ON TABLE consent_records IS
  'Consent evidence: what an account accepted or acknowledged, and the donation consents before them. No IP and no user agent by design (mirrors event_consents). Never deleted by any retention or erasure lane: on account deletion the records are kept with the anonymized account as a legal record, user_id intact.';
