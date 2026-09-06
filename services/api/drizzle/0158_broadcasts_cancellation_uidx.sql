-- =============================================================================
-- 0158_broadcasts_cancellation_uidx.sql
-- -----------------------------------------------------------------------------
-- One cancellation announcement per event, enforced by the database.
--
-- The cancel fan-out job deliberately rethrows when an SMS guest could not be
-- reached (a guest who never learns the event is cancelled turns up to nothing),
-- so pg-boss redelivers the whole job -- and the event_cancelled lane ran again
-- and created a SECOND broadcast, mailing every registrant the cancellation
-- twice. Reminders already had this guard
-- (broadcasts_reminder_uidx); cancellations get the matching one, and the lane
-- inserts with ON CONFLICT DO NOTHING so the retry is a no-op instead of a
-- duplicate.
--
-- broadcasts is empty on every environment at this point in the change set, so
-- the plain (non-CONCURRENTLY) CREATE INDEX is a zero-row build inside the
-- migration's own transaction.
--
-- LOCK ORDER: broadcasts
-- =============================================================================

CREATE UNIQUE INDEX IF NOT EXISTS broadcasts_cancellation_uidx
  ON broadcasts (cleanup_id)
  WHERE kind = 'event_cancelled';
