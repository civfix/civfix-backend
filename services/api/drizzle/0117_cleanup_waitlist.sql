-- =============================================================================
-- 0117_cleanup_waitlist.sql
-- -----------------------------------------------------------------------------
-- Per-ticket-type FIFO waitlist (W1.3, W1.4).
--
-- THE ONE RULE THAT SHAPES THIS TABLE: an OFFER RESERVES SEATS. When the
-- promoter offers a place it increments cleanup_ticket_types.reserved_seats
-- immediately and stamps claim_expires_at. A promoted attendee therefore cannot
-- lose the seat to a walk-in between the notification and the tap, and the claim
-- itself writes a registration WITHOUT touching reserved_seats (the seats are
-- already held). An expired offer releases them again.
--
-- STRICT FIFO, HEAD-OF-LINE BLOCKING ON PURPOSE: `waitlist.promote` claims the
-- single oldest waiting row with FOR UPDATE SKIP LOCKED and stops if that party
-- does not fit. Skipping a party of 4 to promote a party of 1 behind it is a
-- fairness bug, not an optimization, so the queue simply waits for room.
--
-- singletonKey on the promote job is the ticket_type_id, so at most one promoter
-- runs per type and the SKIP LOCKED is a belt-and-braces guard rather than the
-- only serialization.
--
-- LOCK ORDER (binding on every writer): organizations -> organization_members
-- -> cleanups -> cleanup_members -> cleanup_guests -> cleanup_registrations ->
-- cleanup_registration_seats -> cleanup_answers -> cleanup_waitlist ->
-- cleanup_ticket_types -> cleanup_slots -> cleanup_slot_claims. cleanup_waitlist
-- sits AFTER registrations/seats/answers because that is the order the two
-- release CTEs actually take: cancelRegistration and the guest cancelGuest CTE
-- both reach registrations, then seats, then answers, then the queue, then the
-- ticket type. The erasure attendee scrub (PgUserStore.scrubAttendeeContributions)
-- takes the same five steps.
--   ONE documented exception, and it cannot cycle: the promoter
--   (offerWaitlistEntry / offerNextWaitlistEntry / claimWaitlistOffer) locks the
--   QUEUE row first and only then reaches registrations - but the registration
--   side of that path is an INSERT of a brand-new row, so the promoter never
--   waits on a registration row another transaction holds. Any future writer
--   that locks an EXISTING registration row after a waitlist row would close the
--   cycle and is forbidden.
-- The ticket type is taken LAST on every offer/expire/leave/claim statement,
-- matching the release paths in 0115. claimWaitlistOffer opens with
-- `cleanups FOR SHARE` before it touches the queue row so it starts at the head
-- of the chain like every other writer.
--
-- CANONICAL DDL: this file. Drizzle mirror: src/db/schema/cleanup_waitlist.ts.
-- Ordering rules: requires 0115 (ticket types), 0116 (registrations).
-- =============================================================================

CREATE TABLE IF NOT EXISTS cleanup_waitlist (
  id                      uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  cleanup_id              uuid        NOT NULL REFERENCES cleanups (id) ON DELETE CASCADE,
  ticket_type_id          uuid        NOT NULL,
  user_id                 uuid        REFERENCES users (id),
  guest_id                uuid        REFERENCES cleanup_guests (id) ON DELETE CASCADE,
  party_size              smallint    NOT NULL DEFAULT 1,
  status                  text        NOT NULL DEFAULT 'waiting',
  created_at              timestamptz NOT NULL DEFAULT now(),
  offered_at              timestamptz,
  claim_expires_at        timestamptz,
  promoted_registration_id uuid       REFERENCES cleanup_registrations (id) ON DELETE SET NULL,
  FOREIGN KEY (ticket_type_id, cleanup_id)
    REFERENCES cleanup_ticket_types (id, cleanup_id) ON DELETE CASCADE
);

ALTER TABLE cleanup_waitlist DROP CONSTRAINT IF EXISTS cleanup_waitlist_subject_check;
ALTER TABLE cleanup_waitlist ADD  CONSTRAINT cleanup_waitlist_subject_check
  CHECK ((user_id IS NOT NULL) <> (guest_id IS NOT NULL));

ALTER TABLE cleanup_waitlist DROP CONSTRAINT IF EXISTS cleanup_waitlist_status_check;
ALTER TABLE cleanup_waitlist ADD  CONSTRAINT cleanup_waitlist_status_check
  CHECK (status IN ('waiting', 'offered', 'claimed', 'expired', 'cancelled'));

ALTER TABLE cleanup_waitlist DROP CONSTRAINT IF EXISTS cleanup_waitlist_party_bounds;
ALTER TABLE cleanup_waitlist ADD  CONSTRAINT cleanup_waitlist_party_bounds
  CHECK (party_size BETWEEN 1 AND 10);

-- An offer without its window (or the reverse) is an offer nothing can expire.
ALTER TABLE cleanup_waitlist DROP CONSTRAINT IF EXISTS cleanup_waitlist_offer_pairing;
ALTER TABLE cleanup_waitlist ADD  CONSTRAINT cleanup_waitlist_offer_pairing
  CHECK (status <> 'offered' OR (offered_at IS NOT NULL AND claim_expires_at IS NOT NULL));

-- The FIFO head the promoter claims (strict order, one type at a time).
CREATE INDEX IF NOT EXISTS cleanup_waitlist_fifo_idx
  ON cleanup_waitlist (ticket_type_id, created_at, id)
  WHERE status = 'waiting';

-- The expiry sweep's candidate set.
CREATE INDEX IF NOT EXISTS cleanup_waitlist_expiry_idx
  ON cleanup_waitlist (claim_expires_at)
  WHERE status = 'offered';

-- One live queue entry per person per ticket type.
CREATE UNIQUE INDEX IF NOT EXISTS cleanup_waitlist_active_user_uidx
  ON cleanup_waitlist (ticket_type_id, user_id)
  WHERE status IN ('waiting', 'offered') AND user_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS cleanup_waitlist_active_guest_uidx
  ON cleanup_waitlist (ticket_type_id, guest_id)
  WHERE status IN ('waiting', 'offered') AND guest_id IS NOT NULL;

-- The host's waitlist page (keyset, oldest first is the meaningful order).
CREATE INDEX IF NOT EXISTS cleanup_waitlist_cleanup_idx
  ON cleanup_waitlist (cleanup_id, created_at, id);

COMMENT ON TABLE cleanup_waitlist IS
  'Per-ticket-type FIFO waitlist. An offer RESERVES seats for the length of the claim window; expiry releases them.';
