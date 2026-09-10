-- =============================================================================
-- 0163_event_team_tiers.sql
-- -----------------------------------------------------------------------------
-- Event collaborators (@civfix/shared 0.42.0, DECISIONS §33).
--
-- 1. cleanup_team_invites.role gains 'coordinator'
--    The third invitable tier: runs the day (roster, answers, analytics,
--    check-in, broadcast, chat moderation) and changes nothing (no
--    view_guest_contact, no export, no manage_*). 0109 wrote the value set as
--    an inline CHECK, so widening it is a named DROP/ADD pair - the 0024
--    precedent - and NOT an app-side-only enum change: the column already
--    carries DDL enforcement and losing it would be a regression.
--
-- 2. cleanup_team_invites.status gains 'declined'
--    Terminal and distinct from 'revoked': 'revoked' is the host withdrawing
--    the offer, 'declined' is the invitee refusing it. Declining does not
--    blocklist anyone - the row simply stops being 'pending', so the partial
--    unique indexes let the host invite again.
--
-- 3. cleanup_team_invites_invitee_pending_idx
--    Backs GET /me/event-invites, which is keyset-paginated over one person's
--    open invites: (invited_user_id, created_at DESC, id DESC) partial on
--    status = 'pending' AND invited_user_id IS NOT NULL. Built in-transaction
--    WITHOUT CONCURRENTLY on purpose: cleanup_team_invites is a small,
--    recently-added, cold table (an invite per team seat, capped at
--    MAX_TEAM_INVITES_PER_EVENT = 50 open per event) and is on no hot write
--    path, so the build lock is measured in milliseconds. The hot-table rule
--    (reports, chat_messages, media_assets, users, notifications, mail_*) does
--    not reach it.
--
-- 4. cleanup_members.role comment
--    0049 recorded the value set on the column itself; 'staff' (0109) and now
--    'coordinator' widen it. Enforcement stays app-side (the shared
--    CleanupMemberRoleSchema, mirrored by CLEANUP_MEMBER_ROLE_VALUES and
--    drift-guarded by test/unit/enums.test.ts): cleanup_members.role has no
--    DB CHECK by convention and this migration does not add one.
--
-- EXPAND-ONLY (docs/migrations-expand-contract.md). Both CHECK swaps WIDEN the
-- accepted set, so the validating ADD CONSTRAINT cannot fail: every row the
-- previous image ever wrote is in the old, narrower set, and that set is a strict
-- subset of the new one. The previous image keeps serving unchanged - it simply
-- never writes 'coordinator' or 'declined'. Same shape as 0024 and 0160.
--
-- CANONICAL DDL: hand-authored source of truth. Mirror:
-- schema/cleanup_team_invites.ts (+ schema/types-host.ts value tuples).
--
-- Conventions: DROP CONSTRAINT IF EXISTS / ADD CONSTRAINT pairs, CREATE INDEX
-- IF NOT EXISTS; one concern per file; COMMENT ON is a plain overwrite. The
-- whole file is one transaction and re-applying it is a no-op. Forward-only,
-- no down.
--
-- LOCK ORDER (binding on every writer): organizations -> organization_members
--   -> organization_invites -> cleanups -> cleanup_members -> ...
--
-- Ordering rules: requires 0049_cleanup_cohosts.sql (the role comment) and
-- 0109_cleanup_team_invites.sql (the table).
-- =============================================================================

ALTER TABLE cleanup_team_invites
  DROP CONSTRAINT IF EXISTS cleanup_team_invites_role_check;
ALTER TABLE cleanup_team_invites
  ADD CONSTRAINT cleanup_team_invites_role_check
  CHECK (role IN ('cohost', 'staff', 'coordinator'));

ALTER TABLE cleanup_team_invites
  DROP CONSTRAINT IF EXISTS cleanup_team_invites_status_check;
ALTER TABLE cleanup_team_invites
  ADD CONSTRAINT cleanup_team_invites_status_check
  CHECK (status IN ('pending', 'accepted', 'revoked', 'expired', 'declined'));

CREATE INDEX IF NOT EXISTS cleanup_team_invites_invitee_pending_idx
  ON cleanup_team_invites (invited_user_id, created_at DESC, id DESC)
  WHERE status = 'pending' AND invited_user_id IS NOT NULL;

COMMENT ON COLUMN cleanup_team_invites.role IS
  'cohost | staff | coordinator - the invitable subset of cleanup_members.role (organizer is never invitable). coordinator runs the day and changes nothing: no guest contact, no export, no manage_*.';
COMMENT ON COLUMN cleanup_team_invites.status IS
  'pending | accepted | revoked | expired | declined. revoked = the host withdrew the offer; declined = the invitee refused it; expired = the clock. accepted, revoked, expired and declined are all terminal, and none of them blocklists a re-invite.';

COMMENT ON COLUMN cleanup_members.role IS
  'organizer | cohost | coordinator | staff | member — enforced app-side by the shared CleanupMemberRoleSchema (mirrored in src/db/schema/types-host.ts CLEANUP_MEMBER_ROLE_VALUES; no DB CHECK by convention). organizer = the immutable creator; cohost = everything the organizer can do except disband the team, cancel, relink the org or request resources; coordinator = runs the day (roster, answers, analytics, check-in, broadcast, chat moderation) and changes nothing; staff = roster + check-in on the day; member = plain attendee.';
