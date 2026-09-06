-- =============================================================================
-- 0157_delivery_suppression_cancelled.sql
-- -----------------------------------------------------------------------------
-- Adds 'cancelled' to broadcast_deliveries.suppression_reason.
--
-- A host cancelling their own draft/scheduled/sending broadcast suppressed the
-- remaining rows as 'kill_switch', which is the PLATFORM's moderation verdict
-- (admin kill switch / host messaging suspension). Reading a host's own cancel
-- as a moderation action is wrong in the console, in the admin log and in any
-- future abuse report, so the host action gets its own reason.
--
-- Rewrites one CHECK constraint on a table that is empty on every environment
-- at this point in the change set; the drop/add pair takes an ACCESS EXCLUSIVE
-- lock for the duration of one validation scan of zero rows.
--
-- LOCK ORDER: broadcast_deliveries
-- =============================================================================

ALTER TABLE broadcast_deliveries
  DROP CONSTRAINT IF EXISTS broadcast_deliveries_suppression_reason_check;

ALTER TABLE broadcast_deliveries
  ADD CONSTRAINT broadcast_deliveries_suppression_reason_check CHECK (
    suppression_reason IS NULL OR suppression_reason IN (
      'unsubscribed','muted','prefs_off','stop_listed','bounce_suppressed','no_contact',
      'contact_scrubbed','kill_switch','banned','deleted_user','cap','cancelled'));
