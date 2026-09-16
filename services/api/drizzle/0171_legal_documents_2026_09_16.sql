-- =============================================================================
-- 0171_legal_documents_2026_09_16.sql
-- -----------------------------------------------------------------------------
-- WHY. Removing platform-processed donations rewrote the four public legal
-- documents: the terms lost the payment, refund and application-fee sections,
-- the privacy notice and the subprocessor list lost Stripe as a payment
-- processor and the data it received, and the cookie notice lost the checkout
-- entries. Different text is a different document, so each one gets a new
-- version (2026-09-16) and a new sha256, and every person is asked to accept
-- again.
--
-- THE CONTRACT IS STILL THE SOURCE OF TRUTH. These rows mirror
-- `LEGAL_DOCUMENTS` in @civfix/shared/legal (0.48.1) byte for byte;
-- test/unit/legal-seed.test.ts reads the union of 0151 and this file and fails
-- on drift.
--
-- Publishing a NEW version is an INSERT, never an UPDATE (0151's header). The
-- 2026-09-06 rows stay forever: `consent_records` carries the FK
-- (document_type, document_version) and every consent already collected points
-- at them. This file only ADDS the four 2026-09-16 rows so consents recorded
-- from now on have a parent to reference.
--
-- The three retired types -- donations, org_donation_agreement,
-- donation_disclosure -- are deliberately NOT re-versioned. Nothing renders or
-- asks for them any more; their 0151 rows stay because consent rows reference
-- them, and the type CHECK still accepts them so those rows remain legal.
--
-- DATA only, no DDL: the Drizzle mirror (schema/legal_documents.ts) is
-- unchanged. Four rows into a cold table, no index built, no lock of
-- consequence.
--
-- Conventions: idempotent seed via ON CONFLICT DO NOTHING; one concern per
-- file. Forward-only.
-- Ordering rules: requires 0151_legal_documents_consents.sql (legal_documents).
-- =============================================================================

INSERT INTO legal_documents (type, version, sha256, effective_at, url) VALUES
  ('terms', '2026-09-16', 'afa437255814c5fb39e75f7507304b7a2618aa1397bcdbe3d66129385515ca36', '2026-09-16T00:00:00.000Z', 'https://civfix.org/legal/terms'),
  ('privacy', '2026-09-16', 'd3789e993ddee83cb5c556234694a9d0f200e5d99b533eba6ca3ca2053df9417', '2026-09-16T00:00:00.000Z', 'https://civfix.org/legal/privacy'),
  ('cookies', '2026-09-16', '4a05415bba1ef0301058815ce6d01f98eb593bd18378e7ce52555074da3064c0', '2026-09-16T00:00:00.000Z', 'https://civfix.org/legal/cookies'),
  ('subprocessors', '2026-09-16', '5ab722bb37cc2972ada7521b6dc239bfd85f82691d0e3e2489f5dcac9983a198', '2026-09-16T00:00:00.000Z', 'https://civfix.org/legal/subprocessors')
ON CONFLICT (type, version) DO NOTHING;
