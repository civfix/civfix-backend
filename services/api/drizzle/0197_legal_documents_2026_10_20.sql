-- =============================================================================
-- 0197_legal_documents_2026_10_20.sql
-- -----------------------------------------------------------------------------
-- WHY. Residents now need an account to file a report (GH#205), so the Terms
-- of Service (section 5) and the Privacy Policy (section 6) were rewritten to
-- say so, keeping how a report filed anonymously before the change can still
-- be linked to an account. Different text is a different document, so terms
-- and privacy get a new version (2026-10-20) and new sha256 values. The cookie
-- and subprocessor documents did not change and keep their 2026-09-16 rows.
--
-- THE CONTRACT IS STILL THE SOURCE OF TRUTH. These rows mirror the `terms` and
-- `privacy` entries of `LEGAL_DOCUMENTS` in @civfix/contract/legal (0.62.1) byte for
-- byte; test/unit/legal-seed.test.ts reads the union of 0151, 0171, 0172 and
-- this file and fails on drift.
--
-- Publishing a NEW version is an INSERT, never an UPDATE (0151's header). The
-- 2026-09-21 terms and privacy rows stay forever: `consent_records` carries the
-- FK (document_type, document_version) and every consent already collected
-- points at them. This file only ADDS the 2026-10-20 rows.
--
-- DATA only, no DDL: the Drizzle mirror (schema/legal_documents.ts) is
-- unchanged. Two rows into a cold table, no index built, no lock of consequence.
--
-- Conventions: idempotent seed via ON CONFLICT DO NOTHING; one concern per
-- file. Forward-only.
-- Ordering rules: requires 0151_legal_documents_consents.sql (legal_documents).
-- =============================================================================

INSERT INTO legal_documents (type, version, sha256, effective_at, url) VALUES
  ('terms', '2026-10-20', '942aabae31cda45d9cdace018ee0953d28506b27d2f0c45b2d3cd554cfa66ed3', '2026-10-20T00:00:00.000Z', 'https://civfix.org/legal/terms'),
  ('privacy', '2026-10-20', '05dedba2376323c94697e2bfb43915f6b983761b806b74ba336d46c2f991ff8a', '2026-10-20T00:00:00.000Z', 'https://civfix.org/legal/privacy')
ON CONFLICT (type, version) DO NOTHING;
