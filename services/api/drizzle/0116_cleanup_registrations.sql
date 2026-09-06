-- =============================================================================
-- 0116_cleanup_registrations.sql
-- -----------------------------------------------------------------------------
-- Registrations and their seats (W1.3). ONE file because the two tables are one
-- aggregate: a registration is never written without its seats and the capacity
-- transaction spans both.
--
--   cleanup_registrations       one row per party  (user OR guest, never both)
--   cleanup_registration_seats  one row per PERSON in that party
--
-- WHY SEATS ARE ROWS AND NOT JUST party_size: check-in is per person. Each seat
-- carries its own opaque ticket token, is scanned independently, and can be
-- marked no-show independently. party_size on the registration is the seat count
-- the capacity gate reserved; the seat rows are the day-of objects.
--
-- TICKET TOKENS: token = base32(HMAC-SHA256(TICKET_TOKEN_SECRET, seat_id))[0:16],
-- rendered as a 26-character grouped string. ONLY sha256(token) is stored, in
-- ticket_token_hash. The owner's copy is RECOMPUTED server-side from the seat id
-- on every read, so the database never holds anything that can be replayed as a
-- ticket, and the QR is rendered on the client (no qrcode-generator on the
-- server outside services/certificate-pdf.ts).
--
-- WHY ticket_token_hash IS UNIQUE ACROSS THE TABLE: the scanner presents a bare
-- token. A per-event unique index would let two events mint the same token and
-- make "wrong_event" ambiguous with "someone else's ticket". Global uniqueness
-- plus the cleanup_id predicate in the scan UPDATE gives the scanner exactly two
-- honest answers: this seat, or unknown_token.
--
-- WHY cleanup_id IS DENORMALIZED ONTO SEATS: the scan is a single UPDATE keyed
-- (ticket_token_hash, cleanup_id) - the tenant check has to be in the same
-- statement as the write, not a prior SELECT that a racing cancel can invalidate.
-- The composite FK (registration_id, cleanup_id) keeps the denormalization honest.
--
-- CHECK-IN IS IDEMPOTENT BY CONSTRUCTION:
--   UPDATE ... SET checked_in_at = COALESCE(checked_in_at, $now) ...
--   RETURNING (checked_in_at = $now) AS first_time
-- so the mobile offline outbox can replay a scan forever and the response
-- distinguishes "checked in just now" from "already checked in" without failing.
--
-- PRIVACY / RETENTION (W1.8, docs/retention-cleanup.md):
--   attendee_name  NULL   30 days post-event
--   checked_in_at  coarsened to date_trunc('day') at 30 days, stamped by
--                  checkin_coarsened_at so the lane is idempotent
--   host_note      NULL   90 days post-event, and never leaves the host surface
-- Every one of those columns is indexed by a partial predicate so the retention
-- lane's bounded batch never scans the table.
--
-- LOCK ORDER (binding on every writer): organizations -> organization_members
-- -> cleanups -> cleanup_members -> cleanup_guests -> cleanup_registrations ->
-- cleanup_registration_seats -> cleanup_answers -> cleanup_waitlist ->
-- cleanup_ticket_types -> cleanup_slots -> cleanup_slot_claims. Every writer
-- starts at `cleanups FOR SHARE`. cleanup_ticket_types is LAST because every
-- seat-release path is a single CTE that reads the registrations it cancels and
-- subtracts their seats afterwards (see 0115).
--   cleanup_registrations sits BEFORE cleanup_waitlist because that is the order
--   every release path actually takes: the user cancelRegistration CTE and the
--   guest cancelGuest CTE both go registrations -> seats -> answers -> waitlist
--   -> ticket_types, and PgUserStore.scrubAttendeeContributions (the erasure
--   attendee scrub) walks the same five steps. Nothing may take a waitlist row
--   and then wait on an EXISTING registration row - see the promoter exception
--   documented in 0117, which only ever INSERTs its registration.
--   ONE documented exception, exactly like claimSlot's in 0063: registerTx
--   upserts cleanup_members BEFORE it touches cleanup_ticket_types, because
--   sql.begin COMMITS on a normal return and every refusal (terminal event,
--   registration window, ban, unknown ticket type) has already returned by then.
--   No cycle: the only other writer taking cleanup_members before the ticket
--   tables is createCleanupTx, whose rows are brand new and unlockable by anyone
--   else until it commits.
--   registerTx is also the one writer that takes cleanup_ticket_types BEFORE
--   cleanup_registrations, and it still cannot cycle: the reserve is a blind
--   conditional UPDATE and the registration side is an INSERT of a brand-new
--   row, so it never waits on a registration row another transaction holds.
--
-- CANONICAL DDL: this file. Drizzle mirror: src/db/schema/cleanup_registrations.ts.
-- Ordering rules: requires 0115 (ticket types), 0096 (cleanup_guests), 0001 (users).
-- =============================================================================

CREATE TABLE IF NOT EXISTS cleanup_registrations (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  cleanup_id     uuid        NOT NULL REFERENCES cleanups (id) ON DELETE CASCADE,
  ticket_type_id uuid,
  user_id        uuid        REFERENCES users (id),
  guest_id       uuid        REFERENCES cleanup_guests (id) ON DELETE CASCADE,
  party_size     smallint    NOT NULL DEFAULT 1,
  status         text        NOT NULL DEFAULT 'registered',
  source         text        NOT NULL DEFAULT 'self',
  -- Host-private note about one attendee. Never exported to the attendee, never
  -- in /me/data-export (counsel), NULLed 90 days post-event.
  host_note      text,
  registered_at  timestamptz NOT NULL DEFAULT now(),
  cancelled_at   timestamptz,
  cancelled_by   uuid        REFERENCES users (id),
  FOREIGN KEY (ticket_type_id, cleanup_id)
    REFERENCES cleanup_ticket_types (id, cleanup_id) ON DELETE CASCADE
);

ALTER TABLE cleanup_registrations DROP CONSTRAINT IF EXISTS cleanup_registrations_subject_check;
ALTER TABLE cleanup_registrations ADD  CONSTRAINT cleanup_registrations_subject_check
  CHECK ((user_id IS NOT NULL) <> (guest_id IS NOT NULL));

ALTER TABLE cleanup_registrations DROP CONSTRAINT IF EXISTS cleanup_registrations_status_check;
ALTER TABLE cleanup_registrations ADD  CONSTRAINT cleanup_registrations_status_check
  CHECK (status IN ('registered', 'cancelled', 'transferred'));

ALTER TABLE cleanup_registrations DROP CONSTRAINT IF EXISTS cleanup_registrations_source_check;
ALTER TABLE cleanup_registrations ADD  CONSTRAINT cleanup_registrations_source_check
  CHECK (source IN ('self', 'waitlist', 'walkup', 'transfer'));

ALTER TABLE cleanup_registrations DROP CONSTRAINT IF EXISTS cleanup_registrations_party_bounds;
ALTER TABLE cleanup_registrations ADD  CONSTRAINT cleanup_registrations_party_bounds
  CHECK (party_size BETWEEN 1 AND 10);

ALTER TABLE cleanup_registrations DROP CONSTRAINT IF EXISTS cleanup_registrations_cancelled_stamp;
ALTER TABLE cleanup_registrations ADD  CONSTRAINT cleanup_registrations_cancelled_stamp
  CHECK (status <> 'cancelled' OR cancelled_at IS NOT NULL);

-- One ACTIVE registration per person per event. Re-registering after a cancel is
-- a new row (the cancelled one is the record of what happened).
CREATE UNIQUE INDEX IF NOT EXISTS cleanup_registrations_active_user_uidx
  ON cleanup_registrations (cleanup_id, user_id)
  WHERE status = 'registered' AND user_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS cleanup_registrations_active_guest_uidx
  ON cleanup_registrations (cleanup_id, guest_id)
  WHERE status = 'registered' AND guest_id IS NOT NULL;

-- FK target for cleanup_registration_seats' composite reference.
CREATE UNIQUE INDEX IF NOT EXISTS cleanup_registrations_id_cleanup_uidx
  ON cleanup_registrations (id, cleanup_id);

-- The host roster keyset page (registered_at DESC, id DESC).
CREATE INDEX IF NOT EXISTS cleanup_registrations_roster_idx
  ON cleanup_registrations (cleanup_id, registered_at DESC, id DESC);

-- Per-type counters and the roster's ticket-type filter.
CREATE INDEX IF NOT EXISTS cleanup_registrations_type_idx
  ON cleanup_registrations (ticket_type_id)
  WHERE status = 'registered';

-- "my registrations" and the erasure sweep.
CREATE INDEX IF NOT EXISTS cleanup_registrations_user_idx
  ON cleanup_registrations (user_id, registered_at DESC)
  WHERE user_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS cleanup_registrations_guest_idx
  ON cleanup_registrations (guest_id)
  WHERE guest_id IS NOT NULL;

-- Retention lane: host_note NULL at 90 days. Bounded batch, no seq scan.
CREATE INDEX IF NOT EXISTS cleanup_registrations_host_note_idx
  ON cleanup_registrations (cleanup_id)
  WHERE host_note IS NOT NULL;

CREATE TABLE IF NOT EXISTS cleanup_registration_seats (
  id                   uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  cleanup_id           uuid        NOT NULL REFERENCES cleanups (id) ON DELETE CASCADE,
  registration_id      uuid        NOT NULL REFERENCES cleanup_registrations (id) ON DELETE CASCADE,
  seat_index           smallint    NOT NULL,
  -- Optional "who is this seat for". NULLed 30 days post-event.
  attendee_name        text,
  ticket_token_hash    text        NOT NULL,
  status               text        NOT NULL DEFAULT 'active',
  checked_in_at        timestamptz,
  checked_in_by        uuid        REFERENCES users (id),
  checkin_method       text,
  checkin_coarsened_at timestamptz,
  no_show_at           timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (registration_id, cleanup_id)
    REFERENCES cleanup_registrations (id, cleanup_id) ON DELETE CASCADE
);

ALTER TABLE cleanup_registration_seats DROP CONSTRAINT IF EXISTS cleanup_registration_seats_status_check;
ALTER TABLE cleanup_registration_seats ADD  CONSTRAINT cleanup_registration_seats_status_check
  CHECK (status IN ('active', 'cancelled'));

ALTER TABLE cleanup_registration_seats DROP CONSTRAINT IF EXISTS cleanup_registration_seats_method_check;
ALTER TABLE cleanup_registration_seats ADD  CONSTRAINT cleanup_registration_seats_method_check
  CHECK (checkin_method IS NULL OR checkin_method IN ('scan', 'manual', 'self', 'walkup'));

-- A method without a timestamp (or the reverse) is an unreadable audit trail.
ALTER TABLE cleanup_registration_seats DROP CONSTRAINT IF EXISTS cleanup_registration_seats_method_pairing;
ALTER TABLE cleanup_registration_seats ADD  CONSTRAINT cleanup_registration_seats_method_pairing
  CHECK ((checked_in_at IS NULL) = (checkin_method IS NULL));

-- A seat is either present or absent, never both.
ALTER TABLE cleanup_registration_seats DROP CONSTRAINT IF EXISTS cleanup_registration_seats_presence_exclusive;
ALTER TABLE cleanup_registration_seats ADD  CONSTRAINT cleanup_registration_seats_presence_exclusive
  CHECK (checked_in_at IS NULL OR no_show_at IS NULL);

ALTER TABLE cleanup_registration_seats DROP CONSTRAINT IF EXISTS cleanup_registration_seats_index_bounds;
ALTER TABLE cleanup_registration_seats ADD  CONSTRAINT cleanup_registration_seats_index_bounds
  CHECK (seat_index >= 0 AND seat_index < 10);

-- The scanner's lookup, and the reason a token can never be minted twice.
CREATE UNIQUE INDEX IF NOT EXISTS cleanup_registration_seats_token_uidx
  ON cleanup_registration_seats (ticket_token_hash);

CREATE UNIQUE INDEX IF NOT EXISTS cleanup_registration_seats_registration_seat_uidx
  ON cleanup_registration_seats (registration_id, seat_index);

CREATE INDEX IF NOT EXISTS cleanup_registration_seats_registration_idx
  ON cleanup_registration_seats (registration_id);

-- Live day-of counters + the arrivals curve.
CREATE INDEX IF NOT EXISTS cleanup_registration_seats_arrivals_idx
  ON cleanup_registration_seats (cleanup_id, checked_in_at)
  WHERE checked_in_at IS NOT NULL;

-- The no-show sweep's candidate set.
CREATE INDEX IF NOT EXISTS cleanup_registration_seats_pending_idx
  ON cleanup_registration_seats (cleanup_id)
  WHERE status = 'active' AND checked_in_at IS NULL AND no_show_at IS NULL;

-- Retention lanes: attendee_name NULL at 30d; checked_in_at coarsened at 30d.
CREATE INDEX IF NOT EXISTS cleanup_registration_seats_name_idx
  ON cleanup_registration_seats (cleanup_id)
  WHERE attendee_name IS NOT NULL;

CREATE INDEX IF NOT EXISTS cleanup_registration_seats_coarsen_idx
  ON cleanup_registration_seats (cleanup_id)
  WHERE checked_in_at IS NOT NULL AND checkin_coarsened_at IS NULL;

COMMENT ON TABLE cleanup_registrations IS
  'One row per registered party (user XOR guest). party_size is the seat count the capacity gate reserved.';
COMMENT ON TABLE cleanup_registration_seats IS
  'One row per person in a party. Carries the ticket token hash and the per-person check-in state.';
COMMENT ON COLUMN cleanup_registration_seats.ticket_token_hash IS
  'sha256 of the HMAC-derived ticket token. The token itself is never stored; the owner copy is recomputed from the seat id.';
