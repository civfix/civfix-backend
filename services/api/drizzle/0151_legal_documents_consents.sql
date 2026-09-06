-- =============================================================================
-- 0151_legal_documents_consents.sql
-- -----------------------------------------------------------------------------
-- The machine-readable legal document set, and the consent evidence that
-- references it.
--
-- THE CONTRACT IS THE SOURCE OF TRUTH. `LEGAL_DOCUMENTS` in
-- @civfix/shared/legal is what the site renders, what the API validates a
-- consent payload against, and what these seed rows mirror. The seed below is
-- hardcoded to match that array byte for byte; a unit test compares the two and
-- fails on drift. The table exists so `consent_records` can carry a real foreign
-- key: a consent row is worthless without the exact version AND hash of the text
-- the person was shown.
--
-- Publishing a NEW version is an INSERT, never an UPDATE. Old versions stay
-- forever because consent rows point at them.
--
-- consent_records deliberately records NO IP AND NO USER AGENT. It mirrors
-- `event_consents`: document type + version + sha256 + server-stamped
-- `accepted_at` + surface + screen route + UI template version. If counsel later
-- asks for a truncated IP prefix, that is a new migration and a new privacy
-- decision, not a quiet column.
--
-- Consent rows are NEVER deleted by any retention lane -- they are the evidence
-- that the donation record beside them was lawfully collected.
--
-- CANONICAL DDL: hand-authored source of truth. Mirrors:
-- schema/legal_documents.ts, schema/consent_records.ts.
--
-- Conventions: CREATE TABLE / INDEX IF NOT EXISTS; idempotent seed via
-- ON CONFLICT DO NOTHING; one concern per file. Forward-only.
-- Ordering rules: requires 0105_organizations.sql (organizations),
-- 0001_core.sql (users), 0148_donations.sql (donations).
-- =============================================================================

CREATE TABLE IF NOT EXISTS legal_documents (
  type         text NOT NULL CHECK (type IN
                 ('terms','privacy','cookies','subprocessors','donations',
                  'org_donation_agreement','donation_disclosure')),
  version      text NOT NULL,
  sha256       text NOT NULL,
  effective_at timestamptz NOT NULL,
  url          text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (type, version)
);

CREATE INDEX IF NOT EXISTS legal_documents_effective_idx
  ON legal_documents (type, effective_at DESC);

-- Seed: byte-identical mirror of LEGAL_DOCUMENTS in @civfix/shared/legal
-- (version 2026-09-06). Pinned by test/unit/payments/legal-seed.test.ts.
INSERT INTO legal_documents (type, version, sha256, effective_at, url) VALUES
  ('terms', '2026-09-06', '4a4fcfac1a8d4ced63c4c033feb14df58a2db74632bdca37865fd5ab299a485e', '2026-09-06T00:00:00.000Z', 'https://civfix.org/legal/terms'),
  ('privacy', '2026-09-06', '91ba84fdeae76ed663b8711473e6c7b4ac5ae424925a663ea4383d4fe763b9dc', '2026-09-06T00:00:00.000Z', 'https://civfix.org/legal/privacy'),
  ('cookies', '2026-09-06', 'a45a5d61d54b22c60e7de8ea2a76fc58ed48c26cfdcbd73c5a9e02f5fb9a30ed', '2026-09-06T00:00:00.000Z', 'https://civfix.org/legal/cookies'),
  ('subprocessors', '2026-09-06', 'e3debad19253777755713b14ed4f1e853737e7e755b722d16f622fb0641c56a9', '2026-09-06T00:00:00.000Z', 'https://civfix.org/legal/subprocessors'),
  ('donations', '2026-09-06', '461190ba108e771ff6a3c89cec0b5451bf5d05ff89e33231ff4c5493e0723544', '2026-09-06T00:00:00.000Z', 'https://civfix.org/legal/donations'),
  ('org_donation_agreement', '2026-09-06', '9b6592f3d5218c4a275577e6ab56ee5d08cd15e0c59b562800f537c21567149e', '2026-09-06T00:00:00.000Z', 'https://civfix.org/legal/org-donation-agreement'),
  ('donation_disclosure', '2026-09-06', 'd5f86995dd134183128d16526d50a4676c09e25dc3ea5d8eb9c6f9dcdfd2fa10', '2026-09-06T00:00:00.000Z', 'https://civfix.org/legal/donation-disclosure')
ON CONFLICT (type, version) DO NOTHING;

CREATE TABLE IF NOT EXISTS consent_records (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subject_kind        text NOT NULL CHECK (subject_kind IN ('user','donor','organization')),
  user_id             uuid REFERENCES users(id) ON DELETE SET NULL,
  organization_id     uuid REFERENCES organizations(id) ON DELETE CASCADE,
  donation_id         uuid REFERENCES donations(id) ON DELETE RESTRICT,
  donor_key           uuid,
  document_type       text NOT NULL,
  document_version    text NOT NULL,
  document_sha256     text NOT NULL,
  accepted_at         timestamptz NOT NULL DEFAULT now(),
  surface             text NOT NULL CHECK (surface IN
                        ('web_donate','web_org_settings','web_register','mobile_register','onboarding')),
  screen_route        text,
  ui_template_version text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT consent_records_document_fk
    FOREIGN KEY (document_type, document_version) REFERENCES legal_documents(type, version),
  CONSTRAINT consent_records_subject_shape_check CHECK (
    (subject_kind = 'organization' AND organization_id IS NOT NULL)
    OR (subject_kind = 'donor' AND donor_key IS NOT NULL)
    OR (subject_kind = 'user' AND user_id IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS consent_records_donation_idx
  ON consent_records (donation_id)
  WHERE donation_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS consent_records_org_idx
  ON consent_records (organization_id, accepted_at DESC, id DESC)
  WHERE organization_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS consent_records_user_idx
  ON consent_records (user_id, accepted_at DESC, id DESC)
  WHERE user_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS consent_records_donor_idx
  ON consent_records (donor_key, accepted_at DESC)
  WHERE donor_key IS NOT NULL;

COMMENT ON TABLE consent_records IS
  'Consent evidence. No IP and no user agent by design (mirrors event_consents). Never deleted by any retention or erasure lane: erasure NULLs user_id, the record itself is what proves the donation beside it was lawfully collected.';

COMMENT ON TABLE legal_documents IS
  'Mirror of LEGAL_DOCUMENTS in @civfix/shared/legal, seeded by migration. Publishing a version is an INSERT; a row is never UPDATEd because consent_records references it.';
