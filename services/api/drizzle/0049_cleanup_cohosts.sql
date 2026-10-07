-- =============================================================================
-- 0049_cleanup_cohosts.sql
-- -----------------------------------------------------------------------------
-- Event co-hosts (WS4): cleanup_members.role gains a third value, 'cohost',
-- between 'organizer' (the immutable creator) and 'member' (a plain attendee).
--
-- VERIFIED before writing this migration: cleanup_members.role (0001_core.sql)
-- is a bare `text NOT NULL` with NO CHECK constraint; the codebase convention
-- (see the 0033 note: "kept flexible like `role`") is that role-ish columns are
-- enforced by the shared Zod enum + the CLEANUP_MEMBER_ROLE_VALUES mirror in
-- src/db/schema/types.ts (drift-guarded by test/unit/enums.test.ts), not by DDL.
-- So there is no CHECK to drop/re-add; the enum extension is app-side. This
-- migration records the widened value set on the column itself so the DDL story
-- stays self-describing.
--
-- Volunteer hours (WS5): also VERIFIED that no DDL change is needed; the 0035
-- partial unique index volunteer_hours_event_uidx ON (cleanup_id, user_id)
-- WHERE source = 'event' already supports the per-attendee upsert
-- (ON CONFLICT (cleanup_id, user_id) WHERE source = 'event' DO UPDATE), which
-- now runs with per-row hours instead of one flat value.
--
-- Idempotent: COMMENT ON is a plain overwrite, so re-applying is a no-op.
-- =============================================================================

COMMENT ON COLUMN cleanup_members.role IS
  'organizer | cohost | member — enforced app-side by the shared CleanupMemberRoleSchema (mirrored in src/db/schema/types.ts CLEANUP_MEMBER_ROLE_VALUES; no DB CHECK by convention). organizer = the immutable creator; cohost = organizer-promoted co-host (can edit the event, remove plain members, log hours when verified); member = plain attendee.';
