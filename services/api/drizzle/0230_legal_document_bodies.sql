-- =============================================================================
-- 0230_legal_document_bodies.sql
-- -----------------------------------------------------------------------------
-- WHY. Legal documents are written in @civfix/contract and served by the API
-- from this table (DECISIONS §66, epic #232). A version written since then
-- carries its title, a plain summary of what changed, whether the change is
-- material, and its text as blocks; the migration runner loads every contract
-- version into this table after the SQL migrations (src/db/migrate.ts,
-- src/services/legal-loader.ts), insert-only.
--
-- All four columns are nullable: the 2026-09-06, -16 and -21 rows (and the
-- retired donation rows) predate §66, had their text on a web page, and keep
-- them null. No row is updated here.
--
-- New versions are no longer seeded by migrations; 0151, 0171 and 0172 stay as
-- the history they are.
--
-- legal_documents is a few dozen rows: ADD COLUMN without a default is a
-- catalog-only change, no rewrite, no index.
--
-- CANONICAL DDL: hand-authored source of truth. Mirrors:
-- schema/legal_documents.ts.
--
-- Conventions: one transaction per file. Forward-only, no down.
-- Ordering rules: requires 0151_legal_documents_consents.sql (legal_documents).
-- =============================================================================

ALTER TABLE legal_documents
  ADD COLUMN IF NOT EXISTS title text,
  ADD COLUMN IF NOT EXISTS summary text,
  ADD COLUMN IF NOT EXISTS material boolean,
  ADD COLUMN IF NOT EXISTS blocks jsonb;
