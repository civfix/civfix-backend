-- =============================================================================
-- 0187_cleanup_team_invites_invited_by_idx.sql
-- -----------------------------------------------------------------------------
-- Account erasure revokes every pending event-team invite the user sent or
-- received:
--
--   UPDATE cleanup_team_invites ... WHERE status = 'pending'
--     AND (invited_user_id = $1 OR invited_by = $1)
--
-- The invited_user_id branch is served by cleanup_team_invites_invitee_pending_idx
-- (0163); the invited_by branch had no index, so the OR fell back to a
-- sequential scan inside the erasure transaction. This partial index lets the
-- planner BitmapOr the two branches (the 0182 twin for organization invites).
--
-- NOT A HOT TABLE: `cleanup_team_invites` is absent from the hot-table list in
-- docs/out-of-band-indexes.md, so this builds inline. If it has grown large by
-- the time this deploys, build it with CREATE INDEX CONCURRENTLY first and the
-- IF NOT EXISTS guard turns this into a no-op.
--
-- CANONICAL DDL: hand-authored source of truth. Mirror: schema/cleanup_team_invites.ts.
--
-- Conventions: one concern per file; one transaction per file. Forward-only,
-- no down.
--
-- Ordering rules: requires 0109_cleanup_team_invites.sql.
-- =============================================================================

CREATE INDEX IF NOT EXISTS cleanup_team_invites_inviter_pending_idx
  ON cleanup_team_invites (invited_by)
  WHERE status = 'pending';
