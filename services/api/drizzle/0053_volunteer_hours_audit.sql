-- =============================================================================
-- 0053_volunteer_hours_audit.sql
-- -----------------------------------------------------------------------------
-- SECURITY (audit 2026-07-24, M21): event volunteer hours were overwritten in
-- place with no history.
--
-- logEventHours upserts on the (cleanup_id, user_id) WHERE source='event' partial
-- unique index with `DO UPDATE SET hours = EXCLUDED.hours`, so the previous value
-- was destroyed on every re-log. The only trace of who did it was
-- volunteer_hours.logged_by_user_id, which is likewise overwritten, meaning a
-- host could inflate a credit, and later quietly restore it, leaving the row
-- indistinguishable from one that had never been touched. Hours feed the public
-- jurisdiction leaderboard, so this is a falsifiable public record.
--
-- volunteer_hours_audit is an append-only journal: one row per credited attendee
-- per upsert, carrying the value BEFORE and AFTER, the acting host, and the time.
-- Never updated, never deleted by application code.
--
-- Not a FK to volunteer_hours(id): the audit must outlive the row it describes
-- (and the upsert's RETURNING does not expose the pre-image id in the geoid-less
-- branch). (cleanup_id, user_id) is the stable natural key, matching the partial
-- unique index the upsert itself conflicts on.
--
-- CANONICAL DDL: this hand-authored SQL is the source of truth. The Drizzle mirror
-- lives alongside the other hours tables in src/db/schema/volunteer-hours.ts.
--
-- Conventions (match the rest of the suite): timestamptz, additive
-- IF NOT EXISTS so a partial or repeat apply is safe; the migrate runner
-- (src/db/migrate.ts) records applied files and wraps each file in one
-- transaction. Forward-only: there is no down migration in this suite.
--
-- Ordering rules: requires 0001_core.sql (users, cleanups) and
-- 0035_volunteer_hours.sql (volunteer_hours + its partial unique indexes).
-- =============================================================================

CREATE TABLE IF NOT EXISTS volunteer_hours_audit (
  id                uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  cleanup_id        uuid          NOT NULL REFERENCES cleanups (id) ON DELETE CASCADE,
  -- The attendee whose credit changed.
  user_id           uuid          NOT NULL REFERENCES users (id),
  -- The host who made the change (organizer or cohost). NOT NULL: every write on
  -- this path has an authenticated actor, and an audit row with no actor is
  -- worthless.
  actor_user_id     uuid          NOT NULL REFERENCES users (id),
  -- The credit BEFORE this upsert; NULL means there was no prior credit (first
  -- time this attendee was logged for this event), distinct from a stored 0.
  previous_hours    numeric(6, 2),
  -- The credit AFTER this upsert.
  new_hours         numeric(6, 2) NOT NULL,
  created_at        timestamptz   NOT NULL DEFAULT now()
);

-- "Show me the full history of this event's hours" (the moderation/dispute view).
CREATE INDEX IF NOT EXISTS volunteer_hours_audit_cleanup_idx
  ON volunteer_hours_audit (cleanup_id, created_at DESC);

-- "Show me everything this host has ever credited" (the abuse-pattern view).
CREATE INDEX IF NOT EXISTS volunteer_hours_audit_actor_idx
  ON volunteer_hours_audit (actor_user_id, created_at DESC);

COMMENT ON TABLE volunteer_hours_audit IS
  'Append-only journal of every event volunteer-hours upsert: previous value, new value, acting host, timestamp. Written in the same transaction as the volunteer_hours upsert. Never updated or deleted by application code.';
