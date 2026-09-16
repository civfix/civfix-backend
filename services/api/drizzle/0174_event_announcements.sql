-- =============================================================================
-- 0174_event_announcements.sql
-- -----------------------------------------------------------------------------
-- Event announcements ride the existing host-broadcast pipeline as a new
-- broadcasts.kind rather than a parallel table: segment resolution, delivery
-- fan-out, suppression, unsubscribes and counting already exist and are tested.
--
-- Three concerns, all on `broadcasts`:
--
--   1. kind CHECK widening. `broadcasts_kind_check` (0130) enumerates the seven
--      kinds that existed then; 'announcement' has to join them or every insert
--      fails. Dropped and recreated because a CHECK cannot be widened in place.
--
--   2. Public listing index. listEventAnnouncements reads an event's sent
--      announcements newest-first with a keyset cursor. The existing
--      broadcasts_cleanup_created_idx has the right ordering but spans every
--      kind, so an event whose hosts also send reminders/confirmations scans
--      rows the announcements list can never return. This partial twin is
--      keyed the same way and carries only announcement rows.
--
--   3. Scrub exemption. The retention lane
--      (broadcast-repository.scrubBroadcastContent) NULLs subject/body_md on
--      finished broadcasts past the cutoff -- correct for a one-shot email,
--      wrong for an announcement, which is permanent PUBLIC event content
--      rendered on the event page forever. The scrub's driving index gets the
--      matching `kind <> 'announcement'` predicate so exempt rows are not even
--      candidates, and the repository query carries the same predicate.
--
-- NOT A HOT TABLE: `broadcasts` is absent from the hot-table list in
-- docs/out-of-band-indexes.md, so these build inline. IF NOT EXISTS keeps the
-- file a no-op if an index was built out of band with CONCURRENTLY first.
--
-- CANONICAL DDL: hand-authored source of truth. Mirror: schema/broadcasts.ts.
-- Enum mirrors: schema/types-broadcast.ts (BROADCAST_KIND_VALUES) and shared
-- BroadcastKindSchema -- 'announcement' is APPENDED LAST in all three.
--
-- Conventions: one concern per file; one transaction per file. Forward-only,
-- no down.
--
-- Ordering rules: requires 0130_broadcasts.sql.
-- LOCK ORDER: broadcasts
-- =============================================================================

ALTER TABLE broadcasts DROP CONSTRAINT IF EXISTS broadcasts_kind_check;

ALTER TABLE broadcasts ADD CONSTRAINT broadcasts_kind_check CHECK (kind IN (
  'host_broadcast','confirmation','waitlist_promoted','reminder',
  'event_updated','event_cancelled','thank_you','announcement'));

CREATE INDEX IF NOT EXISTS broadcasts_announcement_public_idx
  ON broadcasts (cleanup_id, created_at DESC, id DESC)
  WHERE kind = 'announcement';

DROP INDEX IF EXISTS broadcasts_scrub_idx;

CREATE INDEX IF NOT EXISTS broadcasts_scrub_idx
  ON broadcasts (finished_at)
  WHERE content_scrubbed_at IS NULL AND body_md IS NOT NULL AND kind <> 'announcement';
