-- =============================================================================
-- 0006_user_profile.sql
-- -----------------------------------------------------------------------------
-- Adds two columns to `users` for the first-run registration flow:
--
--   * avatar_url        text, nullable. A provider (Google) profile photo URL captured at OAuth
--                       sign-in. NULL means the clients render the deterministic solid-color +
--                       first-letter monogram (gradients are retired). Apple/OTP leave it NULL.
--   * profile_complete  boolean, NOT NULL, default false. The first-run gate: a freshly created user
--                       starts incomplete and is blocked behind the required "pick a username + name"
--                       screen until they finish (PUT /me/profile sets it true).
--
-- BACKFILL: every PRE-EXISTING account is set profile_complete = true so we do NOT retroactively force
-- already-onboarded users back through registration. Only rows created AFTER this migration default to
-- false and therefore trigger the gate on first sign-in.
-- =============================================================================

ALTER TABLE users ADD COLUMN avatar_url text;
ALTER TABLE users ADD COLUMN profile_complete boolean NOT NULL DEFAULT false;

-- Existing accounts are considered already-registered.
UPDATE users SET profile_complete = true;
