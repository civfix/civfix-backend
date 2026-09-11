-- =============================================================================
-- 0165_org_affiliation.sql
-- -----------------------------------------------------------------------------
-- Organization affiliation (@civfix/shared 0.43.0, DECISIONS §34).
--
-- 1. users.primary_organization_id
--    Which of a person's organization memberships shows as the badge next to
--    their name. NULL means "pick automatically" (the earliest membership by
--    joined_at), so the column is a PREFERENCE, never the affiliation itself:
--    membership lives in organization_members and stays the only grant of any
--    capability. ON DELETE SET NULL matches cleanups.organization_id.
--
--    The FK is added NOT VALID: users is a hot table and a validating
--    ADD CONSTRAINT scans it inside the deploy transaction. Every row the
--    previous image wrote has NULL here (the column is created by this file),
--    so the constraint holds by construction from the instant it exists and
--    every INSERT/UPDATE is checked from now on.
--
--    STILL OUTSTANDING (a later release, out of band, SHARE UPDATE EXCLUSIVE):
--      ALTER TABLE users VALIDATE CONSTRAINT users_primary_organization_fk;
--
--    No index on the column. The only reader is "SELECT ... FROM users WHERE
--    id = ANY($1)" (affiliation.ts), served by the PK, and the only writer is
--    an UPDATE by PK. The FK's SET NULL sweep would want one, but
--    organizations are never hard-deleted by the application (suspension and
--    deleted_at are both flags; the sole DELETE FROM organizations in the tree
--    is a test), so that path is not taken in production and a hot-table index
--    on users is not worth its build.
--
-- 2. posts.organization_id
--    "Post as <org>": the acting account stays posts.author_id (deletion,
--    moderation and rate limits keep following the human), and this column
--    records the organization the post is published under. Any-role membership
--    of a non-suspended, non-deleted org is the write gate, enforced in
--    post-service.ts; the column carries no DB CHECK because membership is not
--    expressible as one.
--
--    posts is not on the hot list (docs/out-of-band-indexes.md: users, reports,
--    chat_messages, dm_messages, media_assets, notifications, sessions), so its
--    index is built inline like every other posts index. It is partial on the
--    same predicate every read path carries, which also keeps it to the small
--    org-authored subset rather than one entry per post:
--    (organization_id, created_at DESC) WHERE organization_id IS NOT NULL AND
--    deleted_at IS NULL. It backs an organization's post listing and the FK's
--    SET NULL sweep.
--
-- EXPAND-ONLY (docs/migrations-expand-contract.md): two nullable ADD COLUMNs
-- with no default, which are catalog-only in PG11+ (no table rewrite), plus one
-- partial index on a cold-ish table and one NOT VALID constraint. The previous
-- image keeps serving unchanged - it simply never writes either column.
--
-- CANONICAL DDL: hand-authored source of truth. Mirror: schema/users.ts,
-- schema/posts.ts.
--
-- Conventions: ADD COLUMN IF NOT EXISTS, guarded ADD CONSTRAINT, CREATE INDEX
-- IF NOT EXISTS; one concern per file (affiliation, both halves of it); one
-- transaction per file. Forward-only, no down.
--
-- LOCK ORDER (binding on every writer): organizations -> organization_members
--   -> organization_invites -> cleanups -> cleanup_members -> ...
--
-- Ordering rules: requires 0001_core.sql (users), 0051_social_posts.sql (posts)
-- and 0105_organizations.sql (organizations).
-- =============================================================================

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS primary_organization_id uuid;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'users_primary_organization_fk' AND conrelid = 'users'::regclass
  ) THEN
    ALTER TABLE users
      ADD CONSTRAINT users_primary_organization_fk
      FOREIGN KEY (primary_organization_id) REFERENCES organizations(id) ON DELETE SET NULL
      NOT VALID;
  END IF;
END $$;

COMMENT ON COLUMN users.primary_organization_id IS
  'Which organization membership shows as this person''s affiliation badge. NULL = choose automatically (earliest organization_members.joined_at). A preference only: it grants nothing, and it is cleared in the same transaction that removes the matching membership.';

ALTER TABLE posts
  ADD COLUMN IF NOT EXISTS organization_id uuid REFERENCES organizations(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS posts_organization_created_idx
  ON posts (organization_id, created_at DESC)
  WHERE organization_id IS NOT NULL AND deleted_at IS NULL;

COMMENT ON COLUMN posts.organization_id IS
  'The organization this post is published under ("post as org"). NULL = a personal post. author_id remains the acting human for deletion, moderation and rate limits; the writer must hold any organization_members role on a non-suspended, non-deleted org (enforced app-side in post-service.ts). Never set on kind = ''repost''.';
