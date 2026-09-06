-- =============================================================================
-- 0121_event_consents_registration_fk.sql
-- -----------------------------------------------------------------------------
-- Close the FK 0108 promised: event_consents.registration_id was written as a
-- bare uuid because cleanup_registrations did not exist yet. It does now (0116),
-- so the column becomes a real reference.
--
-- ON DELETE SET NULL, not CASCADE: a consent record is the proof a person
-- accepted the terms and the privacy notice, and it outlives the registration it
-- was captured with. Registrations are never hard-deleted today (cancellation is
-- a status flip), so this is a guard against a future erasure path, not a
-- behavioural change.
--
-- The table is brand-new and empty in this release, so the constraint is added
-- and validated in one step - no NOT VALID / VALIDATE split needed.
--
-- LOCK ORDER (binding on every writer): organizations -> organization_members
--   -> cleanups -> cleanup_members -> cleanup_guests -> cleanup_registrations
--   -> cleanup_registration_seats -> cleanup_answers -> cleanup_waitlist ->
--   cleanup_ticket_types -> cleanup_slots -> cleanup_slot_claims. event_consents is a leaf.
--
-- CANONICAL DDL: this file. Drizzle mirror: src/db/schema/event_consents.ts.
-- Ordering rules: requires 0108_event_consents.sql and 0116_cleanup_registrations.sql.
-- =============================================================================

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'event_consents_registration_id_fkey'
       AND conrelid = 'event_consents'::regclass
  ) THEN
    ALTER TABLE event_consents
      ADD CONSTRAINT event_consents_registration_id_fkey
      FOREIGN KEY (registration_id) REFERENCES cleanup_registrations(id) ON DELETE SET NULL;
  END IF;
END
$$;
