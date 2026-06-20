-- =============================================================================
-- 0026_user_handle_required.sql
-- -----------------------------------------------------------------------------
-- Make `users.handle` effectively always-present and add the @handle rename
-- cooldown clock. The @handle is the user-facing identifier; the UUID `id`
-- stays a HIDDEN internal key (cache/follow/DM), never rendered, never in a URL.
--
-- Three additive, idempotent steps:
--   1) BACKFILL every NULL handle with a generated unique placeholder derived
--      from the row's id ('user' + first 12 hex chars of the UUID, lowercased).
--      This is unique because `id` is unique, and matches HANDLE_REGEX
--      (^[A-Za-z0-9_]{3,20}$ -> 16 chars, all [a-z0-9]). After this no NULL
--      handle remains, so SET NOT NULL succeeds.
--   2) ADD COLUMN handle_changed_at timestamptz NULL - the rolling-30-day rename
--      cooldown clock. NULL = never renamed (changeable now). The handle chosen
--      DURING first-run registration (profile_complete still false) does NOT
--      stamp this; only a rename made AFTER profile_complete = true does. The
--      application (PgUserStore.updateProfile) owns that policy.
--   3) Enforce the column is NOT NULL and a CHECK constraint validating the
--      format for the (now always-present) handle.
--
-- Note 0025 is taken by 0025_chat_message_media.sql; this lands at 0026 so the
-- lexical-ordered runner applies it after every dependency.
--
-- CANONICAL DDL: this hand-authored SQL is the source of truth. The Drizzle
-- definition in src/db/schema/users.ts mirrors it (handle .notNull() +
-- handleChangedAt) for typed queries.
--
-- Ordering rules:
--   * Requires 0000_extensions.sql (citext for the handle column) already applied.
--   * Requires 0001_core.sql (users + users_handle_key) already applied.
--   * Statements are idempotent (UPDATE ... WHERE handle IS NULL is a no-op on a
--     re-apply; ADD COLUMN IF NOT EXISTS; the NOT NULL + CHECK steps are guarded
--     by DO $$ blocks so a repeat apply does not error). The migrate runner also
--     records applied files in _civfix_migrations and wraps each file in one
--     transaction.
-- =============================================================================

-- 1) Backfill NULL handles with a deterministic, unique placeholder derived from id.
--    'user' + first 12 hex chars of the dashless UUID => 16 chars, all [a-z0-9],
--    inside HANDLE_REGEX (3-20). Unique because id is unique. No-op on re-apply.
UPDATE users
SET handle = 'user' || substr(replace(id::text, '-', ''), 1, 12)
WHERE handle IS NULL;

-- 2) The rename cooldown clock. NULL = never renamed (changeable now).
ALTER TABLE users ADD COLUMN IF NOT EXISTS handle_changed_at timestamptz;

-- 3a) Now that every row has a handle, make the column NOT NULL. Guarded so a
--     repeat apply (column already NOT NULL) does not error.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'users' AND column_name = 'handle' AND is_nullable = 'YES'
  ) THEN
    ALTER TABLE users ALTER COLUMN handle SET NOT NULL;
  END IF;
END $$;

-- 3b) Format CHECK for the (now always-present) handle. Idempotent: only added
--     when the constraint does not already exist.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'users_handle_format_chk'
  ) THEN
    ALTER TABLE users
      ADD CONSTRAINT users_handle_format_chk
      CHECK (handle ~ '^[A-Za-z0-9_]{3,20}$');
  END IF;
END $$;

-- The existing users_handle_key unique index (0001_core.sql) is left untouched.
