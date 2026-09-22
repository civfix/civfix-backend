-- =============================================================================
-- 0172_legal_documents_2026_09_21.sql
-- -----------------------------------------------------------------------------
-- WHY. The Terms of Service now state that the civfix software is free and
-- open-source software under the AGPL-3.0 (section 11, previously a blanket
-- proprietary-software clause), and both the Terms and the Privacy Policy now
-- name the operator by its legal name, Reach Out Los Angeles Inc. Different
-- text is a different document, so terms and privacy get a new version
-- (2026-09-21) and new sha256 values. The cookie and subprocessor documents did
-- not change and keep their 2026-09-16 rows.
--
-- THE CONTRACT IS STILL THE SOURCE OF TRUTH. These rows mirror the `terms` and
-- `privacy` entries of `LEGAL_DOCUMENTS` in @civfix/shared/legal (0.48.2) byte for byte;
-- test/unit/legal-seed.test.ts reads the union of 0151, 0171 and this file and
-- fails on drift.
--
-- Publishing a NEW version is an INSERT, never an UPDATE (0151's header). The
-- 2026-09-16 terms and privacy rows stay forever: `consent_records` carries the
-- FK (document_type, document_version) and every consent already collected
-- points at them. This file only ADDS the 2026-09-21 rows.
--
-- DATA only, no DDL: the Drizzle mirror (schema/legal_documents.ts) is
-- unchanged. Two rows into a cold table, no index built, no lock of consequence.
--
-- Conventions: idempotent seed via ON CONFLICT DO NOTHING; one concern per
-- file. Forward-only.
-- Ordering rules: requires 0151_legal_documents_consents.sql (legal_documents).
-- =============================================================================

INSERT INTO legal_documents (type, version, sha256, effective_at, url) VALUES
  ('terms', '2026-09-21', '52fe3908a8d7aa4427239a7555a2d7b2346d7a2b9730dfb539ecd157f6195772', '2026-09-21T00:00:00.000Z', 'https://civfix.org/legal/terms'),
  ('privacy', '2026-09-21', 'e7bb3df8d1bae0ebf3dac45021beb1f260c3035f2bf3cabd0201e2586eb2f127', '2026-09-21T00:00:00.000Z', 'https://civfix.org/legal/privacy')
ON CONFLICT (type, version) DO NOTHING;
