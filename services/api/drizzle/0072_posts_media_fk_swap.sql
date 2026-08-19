-- =============================================================================
-- 0072_posts_media_fk_swap.sql
-- -----------------------------------------------------------------------------
-- FINDING F148: the posts self-FKs and the media_assets→posts FK were all created
-- ON DELETE CASCADE (0051). With unrepost/unpost now modeled as a SOFT delete
-- (deleted_at, see 0069), a hard `DELETE FROM posts` is exceptional, but CASCADE
-- makes any such delete silently mass-delete replies, quotes, reposts and their
-- media. Swap the delete actions to the correct semantics:
--   * posts.reply_to_id  → ON DELETE RESTRICT (never orphan/mass-delete a thread;
--     RESTRICT also avoids the SET NULL variant that would promote an orphaned
--     reply into the reply-excluding public feed).
--   * posts.thread_root_id → ON DELETE RESTRICT (same reasoning).
--   * posts.repost_of_id → ON DELETE RESTRICT (unrepost is a tombstone, not a
--     cascade; the target must not vanish reposts out from under counts).
--   * media_assets.post_id → ON DELETE SET NULL (a hard-deleted post should
--     detach its media, not delete the asset row the reaper/audit still tracks).
--
-- CONSTRAINT NAMES ARE DISCOVERED, NOT HARDCODED. 0051 created these FKs WITHOUT
-- an explicit CONSTRAINT name, so Postgres auto-generated the names. Rather than
-- trust the default naming, each swap below looks the existing FK up dynamically
-- in pg_constraint (by conrelid, confrelid, contype='f', and the local column via
-- conkey) and drops it by the discovered name, then adds a STABLY-NAMED
-- replacement. NOT VALID skips the full-table validation scan inside this deploy
-- transaction (0073 validates separately). Idempotent + re-run-safe: each swap is
-- guarded on "does the stably-named replacement already exist?" so a second run
-- neither re-drops the validated constraint nor re-adds it as NOT VALID.
--
-- CANONICAL DDL: hand-authored source of truth. No column/shape change → the
-- Drizzle mirror's onDelete hints in schema/posts.ts and schema/media.ts ARE
-- updated in the same delivery to match (mirror is for typed queries/diff only;
-- Drizzle does not emit these constraints).
--
-- Conventions: one transaction per file (src/db/migrate.ts). Forward-only, no down.
--
-- Ordering rules: requires 0051_social_posts.sql.
-- =============================================================================

DO $$
DECLARE
  cname text;
BEGIN
  -- posts.reply_to_id (posts→posts) → ON DELETE RESTRICT
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'posts_reply_to_id_fk' AND conrelid = 'posts'::regclass
  ) THEN
    SELECT conname INTO cname FROM pg_constraint
      WHERE conrelid = 'posts'::regclass AND confrelid = 'posts'::regclass AND contype = 'f'
        AND conkey = ARRAY[(SELECT attnum FROM pg_attribute
                            WHERE attrelid = 'posts'::regclass AND attname = 'reply_to_id')];
    IF cname IS NOT NULL THEN
      EXECUTE format('ALTER TABLE posts DROP CONSTRAINT %I', cname);
    END IF;
    ALTER TABLE posts ADD CONSTRAINT posts_reply_to_id_fk
      FOREIGN KEY (reply_to_id) REFERENCES posts (id) ON DELETE RESTRICT NOT VALID;
  END IF;

  -- posts.thread_root_id (posts→posts) → ON DELETE RESTRICT
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'posts_thread_root_id_fk' AND conrelid = 'posts'::regclass
  ) THEN
    SELECT conname INTO cname FROM pg_constraint
      WHERE conrelid = 'posts'::regclass AND confrelid = 'posts'::regclass AND contype = 'f'
        AND conkey = ARRAY[(SELECT attnum FROM pg_attribute
                            WHERE attrelid = 'posts'::regclass AND attname = 'thread_root_id')];
    IF cname IS NOT NULL THEN
      EXECUTE format('ALTER TABLE posts DROP CONSTRAINT %I', cname);
    END IF;
    ALTER TABLE posts ADD CONSTRAINT posts_thread_root_id_fk
      FOREIGN KEY (thread_root_id) REFERENCES posts (id) ON DELETE RESTRICT NOT VALID;
  END IF;

  -- posts.repost_of_id (posts→posts) → ON DELETE RESTRICT
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'posts_repost_of_id_fk' AND conrelid = 'posts'::regclass
  ) THEN
    SELECT conname INTO cname FROM pg_constraint
      WHERE conrelid = 'posts'::regclass AND confrelid = 'posts'::regclass AND contype = 'f'
        AND conkey = ARRAY[(SELECT attnum FROM pg_attribute
                            WHERE attrelid = 'posts'::regclass AND attname = 'repost_of_id')];
    IF cname IS NOT NULL THEN
      EXECUTE format('ALTER TABLE posts DROP CONSTRAINT %I', cname);
    END IF;
    ALTER TABLE posts ADD CONSTRAINT posts_repost_of_id_fk
      FOREIGN KEY (repost_of_id) REFERENCES posts (id) ON DELETE RESTRICT NOT VALID;
  END IF;

  -- media_assets.post_id (media_assets→posts) → ON DELETE SET NULL
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'media_assets_post_id_fk' AND conrelid = 'media_assets'::regclass
  ) THEN
    SELECT conname INTO cname FROM pg_constraint
      WHERE conrelid = 'media_assets'::regclass AND confrelid = 'posts'::regclass AND contype = 'f'
        AND conkey = ARRAY[(SELECT attnum FROM pg_attribute
                            WHERE attrelid = 'media_assets'::regclass AND attname = 'post_id')];
    IF cname IS NOT NULL THEN
      EXECUTE format('ALTER TABLE media_assets DROP CONSTRAINT %I', cname);
    END IF;
    ALTER TABLE media_assets ADD CONSTRAINT media_assets_post_id_fk
      FOREIGN KEY (post_id) REFERENCES posts (id) ON DELETE SET NULL NOT VALID;
  END IF;
END $$;
