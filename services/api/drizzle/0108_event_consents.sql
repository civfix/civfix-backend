-- =============================================================================
-- 0108_event_consents.sql
-- -----------------------------------------------------------------------------
-- The consent artifact for event registration (W1.3, W1.8). Today the terms/age
-- acceptance on the signup surfaces is a client-side checkbox: nothing is recorded,
-- so there is no answer to "which version of which document did this person accept,
-- and when". One NEW table gives that answer for every registration, member or
-- guest.
--
-- Written INSIDE the registration transaction, never after it: a registration that
-- exists without its consent row is exactly the state this table exists to make
-- impossible. `accepted_at` is the SERVER clock - the payload deliberately carries
-- no timestamp for a client to choose.
--
-- The versions are validated against @civfix/shared/legal before the insert, so a
-- stale client cannot record acceptance of a document that is no longer current.
--
-- RETENTION: never scrubbed and never swept. A consent row is the evidence that
-- consent existed; it dies with its event (ON DELETE CASCADE) and no earlier. It
-- holds no contact detail of its own - the subject is a foreign key, not an
-- address - so keeping it costs no additional exposure. `guest_id` is a plain
-- reference (NO ACTION): a guest row that a consent artifact points at must not be
-- deletable out from under it. Guests are tombstoned, not deleted, so this never
-- blocks the cancel path.
--
-- `registration_id` is a bare uuid here on purpose: cleanup_registrations does not
-- exist yet. Its foreign key (ON DELETE SET NULL) lands with that table.
--
-- No IP address is stored, by default and by decision.
--
-- CANONICAL DDL: hand-authored source of truth. Mirror: schema/event_consents.ts.
--
-- Conventions: CREATE TABLE / CREATE INDEX IF NOT EXISTS; one concern per file;
-- non-CONCURRENTLY builds accepted (brand-new, empty table). Forward-only, no down.
--
-- LOCK ORDER (binding on every writer): organizations -> organization_members
--   -> cleanups -> cleanup_members -> cleanup_guests -> cleanup_registrations
--   -> cleanup_registration_seats -> cleanup_answers -> cleanup_waitlist ->
--   cleanup_ticket_types -> cleanup_slots -> cleanup_slot_claims
--
-- Ordering rules: requires 0001_core.sql (cleanups, users) and
-- 0096_cleanup_guests.sql (cleanup_guests).
-- =============================================================================

CREATE TABLE IF NOT EXISTS event_consents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cleanup_id uuid NOT NULL REFERENCES cleanups(id) ON DELETE CASCADE,
  subject_type text NOT NULL CHECK (subject_type IN ('user', 'guest')),
  user_id uuid REFERENCES users(id),
  guest_id uuid REFERENCES cleanup_guests(id),
  registration_id uuid,
  terms_version text NOT NULL,
  disclosure_version text NOT NULL,
  host_contact_opt_in boolean NOT NULL DEFAULT false,
  sms_opt_in boolean NOT NULL DEFAULT false,
  surface text,
  accepted_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT event_consents_subject_chk CHECK (
    (subject_type = 'user' AND user_id IS NOT NULL AND guest_id IS NULL)
    OR (subject_type = 'guest' AND guest_id IS NOT NULL AND user_id IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS event_consents_cleanup_accepted_idx
  ON event_consents (cleanup_id, accepted_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS event_consents_user_idx
  ON event_consents (user_id, accepted_at DESC)
  WHERE user_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS event_consents_guest_idx
  ON event_consents (guest_id, accepted_at DESC)
  WHERE guest_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS event_consents_registration_idx
  ON event_consents (registration_id)
  WHERE registration_id IS NOT NULL;

COMMENT ON TABLE event_consents IS
  'Consent artifact per registration. Written in the registration transaction, never scrubbed by any retention lane, deleted only with its event.';
COMMENT ON COLUMN event_consents.accepted_at IS
  'Server clock. The wire payload carries no timestamp - a client must not be able to choose when it consented.';
