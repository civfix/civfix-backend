-- =============================================================================
-- 0064_service_hours_certificates.sql
-- -----------------------------------------------------------------------------
-- P5: issued, verifiable PDF transcripts of a user's volunteer service.
--
-- WHY: a volunteer needs to hand a school / employer / court a document that a
-- third party can confirm without a civfix account. The ROW is the record of
-- truth; the R2 object is a durable cache that is re-renderable from `snapshot`.
-- `code` is the 12-char Crockford-base32 public capability printed on the
-- document (see @civfix/shared normalizeCertificateCode); it is the ONLY
-- identifier the public verify endpoint accepts, and `id` (which is also the R2
-- key segment) is never disclosed.
--
-- THE ROW IS A SNAPSHOT, NOT A VIEW. total_hours / entry_count / period_start /
-- period_end are frozen at issue time and the verify endpoint reports them
-- verbatim; it never re-reads the ledger. A document whose number silently
-- changes after a registrar has filed it is worse than no document. If the ledger
-- is later corrected, the holder issues a NEW certificate.
--
-- IDEMPOTENCY, via ledger_fingerprint + the partial unique index below: two taps
-- on "Prepare transcript" over an unchanged ledger must return the SAME code and
-- render nothing the second time. Revoking frees the slot so the holder can
-- re-issue over the same ledger.
--
-- v1 ISSUES OVER THE WHOLE LEDGER — there are deliberately no issue-time filter
-- columns (no jurisdiction_geoid FK, no caller-supplied from/to). period_start
-- and period_end are the DERIVED min/max of the included rows. Filters multiply
-- documents and complicate the fingerprint for a v1 nobody asked for. There is
-- also no `recipient` ("Issued for: Lincoln High School"): it would have to enter
-- the fingerprint, turning every recipient into a separate document, and it adds
-- a slur-gate for no verification value — the code is what a registrar checks.
-- Both are recorded follow-ups, not omissions.
--
-- revoked_at, not a DELETE: a revoked certificate must keep answering "this code
-- was issued and has been revoked" rather than "no such code", which is a
-- materially different answer for the person holding the paper. The R2 object IS
-- deleted on revoke, so the download link dies with it.
--
-- Erasure: NO `ON DELETE CASCADE` to users — account deletion is a soft tombstone
-- (docs/erasure-behavior.md, and see 0063's banner) and the verify projection
-- filters on users.deleted_at instead.
--
-- CANONICAL DDL: this hand-authored SQL is the source of truth. The Drizzle mirror
-- lives at src/db/schema/service-hours-certificates.ts and
-- test/integration/schema.test.ts asserts the two agree.
--
-- NO `BEGIN;` / `COMMIT;` IN THIS FILE. src/db/migrate.ts:83-97 wraps EVERY file
-- in its own begin/commit on a reserved connection, together with the
-- _civfix_migrations bookkeeping INSERT ("the DDL and its bookkeeping row commit
-- together or not at all"). A file that opens its own transaction ends the
-- runner's one mid-flight: the bookkeeping row then commits separately in
-- autocommit, the runner's trailing `commit` warns "no transaction in progress",
-- and the catch branch's `rollback` becomes a silent no-op. Zero of the existing
-- migrations contain a transaction-control statement; test/unit/
-- migrations-transaction-control.test.ts keeps it that way.
--
-- The table is new and empty, so the in-transaction CREATE INDEX lock hazard
-- documented in src/db/migrate.ts does not apply here.
--
-- Conventions (match the rest of the suite): timestamptz, additive
-- IF NOT EXISTS so a partial or repeat apply is safe. Forward-only — no down
-- migration.
--
-- Ordering rules: requires 0001_core.sql (users) and 0035_volunteer_hours.sql
-- (the ledger this snapshots).
-- =============================================================================

CREATE TABLE IF NOT EXISTS service_hours_certificates (
  id                 uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            uuid         NOT NULL REFERENCES users (id),
  -- Canonical-uppercase 12-char Crockford-base32 public verification capability.
  code               text         NOT NULL,
  -- The locale the PDF was rendered in; a re-issue in another locale is a new row.
  locale             text         NOT NULL,
  -- Denormalized holder identity, frozen with the rest of the snapshot: the
  -- document names the person it was issued to at the time it was issued, even if
  -- they later rename themselves or the account is tombstoned.
  holder_name        text         NOT NULL,
  holder_handle      text,
  holder_verified    boolean      NOT NULL DEFAULT false,
  -- Snapshot: the SUM of the itemised ledger entries the PDF prints, so the
  -- printed total always equals the sum of the printed lines.
  total_hours        numeric(8,2) NOT NULL,
  entry_count        integer      NOT NULL,
  -- Derived min/max occurredAt of the included rows (NOT caller-supplied filters).
  period_start       timestamptz,
  period_end         timestamptz,
  -- Stable digest of the exact ledger rows included; the idempotency key.
  ledger_fingerprint text         NOT NULL,
  -- The exact rendered model, so the object can be re-rendered byte-for-byte.
  snapshot           jsonb        NOT NULL,
  -- R2 object key. Always served through a forceSigned presign, never a public CDN URL.
  r2_key             text         NOT NULL,
  document_sha256    text         NOT NULL,
  byte_size          integer      NOT NULL,
  issued_at          timestamptz  NOT NULL DEFAULT now(),
  regenerated_at     timestamptz,
  revoked_at         timestamptz,
  revoked_reason     text
);

CREATE UNIQUE INDEX IF NOT EXISTS service_hours_certificates_code_uidx
  ON service_hours_certificates (code);

-- Idempotency: at most ONE live certificate per (holder, ledger fingerprint). Revoking frees the slot so
-- the holder can re-issue over the same ledger.
CREATE UNIQUE INDEX IF NOT EXISTS service_hours_certificates_live_fp_uidx
  ON service_hours_certificates (user_id, ledger_fingerprint)
  WHERE revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS service_hours_certificates_user_issued_idx
  ON service_hours_certificates (user_id, issued_at DESC);

COMMENT ON TABLE service_hours_certificates IS
  'Issued PDF service-hours transcripts (P5). code = public 12-char verification capability; snapshot = the exact rendered model; the row is an immutable snapshot of the ledger at issue time, revocable by the holder.';
