-- =============================================================================
-- 0189_mail_events_bounced_recipient_idx.sql
-- -----------------------------------------------------------------------------
-- A legacy jurisdiction contact email is unusable once a bounce for it was
-- recorded after the contact last changed (admin/sql-fragments.ts
-- legacyContactEmailUsable):
--
--   me.type = 'bounced' AND lower(me.meta->>'failedRecipient') = lower($email)
--
-- It runs per legacy email on every jurisdiction health load (including the
-- public resolve-for-point path), in outreach and in discovery. The only path
-- was mail_threads_geoid_idx -> mail_events_thread_idx, which reads every event
-- of every thread of the jurisdiction. This partial expression index makes it
-- one probe for that address's bounces, then a PK join to mail_threads for the
-- geoid. The recipient already lives in the row, so no new privacy surface.
--
-- NOT A HOT TABLE: `mail_events` is absent from the hot-table list in
-- docs/out-of-band-indexes.md, so this builds inline. If it has grown large by
-- the time this deploys, build it with CREATE INDEX CONCURRENTLY first and the
-- IF NOT EXISTS guard turns this into a no-op.
--
-- CANONICAL DDL: hand-authored source of truth. Mirror: schema/mail.ts.
--
-- Conventions: one concern per file; one transaction per file. Forward-only,
-- no down.
--
-- Ordering rules: requires 0007_admin_phase2.sql (mail_events).
-- =============================================================================

CREATE INDEX IF NOT EXISTS mail_events_bounced_recipient_idx
  ON mail_events ((lower(meta ->> 'failedRecipient')))
  WHERE type = 'bounced';
