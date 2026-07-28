-- =============================================================================
-- 0063_cleanup_slots.sql
-- -----------------------------------------------------------------------------
-- P9 (SignUpGenius-style signup slots): a host defines named roles/shifts on an
-- event ("Registration table", "Grill", "8-10am sweep"), each with an optional
-- capacity, and an attendee claims exactly ONE of them.
--
-- WHY A SURROGATE uuid PK ON cleanup_slots (and not the (parent, idx) composite
-- that chat_poll_options uses, 0048): poll options are immutable once posted;
-- SLOTS ARE EDITABLE. A host renames and REORDERS them while claims already
-- exist. With an ordinal PK a reorder would silently re-point every claim at a
-- different role. sort_order is presentational ONLY; identity is the uuid.
--
-- WHY cleanup_slot_claims IS KEYED (cleanup_id, user_id): that composite PK IS
-- the v1 product rule "one slot per person per event" — enforced by the schema,
-- not by application code, so a concurrent double-claim is a constraint conflict
-- rather than a race. Re-claiming is an ON CONFLICT DO UPDATE (a MOVE), never a
-- duplicate row. Same PK shape as cleanup_members, deliberately.
--
-- WHY THE COMPOSITE FK (slot_id, cleanup_id) -> cleanup_slots (id, cleanup_id):
-- it makes "claim a slot that belongs to a DIFFERENT event" structurally
-- impossible rather than an app-layer check that can be forgotten on a new call
-- path. Same stance as chat_poll_votes' composite FK to (poll_id, idx) in 0048.
-- It requires the redundant-looking UNIQUE (id, cleanup_id) index below, because
-- a FK target must be a unique constraint and the PK alone is only (id).
--
-- WHY NO ON DELETE CASCADE TO users: accounts are SOFT-deleted everywhere in the
-- product (docs/erasure-behavior.md; users.routes deleteAccount ->
-- softDeleteAndAnonymize keeps the row), so a cascade would never fire, and a
-- claim is roster data that must survive a tombstone exactly like the
-- cleanup_members row it accompanies. Cleanups DO cascade (deleting the event
-- takes its slots and their claims with it).
--
-- LOCK ORDER (binding on every writer): cleanups -> cleanup_members ->
-- cleanup_slots -> cleanup_slot_claims. joinCleanupTx already takes FOR SHARE on
-- cleanups first and removeMember FOR NO KEY UPDATE; the claim transaction must
-- start at cleanups too or the two can deadlock ABBA.
--
-- CANONICAL DDL: this hand-authored SQL is the source of truth. The Drizzle
-- mirror lives at src/db/schema/cleanup_slots.ts (both tables).
--
-- Conventions: timestamptz, additive IF NOT EXISTS so a partial or repeat apply
-- is safe; src/db/migrate.ts wraps each file in ONE transaction (so no
-- CREATE INDEX CONCURRENTLY here). Forward-only — no down migration.
--
-- Ordering rules: requires 0001_core.sql (users, cleanups, cleanup_members).
-- =============================================================================

CREATE TABLE IF NOT EXISTS cleanup_slots (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  cleanup_id  uuid        NOT NULL REFERENCES cleanups (id) ON DELETE CASCADE,
  title       text        NOT NULL,
  description text,
  -- NULL = unlimited. A positive integer caps concurrent claims. Lowering it
  -- below the current claim count does NOT evict anyone (see the service): the
  -- slot simply refuses new claims until it drains.
  capacity    integer,
  sort_order  smallint    NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE cleanup_slots DROP CONSTRAINT IF EXISTS cleanup_slots_capacity_positive;
ALTER TABLE cleanup_slots ADD  CONSTRAINT cleanup_slots_capacity_positive
  CHECK (capacity IS NULL OR capacity > 0);

-- The ordered read for one event's slot list (also the batched multi-event load).
CREATE INDEX IF NOT EXISTS cleanup_slots_cleanup_idx
  ON cleanup_slots (cleanup_id, sort_order, id);

-- Two slots on the same event may not share a name (case-insensitively): the
-- roster, the attendee list badge and the host's reconcile diff all address a
-- slot by its title in the UI, and two "Grill" rows make every one of those
-- ambiguous. The service rejects duplicates before this fires; this is the
-- backstop for a direct/racing write.
CREATE UNIQUE INDEX IF NOT EXISTS cleanup_slots_cleanup_title_uidx
  ON cleanup_slots (cleanup_id, lower(title));

-- FK target for cleanup_slot_claims' composite reference (see the banner).
CREATE UNIQUE INDEX IF NOT EXISTS cleanup_slots_id_cleanup_uidx
  ON cleanup_slots (id, cleanup_id);

CREATE TABLE IF NOT EXISTS cleanup_slot_claims (
  cleanup_id uuid        NOT NULL REFERENCES cleanups (id) ON DELETE CASCADE,
  user_id    uuid        NOT NULL REFERENCES users (id),
  slot_id    uuid        NOT NULL REFERENCES cleanup_slots (id) ON DELETE CASCADE,
  claimed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (cleanup_id, user_id),
  FOREIGN KEY (slot_id, cleanup_id) REFERENCES cleanup_slots (id, cleanup_id) ON DELETE CASCADE
);

-- "Who is on this slot" (the host's per-slot roster) + the capacity count the
-- claim transaction runs under the slot row lock.
CREATE INDEX IF NOT EXISTS cleanup_slot_claims_slot_idx
  ON cleanup_slot_claims (slot_id);

COMMENT ON TABLE cleanup_slots IS
  'Host-defined named signup roles/shifts on an event (P9). Editable; identity is the uuid, sort_order is presentational.';
COMMENT ON TABLE cleanup_slot_claims IS
  'One row per attendee per event: the single slot they claimed. PK (cleanup_id, user_id) enforces the one-slot-per-person rule in the schema.';
