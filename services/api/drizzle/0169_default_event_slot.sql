-- =============================================================================
-- 0169_default_event_slot.sql
-- -----------------------------------------------------------------------------
-- WHY. Sign-up becomes slot-first: the event page's board of named roles/shifts
-- replaces the single top-level RSVP, so "I am going" is now expressed as "I
-- hold a slot". That only works if EVERY open event has at least one slot to
-- claim. cleanup-service now refuses to create or duplicate an event without
-- one and refuses an update that would empty the board; this file is the other
-- half of that invariant -- the backfill for the events that already exist.
-- Slots arrived in 0063, roughly a third of the way through migration history,
-- and the field stayed optional in the wizard, so a large share of live rows
-- have an empty board. No backfill has ever run before this one.
--
-- WHY ENDED AND CANCELLED EVENTS ARE SKIPPED. An event whose roster has been
-- attested against is frozen: cleanup-service already refuses every slot edit
-- once an event has ended, because credited volunteer hours were certified
-- against exactly that roster and rewriting the board rewrites the record they
-- point at. A backfill is a slot edit like any other, so it honours the same
-- rule. Cancelled events are skipped for the same reason plus the obvious one:
-- nobody is signing up. Both keep an empty board, and the clients keep a
-- slot-less rendering for them.
--
-- LOCK AND SIZE. cleanup_slots and cleanup_slot_claims are cold tables -- not on
-- the hot list in docs/out-of-band-indexes.md -- and the write is bounded by the
-- number of OPEN events (events whose end is still in the future), which is a
-- small, self-limiting slice of `cleanups`. One transaction is fine; the runner
-- owns it (src/db/migrate.ts) and no index is built here.
--
-- UNIQUENESS THE INSERT RESPECTS. 0167 moved slot uniqueness to
-- cleanup_slots_cleanup_title_window_uidx
--   (cleanup_id, lower(title), COALESCE(starts_at,'-infinity'), COALESCE(ends_at,'infinity')).
-- The row written here is untimed, so its key collapses to
-- (cleanup_id, 'general volunteers', '-infinity', 'infinity'), and the NOT
-- EXISTS guard means the event had NO slot at all -- so there is nothing to
-- collide with. cleanup_slot_claims' PRIMARY KEY (cleanup_id, user_id) is the
-- one-slot-per-person rule and is what the ON CONFLICT below names.
--
-- capacity is copied from cleanups.capacity (NULL in essentially every row =
-- unlimited). That column carries no positivity CHECK while
-- cleanup_slots_capacity_positive does, so a legacy 0 or negative is mapped to
-- NULL rather than aborting the deploy.
--
-- ONE STATEMENT, ON PURPOSE. The claims ride a data-modifying CTE off the slot
-- insert's RETURNING, so they attach to the slot THIS migration created and to
-- nothing else -- an event that already had a board (including one whose sole
-- slot a host happened to name "General volunteers") is never touched. It also
-- makes idempotency structural: on a re-run every open event has a slot, the
-- CTE returns no rows and the outer INSERT writes none.
--
-- No DDL, so the Drizzle mirror (src/db/schema/cleanup_slots.ts) is unchanged.
-- Idempotent, forward-only, no transaction control.
-- Ordering: requires 0063_cleanup_slots.sql, 0167_cleanup_slot_windows.sql and
-- 0168_cleanups_ends_at_required.sql (ends_at is NOT NULL by the time this runs).
-- =============================================================================

WITH seeded AS (
  INSERT INTO cleanup_slots (cleanup_id, title, description, capacity, sort_order, starts_at, ends_at)
  SELECT c.id, 'General volunteers', NULL,
         CASE WHEN c.capacity > 0 THEN c.capacity END,
         0, NULL, NULL
  FROM cleanups c
  WHERE c.status <> 'cancelled'
    AND c.ends_at > now()
    AND NOT EXISTS (SELECT 1 FROM cleanup_slots s WHERE s.cleanup_id = c.id)
  RETURNING id, cleanup_id
)
INSERT INTO cleanup_slot_claims (cleanup_id, user_id, slot_id, claimed_at)
SELECT m.cleanup_id, m.user_id, seeded.id, now()
FROM seeded
JOIN cleanup_members m ON m.cleanup_id = seeded.cleanup_id
ON CONFLICT (cleanup_id, user_id) DO NOTHING;
