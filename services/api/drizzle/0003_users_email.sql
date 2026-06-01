-- =============================================================================
-- 0003_users_email.sql
-- -----------------------------------------------------------------------------
-- Adds a real email column to users so OTP and OAuth find-or-create can resolve
-- "the user for this email" directly, replacing the prior synthetic "email"
-- pseudo-provider row in oauth_identities.
--
--   * email           CITEXT, nullable (case-insensitive equality + uniqueness).
--   * email_verified  boolean NOT NULL DEFAULT false (set true once the address is
--                     proven via a verified OTP or a verified-email OAuth claim).
--   * users_email_key PARTIAL UNIQUE (WHERE email IS NOT NULL) so the address is
--                     unique when present but many rows may keep a NULL email.
--
-- CANONICAL DDL: this hand-authored SQL is the source of truth. The Drizzle
-- definition in src/db/schema/users.ts mirrors it for typed queries.
--
-- Ordering rules:
--   * Requires 0000_extensions.sql (citext) already applied.
--   * All statements use IF NOT EXISTS so a partial / repeat apply is safe; the
--     migrate runner additionally records applied files in _civfix_migrations.
-- =============================================================================

ALTER TABLE users ADD COLUMN IF NOT EXISTS email citext;
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified boolean NOT NULL DEFAULT false;

CREATE UNIQUE INDEX IF NOT EXISTS users_email_key
  ON users (email)
  WHERE email IS NOT NULL;
