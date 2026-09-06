-- =============================================================================
-- 0115_cleanup_ticket_types.sql
-- -----------------------------------------------------------------------------
-- Free ticket types (W1.3). A registration is exactly ONE ticket type x N seats.
-- There is no price column anywhere: paid ticketing is deliberately out of scope
-- (donations are a separate org-level flow, W4). `cleanup_slots` stay
-- "shifts/roles" an already-registered attendee claims afterwards; a ticket type
-- is the capacity bucket the registration itself consumes.
--
-- WHY reserved_seats IS A COLUMN AND NOT count(*): the registration transaction
-- must decide "does this party fit" without counting rows under a lock. The
-- capacity gate is ONE conditional UPDATE
--
--   UPDATE cleanup_ticket_types
--      SET reserved_seats = reserved_seats + $n
--    WHERE id = $t AND cleanup_id = $c
--      AND (capacity IS NULL OR reserved_seats + $n <= capacity)
--   RETURNING ...
--
-- which is serialized by Postgres' own row lock plus the EvalPlanQual re-check,
-- so N concurrent registrations against capacity C oversell by exactly zero
-- without any explicit FOR UPDATE. Zero returned rows means "did not fit" and
-- the caller runs ONE follow-up SELECT to say WHY (full / party_too_large /
-- sales_closed / not_found) - a diagnosis, never a second attempt.
--
-- WHY THE CHECK IS A BACKSTOP AND NOT THE GATE: the CHECK below can only ever
-- fire if some future writer forgets the `reserved_seats + n <= capacity`
-- predicate. When it fires the registration service maps 23514 to
-- AppError.internal and reports it - NEVER to "full", which would silently paper
-- over a broken capacity path with a plausible-looking refusal.
--
-- WHY UNIQUE (id, cleanup_id): FK target for the composite references from
-- cleanup_registrations / cleanup_waitlist / cleanup_questions, which is what
-- makes "register for a ticket type belonging to a DIFFERENT event" structurally
-- impossible instead of an app-layer check a new call path can forget. Same
-- stance as cleanup_slots (0063) and chat_poll_votes (0048).
--
-- WHY THE CHILD FKs CASCADE (and what guards the data): a composite FK cannot be
-- ON DELETE SET NULL (it would have to null cleanup_id, which is NOT NULL) and
-- ON DELETE RESTRICT would break the legitimate `DELETE FROM cleanups` cascade
-- (the parent delete would trip the RESTRICT between two of its own children).
-- So the child FKs CASCADE and the ONE guard against a host deleting a sold
-- ticket type is the service: deleteTicketType refuses while ANY registration or
-- waitlist row references the type, in any status.
--
-- access_code_hash is sha256 of the trimmed code; the code itself is never
-- stored and never returned (the DTO exposes only `accessCodeSet`).
--
-- LOCK ORDER (binding on every writer): organizations -> organization_members
-- -> cleanups -> cleanup_members -> cleanup_guests -> cleanup_registrations ->
-- cleanup_registration_seats -> cleanup_answers -> cleanup_waitlist ->
-- cleanup_ticket_types -> cleanup_slots -> cleanup_slot_claims. Every writer
-- starts at `cleanups FOR SHARE`.
--
-- WHY cleanup_ticket_types SITS LAST rather than where a "parent before child"
-- reading would put it: every release path (cancelRegistration, the guest
-- cancelGuest CTE, the erasure attendee scrub, offer expiry) is ONE statement
-- that reads the rows it is cancelling and only then subtracts their seats from
-- the type. Those statements cannot be reordered - a CTE decides its own
-- execution order - so the type row is always the LAST row such a writer takes.
-- The multi-statement writers (transferRegistration) follow suit: registration
-- row FOR UPDATE first, then the two type rows in id order. registerTx is the
-- documented inverse and cannot cycle: it takes the type row with a blind
-- conditional UPDATE and only ever INSERTs registrations, so it never waits on a
-- registration row anyone else holds.
--
-- CANONICAL DDL: this file. Drizzle mirror: src/db/schema/cleanup_ticket_types.ts.
-- Conventions: timestamptz, additive IF NOT EXISTS, one transaction per file
-- (so no CREATE INDEX CONCURRENTLY here), forward-only.
--
-- Ordering rules: requires 0001_core.sql (cleanups) and 0105-0114 (host columns).
-- =============================================================================

CREATE TABLE IF NOT EXISTS cleanup_ticket_types (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  cleanup_id       uuid        NOT NULL REFERENCES cleanups (id) ON DELETE CASCADE,
  name             text        NOT NULL,
  description      text,
  -- NULL = unlimited. Lowering it below reserved_seats does NOT evict anyone:
  -- the type simply refuses new registrations until it drains.
  capacity         integer,
  -- Seats held by an active registration OR by an outstanding waitlist offer.
  reserved_seats   integer     NOT NULL DEFAULT 0,
  sales_opens_at   timestamptz,
  sales_closes_at  timestamptz,
  visibility       text        NOT NULL DEFAULT 'public',
  access_code_hash text,
  max_party_size   smallint    NOT NULL DEFAULT 1,
  sort_order       smallint    NOT NULL DEFAULT 0,
  waitlist_enabled boolean     NOT NULL DEFAULT false,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE cleanup_ticket_types DROP CONSTRAINT IF EXISTS cleanup_ticket_types_visibility_check;
ALTER TABLE cleanup_ticket_types ADD  CONSTRAINT cleanup_ticket_types_visibility_check
  CHECK (visibility IN ('public', 'hidden', 'access_code'));

ALTER TABLE cleanup_ticket_types DROP CONSTRAINT IF EXISTS cleanup_ticket_types_capacity_positive;
ALTER TABLE cleanup_ticket_types ADD  CONSTRAINT cleanup_ticket_types_capacity_positive
  CHECK (capacity IS NULL OR capacity > 0);

-- THE OVERSELL BACKSTOP. See the banner: a violation is a bug in a writer, not a
-- full ticket type, and the service reports it as such.
ALTER TABLE cleanup_ticket_types DROP CONSTRAINT IF EXISTS cleanup_ticket_types_reserved_bounds;
ALTER TABLE cleanup_ticket_types ADD  CONSTRAINT cleanup_ticket_types_reserved_bounds
  CHECK (reserved_seats >= 0 AND (capacity IS NULL OR reserved_seats <= capacity));

ALTER TABLE cleanup_ticket_types DROP CONSTRAINT IF EXISTS cleanup_ticket_types_party_bounds;
ALTER TABLE cleanup_ticket_types ADD  CONSTRAINT cleanup_ticket_types_party_bounds
  CHECK (max_party_size BETWEEN 1 AND 10);

-- An access-code type without a code is an OPEN type wearing a lock icon.
ALTER TABLE cleanup_ticket_types DROP CONSTRAINT IF EXISTS cleanup_ticket_types_access_code_present;
ALTER TABLE cleanup_ticket_types ADD  CONSTRAINT cleanup_ticket_types_access_code_present
  CHECK (visibility <> 'access_code' OR access_code_hash IS NOT NULL);

ALTER TABLE cleanup_ticket_types DROP CONSTRAINT IF EXISTS cleanup_ticket_types_sales_window;
ALTER TABLE cleanup_ticket_types ADD  CONSTRAINT cleanup_ticket_types_sales_window
  CHECK (sales_opens_at IS NULL OR sales_closes_at IS NULL OR sales_closes_at > sales_opens_at);

-- Two types on one event may not share a name case-insensitively: the roster
-- filter, the counters panel and the public page all address a type by its name.
CREATE UNIQUE INDEX IF NOT EXISTS cleanup_ticket_types_cleanup_name_uidx
  ON cleanup_ticket_types (cleanup_id, lower(name));

-- FK target for the composite references from every child table (see banner).
CREATE UNIQUE INDEX IF NOT EXISTS cleanup_ticket_types_id_cleanup_uidx
  ON cleanup_ticket_types (id, cleanup_id);

CREATE INDEX IF NOT EXISTS cleanup_ticket_types_cleanup_idx
  ON cleanup_ticket_types (cleanup_id, sort_order, id);

COMMENT ON TABLE cleanup_ticket_types IS
  'Free ticket types on an event (W1.3). reserved_seats is the atomic capacity gate; the CHECK is an oversell backstop, never the gate.';
COMMENT ON COLUMN cleanup_ticket_types.reserved_seats IS
  'Seats held by an active registration or an outstanding waitlist offer. Mutated only by the conditional UPDATE in registerTx / claim / cancel.';
