-- =============================================================================
-- 0096_cleanup_guests.sql
-- -----------------------------------------------------------------------------
-- Guest event RSVP (contract 0.38.0, DECISIONS sections 18-19): a neighbour who
-- will not create an account can still say they are coming. Three NEW tables, no
-- change to any existing one.
--
--   cleanup_guests  a verified guest attendance row scoped to ONE event. There is
--                   deliberately no guest identity: no cross-event key, no users
--                   FK, no way to look a guest up by contact. `contact_key` is
--                   the lowercased email or the E.164 phone, computed IN CODE
--                   (never in SQL) purely so a re-RSVP to the SAME event lands on
--                   the existing row instead of duplicating it. It is NULLed by
--                   the same two triggers that NULL email/phone -- the ~30-day
--                   retention scrub and the guest's own cancel -- so a cancelled
--                   or scrubbed row keeps the fact of the RSVP and loses every
--                   means of contacting the person. Only the SHA-256 of the
--                   manage token is stored (crypto.ts house rule), so a table
--                   leak does not hand out live cancel capabilities.
--   guest_otps      short-lived one-time codes for the request/verify handshake.
--                   Mirrors email_otps exactly (hash only, attempts, consumed_at,
--                   expires_at) but is event-scoped and carries the claimed name
--                   until verification promotes it into cleanup_guests.
--   sms_opt_outs    STOP-list. Kept indefinitely on purpose: a suppression list
--                   that expires re-enables texting someone who said stop.
--
-- CANONICAL DDL: hand-authored source of truth. Mirrors:
-- schema/cleanup_guests.ts, schema/guest_otps.ts, schema/sms_opt_outs.ts.
--
-- Conventions: CREATE TABLE / CREATE INDEX IF NOT EXISTS; one concern per file;
-- non-CONCURRENTLY builds accepted (brand-new, empty tables -- nothing to lock).
-- Forward-only, no down.
--
-- Ordering rules: requires 0000_extensions.sql (citext, gen_random_uuid) and
-- 0001_core.sql (cleanups).
-- =============================================================================

CREATE TABLE IF NOT EXISTS cleanup_guests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cleanup_id uuid NOT NULL REFERENCES cleanups(id) ON DELETE CASCADE,
  name text NOT NULL,
  channel text NOT NULL CHECK (channel IN ('email', 'sms')),
  email citext,
  phone text,
  contact_key text,
  manage_token_hash text NOT NULL,
  verified_at timestamptz NOT NULL DEFAULT now(),
  cancelled_at timestamptz,
  contact_scrubbed_at timestamptz,
  created_at timestamptz(3) NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS cleanup_guests_manage_token_uidx
  ON cleanup_guests (manage_token_hash);

CREATE UNIQUE INDEX IF NOT EXISTS cleanup_guests_active_contact_uidx
  ON cleanup_guests (cleanup_id, contact_key)
  WHERE cancelled_at IS NULL AND contact_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS cleanup_guests_cleanup_created_idx
  ON cleanup_guests (cleanup_id, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS cleanup_guests_unscrubbed_idx
  ON cleanup_guests (cleanup_id)
  WHERE contact_scrubbed_at IS NULL;

CREATE TABLE IF NOT EXISTS guest_otps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cleanup_id uuid NOT NULL REFERENCES cleanups(id) ON DELETE CASCADE,
  channel text NOT NULL CHECK (channel IN ('email', 'sms')),
  contact text NOT NULL,
  name text NOT NULL,
  code_hash text NOT NULL,
  expires_at timestamptz NOT NULL,
  attempts integer NOT NULL DEFAULT 0,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS guest_otps_cleanup_contact_created_idx
  ON guest_otps (cleanup_id, contact, created_at DESC);

CREATE INDEX IF NOT EXISTS guest_otps_created_idx
  ON guest_otps (created_at);

CREATE TABLE IF NOT EXISTS sms_opt_outs (
  phone text PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now()
);
