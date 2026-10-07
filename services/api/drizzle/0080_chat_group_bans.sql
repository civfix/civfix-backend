-- =============================================================================
-- 0080_chat_group_bans.sql
-- -----------------------------------------------------------------------------
-- FINDING F044: a group owner/admin can remove a member, but nothing records a
-- BAN, so a public group's removed member can immediately re-join (joinGroup) and
-- an invite-only group's removed member can be re-added; there is no persistent
-- "not allowed back" state. Add chat_group_bans: one row per (group, banned user).
-- Chat gates joinGroup on the presence of a ban row. Unban = an owner/admin
-- re-invite via the existing addGroupMembers path, which CLEARS the ban row (so
-- addMembers is intentionally NOT gated on the ban; see the F044 brief); there is
-- no separate unban endpoint.
--
-- PK(group_id, user_id) makes a ban idempotent. Both FKs cascade on the parent's
-- delete (group deletion / hard user delete in test teardown); banned_by is a bare
-- uuid (no FK) mirroring the audit-actor stance elsewhere: the actor trace must
-- outlive an actor row and never block a delete.
--
-- CANONICAL DDL: hand-authored source of truth. Mirror: NEW file
-- schema/chat_group_bans.ts, registered in schema/index.ts.
--
-- Conventions: additive CREATE TABLE IF NOT EXISTS; one transaction per file
-- (src/db/migrate.ts). Forward-only, no down.
--
-- Ordering rules: requires 0047_chat_groups.sql (chat_groups) and 0001_core.sql
-- (users).
-- =============================================================================

CREATE TABLE IF NOT EXISTS chat_group_bans (
  group_id  uuid        NOT NULL REFERENCES chat_groups (id) ON DELETE CASCADE,
  user_id   uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  banned_by uuid,
  banned_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (group_id, user_id)
);

CREATE INDEX IF NOT EXISTS chat_group_bans_user_idx ON chat_group_bans (user_id);
