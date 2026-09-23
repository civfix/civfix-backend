-- =============================================================================
-- 0182_organization_invites_invited_by_idx.sql
-- -----------------------------------------------------------------------------
-- Account erasure (PgUserStore.softDeleteAndAnonymize) revokes every pending
-- organization invite the user sent or received:
--
--   UPDATE organization_invites ... WHERE status = 'pending'
--     AND (invited_by = $1 OR user_id = $1)
--
-- The user_id branch is served by organization_invites_invitee_pending_idx
-- (0165); the invited_by branch had no index, so the OR fell back to a
-- sequential scan inside the erasure transaction. This partial index lets the
-- planner BitmapOr the two branches.
--
-- NOT A HOT TABLE: organization_invites is absent from the hot-table list in
-- docs/out-of-band-indexes.md, so this builds inline. If the table has grown
-- large by the time this deploys, build it with CREATE INDEX CONCURRENTLY first
-- and the IF NOT EXISTS guard turns this into a no-op.
--
-- CANONICAL DDL: hand-authored source of truth. Mirror:
-- schema/organization_invites.ts.
--
-- Conventions: one concern per file; one transaction per file. Forward-only,
-- no down.
--
-- Ordering rules: requires 0162_org_suspension_and_invites.sql.
-- =============================================================================

CREATE INDEX IF NOT EXISTS organization_invites_inviter_pending_idx
  ON organization_invites (invited_by)
  WHERE status = 'pending';
