-- =============================================================================
-- 0029_mail_event_failed.sql
-- -----------------------------------------------------------------------------
-- Widen mail_events.type to allow 'failed' (a send the mailer rejected, recorded
-- for the outreach trail so the admin Mail surface and deliverability stats see a
-- failed jurisdiction/event send instead of a silently lost message).
--
-- The original CHECK (0007_admin_phase2.sql) allowed only sent/delivered/bounced/
-- complained/opened. Drop-and-re-add the named constraint idempotently so a partial
-- or repeat apply is safe (the runner wraps each file in one transaction).
--
-- The constraint name `mail_events_type_check` is Postgres's default for the inline
-- `type text NOT NULL CHECK (...)` column constraint on `mail_events`.
-- -----------------------------------------------------------------------------
ALTER TABLE mail_events
  DROP CONSTRAINT IF EXISTS mail_events_type_check;

ALTER TABLE mail_events
  ADD CONSTRAINT mail_events_type_check
  CHECK (type IN ('sent', 'delivered', 'bounced', 'complained', 'opened', 'failed'));
