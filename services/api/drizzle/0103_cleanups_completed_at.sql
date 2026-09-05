-- =============================================================================
-- 0103_cleanups_completed_at.sql
-- -----------------------------------------------------------------------------
-- AUDIT H9: volunteer hours are host-supplied with no server-side signal bounding
-- them. The only anti-inflation control was "another host must credit you", which
-- two co-hosting verified accounts satisfy for each other, so an A<->B pair could
-- mint 24 h each, repeatedly, straight into a signed service-hours transcript.
--
-- The first bound needs a fact the schema did not record: how long the event
-- actually ran. `status = 'done'` says an event finished; nothing said WHEN. This
-- column records the completion instant, so credited hours can be capped at the
-- event's own window (completed_at - scheduled_at, plus one hour of grace, and
-- never more than MAX_EVENT_HOURS) instead of at a flat client-supplied 24 h.
--
-- NOT a hot table: `cleanups` is one row per community event (thousands, not
-- millions), and the column is NULLABLE with NO DEFAULT, so this is a
-- catalog-only ADD COLUMN - no rewrite, no backfill, brief lock only.
--
-- NO BACKFILL, on purpose: events completed before this migration have no
-- recorded completion instant, and inventing one would fabricate a fact that ends
-- up printed on a government-facing document. Those rows keep the previous
-- ceiling (MAX_EVENT_HOURS), and the minimum-duration rule likewise only applies
-- to events whose completion instant is known - both documented in
-- volunteer-hours-service.ts.
--
-- Paired code change: completeCleanupTx stamps completed_at = now() in the same
-- transaction as `status = 'done'`, and refuses to complete an event earlier than
-- scheduled_at + MIN_EVENT_DURATION_MS (15 minutes), so every NEW completion has
-- a window of at least that length.
--
-- CANONICAL DDL: hand-authored source of truth. Mirror: schema/cleanups.ts.
--
-- Conventions: additive ADD COLUMN IF NOT EXISTS; one concern per file; one
-- transaction per file. Forward-only, no down.
--
-- Ordering rules: requires 0001_core.sql (cleanups).
-- =============================================================================

ALTER TABLE cleanups ADD COLUMN IF NOT EXISTS completed_at timestamptz;

COMMENT ON COLUMN cleanups.completed_at IS
  'When the event was marked done (stamped by completeCleanupTx alongside status). NULL for events that are not done and for events completed before 0103. completed_at - scheduled_at is the window that bounds creditable volunteer hours.';
