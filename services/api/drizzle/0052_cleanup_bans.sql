-- =============================================================================
-- 0052_cleanup_bans.sql
-- -----------------------------------------------------------------------------
-- SECURITY (audit 2026-07-24, M17): removing an event attendee was unenforceable.
--
-- removeMember only DELETEd the cleanup_members row and joinCleanupTx was an
-- unconditional self-service INSERT, so the removed user simply re-joined (in a
-- loop, instantly, with no cooldown) and walked straight back into the event
-- group chat (cleanup_members is what gates chat access). There was no ban record
-- of any kind anywhere in the schema.
--
-- cleanup_bans is that record: one row per (event, banned user). removeMember
-- writes it in the SAME transaction as the membership delete, and joinCleanupTx
-- refuses to insert a membership row while it exists. The organizer lifts a ban
-- through the existing member-role endpoint (see cleanup-service.setMemberRole).
--
-- Deliberately NOT a soft-delete/status column on cleanup_members: a ban must
-- survive the membership row's deletion (that deletion IS the removal), and the
-- composite PK gives the join path an index-only existence probe.
--
-- CANONICAL DDL: this hand-authored SQL is the source of truth. The Drizzle mirror
-- under src/db/schema/cleanup_bans.ts is for typed queries / diff inspection only.
--
-- Conventions (match the rest of the suite): timestamptz, additive
-- IF NOT EXISTS so a partial or repeat apply is safe; the migrate runner
-- (src/db/migrate.ts) records applied files and wraps each file in one
-- transaction. Forward-only: there is no down migration in this suite.
--
-- Ordering rules: requires 0001_core.sql (users, cleanups, cleanup_members).
-- =============================================================================

CREATE TABLE IF NOT EXISTS cleanup_bans (
  cleanup_id        uuid        NOT NULL REFERENCES cleanups (id) ON DELETE CASCADE,
  user_id           uuid        NOT NULL REFERENCES users (id),
  -- The host (organizer or cohost) who removed them. Nullable so a future
  -- operator/moderation-initiated removal can leave it NULL rather than fabricate
  -- an actor; the users FK does NOT cascade (bans survive actor soft-delete, the
  -- same convention cleanup_members uses).
  banned_by_user_id uuid        REFERENCES users (id),
  -- Free-text host note. Unused by the current remove flow (which carries no
  -- reason field on the wire) but present so adding one needs no migration.
  reason            text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (cleanup_id, user_id)
);

-- "Which events is this user banned from": the reverse lookup, for a future
-- moderation view. The join-path probe rides the composite PK.
CREATE INDEX IF NOT EXISTS cleanup_bans_user_idx ON cleanup_bans (user_id);

COMMENT ON TABLE cleanup_bans IS
  'One row per (event, removed user). Written by cleanup removeMember in the same transaction as the cleanup_members delete; checked by joinCleanupTx, which refuses to re-create a membership row while a ban exists. Cleared by the organizer via the member-role endpoint.';
