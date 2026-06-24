-- =============================================================================
-- 0033_user_locale.sql
-- -----------------------------------------------------------------------------
-- Per-account UI/message locale (i18n). One BCP-47 base code clamped to a supported
-- language {en,es,de,ko}; 'en' is the source + fallback. The column is the SOURCE OF
-- TRUTH for SERVER-generated user-facing copy (push notification titles/bodies, account/
-- OTP emails) which is produced with no client in the loop, and seeds the client UI on a
-- fresh authed install. The client also keeps a local copy for instant/offline UI; a
-- local switch writes here (PUT /me/settings) for cross-device sync.
--
-- NOT NULL DEFAULT 'en' backfills every existing row to English on apply; the app-level
-- write path validates incoming values against the LocaleEnum {en,es,de,ko} and clamps/
-- rejects anything else, so the column never needs a DB CHECK (kept flexible like `role`).
-- -----------------------------------------------------------------------------
ALTER TABLE users
  ADD COLUMN locale text NOT NULL DEFAULT 'en';
