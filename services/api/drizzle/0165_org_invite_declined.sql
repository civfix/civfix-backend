-- =============================================================================
-- 0165_org_invite_declined.sql
-- -----------------------------------------------------------------------------
-- Organization invite inbox (@civfix/shared 0.43.0, DECISIONS §34).
--
-- 1. organization_invites.status gains 'declined'
--    The invitee can now see and answer an org invite in the app
--    (GET /me/org-invites, POST /me/org-invites/:inviteId/{accept,decline}),
--    exactly as event-team invites work since 0163. Terminal and distinct from
--    'revoked': 'revoked' is the org withdrawing the offer, 'declined' is the
--    invitee refusing it. Declining blocklists nobody - the row simply stops
--    being 'pending', so organization_invites_pending_email_uidx lets the org
--    invite that address again.
--
--    0162 wrote the value set as an inline CHECK, so widening it is a named
--    DROP/ADD pair (the 0163 precedent) and NOT an app-side-only enum change:
--    the column already carries DDL enforcement and losing it would be a
--    regression.
--
-- 2. organization_invites_invitee_pending_idx
--    Backs GET /me/org-invites, which lists one person's open invites newest
--    first: (user_id, created_at DESC, id DESC) partial on status = 'pending'
--    AND user_id IS NOT NULL. Built in-transaction WITHOUT CONCURRENTLY on
--    purpose - organization_invites is a small, cold table (an invite per seat,
--    capped per org, expiring on a clock) and is on no hot write path, so the
--    build lock is measured in milliseconds. The hot-table rule (users,
--    reports, chat_messages, dm_messages, media_assets, notifications,
--    sessions) does not reach it.
--
--    The by-email half of the same read is served by
--    organization_invites_pending_email_uidx, which is already keyed on
--    (organization_id, email) partial on pending; the inbox reads it with an
--    email equality and a small bounded limit.
--
-- The paired notification type 'org_invite' (replacing the generic 'system'
-- type the org invite notifications used) needs NO DDL: notifications.type has
-- no DB CHECK by convention - it is enforced app-side by the shared
-- NotificationTypeSchema, mirrored by NOTIFICATION_TYPE_VALUES in
-- schema/types.ts and drift-guarded by test/unit/enums.test.ts.
--
-- EXPAND-ONLY (docs/migrations-expand-contract.md). The CHECK swap WIDENS the
-- accepted set, so the validating ADD CONSTRAINT cannot fail: every row the
-- previous image ever wrote is in the old, narrower set, and that set is a
-- strict subset of the new one. The previous image keeps serving unchanged - it
-- simply never writes 'declined'. Same shape as 0163.
--
-- CANONICAL DDL: hand-authored source of truth. Mirror:
-- schema/organization_invites.ts (+ schema/types-host.ts value tuples).
--
-- Conventions: DROP CONSTRAINT IF EXISTS / ADD CONSTRAINT pair, CREATE INDEX
-- IF NOT EXISTS; one concern per file; one transaction per file. Forward-only,
-- no down.
--
-- LOCK ORDER (binding on every writer): organizations -> organization_members
--   -> organization_invites -> cleanups -> cleanup_members -> ...
--
-- Ordering rules: requires 0162_org_suspension_and_invites.sql (the table).
-- =============================================================================

ALTER TABLE organization_invites
  DROP CONSTRAINT IF EXISTS organization_invites_status_check;
ALTER TABLE organization_invites
  ADD CONSTRAINT organization_invites_status_check
  CHECK (status IN ('pending', 'accepted', 'revoked', 'expired', 'declined'));

CREATE INDEX IF NOT EXISTS organization_invites_invitee_pending_idx
  ON organization_invites (user_id, created_at DESC, id DESC)
  WHERE status = 'pending' AND user_id IS NOT NULL;

COMMENT ON COLUMN organization_invites.status IS
  'pending | accepted | revoked | expired | declined. revoked = the organization withdrew the offer; declined = the invitee refused it; expired = the clock. accepted, revoked, expired and declined are all terminal, and none of them blocklists a re-invite.';
