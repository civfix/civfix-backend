-- =============================================================================
-- 0051_social_posts.sql
-- -----------------------------------------------------------------------------
-- First-class social POSTS + interaction tables (like / save / mention) for the
-- X-style civic feed. Repost / quote / reply are POSTS rows (kind + repost_of/
-- reply_to), NOT separate tables, which keeps the timeline a single scan. Post media
-- reuses media_assets via a new post_id column + purpose='post'. Attachable event
-- (cleanups) / report (reports) cards are FK columns hydrated into LinkedEventRef
-- / LinkedReportRef.
--
-- Enum-ish text columns (kind, visibility) are APP-ENFORCED (no DB CHECK, matching
-- the reports.category / cleanups.status convention): mirrored in
-- src/db/schema/types.ts (POST_KIND_VALUES) with the enums.test.ts drift guard
-- against the shared PostKindSchema.
--
-- Unlike chat_message_reactions/mentions (which cannot FK the RANGE-partitioned
-- chat/dm message tables), post_likes/saves/mentions DO FK posts (a plain uuid PK)
-- with ON DELETE CASCADE, cleaner than the chat precedent. Counts are
-- denormalized on posts and bumped in the SAME txn as the interaction insert/
-- delete (precedent: cleanups.bags, report chat counts).
--
-- Also adds notification_prefs.post_interactions (DEFAULT true): the per-user
-- toggle gating the post_like/post_repost/post_reply/post_quote bells (post_mention
-- rides the existing `mentions` toggle). Additive with a TRUE default so existing
-- users keep receiving interaction notifications (plan §8.9).
--
-- CANONICAL DDL: this hand-authored SQL is the source of truth. The Drizzle
-- mirrors under src/db/schema/{posts,post_likes,post_saves,post_mentions}.ts are
-- for typed queries / diff inspection only; they are NOT applied to create the DB.
--
-- Conventions (match the rest of the suite): timestamptz, additive
-- IF NOT EXISTS / ADD COLUMN IF NOT EXISTS so a partial or repeat apply is safe;
-- the migrate runner (src/db/migrate.ts) records applied files and wraps each file
-- in one transaction.
--
-- Ordering rules: requires 0001_core.sql (users), reports, cleanups, media_assets,
-- and notification_prefs (0009/0010 messaging + prefs). All referenced tables exist
-- by 0050.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- posts  (one row = one post; a repost/quote/reply is also a posts row).
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS posts (
  id                 uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  author_id          uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  kind               text        NOT NULL DEFAULT 'post',   -- 'post'|'repost'|'quote'|'reply'
  body               text,                                   -- null for a pure repost
  visibility         text        NOT NULL DEFAULT 'public',  -- reuse ReportVisibility precedent
  reply_to_id        uuid        REFERENCES posts (id) ON DELETE CASCADE,   -- comment/reply parent
  thread_root_id     uuid        REFERENCES posts (id) ON DELETE CASCADE,   -- denormalized thread root
  repost_of_id       uuid        REFERENCES posts (id) ON DELETE CASCADE,   -- repost & quote target
  event_id           uuid        REFERENCES cleanups (id) ON DELETE SET NULL,
  report_id          uuid        REFERENCES reports  (id) ON DELETE SET NULL,
  like_count         int         NOT NULL DEFAULT 0,
  repost_count       int         NOT NULL DEFAULT 0,
  reply_count        int         NOT NULL DEFAULT 0,
  save_count         int         NOT NULL DEFAULT 0,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),   -- edit bumps this; DTO exposes editedAt when > created_at
  deleted_at         timestamptz                            -- soft delete
);

CREATE INDEX IF NOT EXISTS posts_author_created_idx
  ON posts (author_id, created_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS posts_reply_to_idx
  ON posts (reply_to_id, created_at) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS posts_repost_of_idx        ON posts (repost_of_id);
CREATE INDEX IF NOT EXISTS posts_event_idx            ON posts (event_id);
CREATE INDEX IF NOT EXISTS posts_report_idx           ON posts (report_id);
CREATE INDEX IF NOT EXISTS posts_public_recent_idx
  ON posts (created_at DESC) WHERE deleted_at IS NULL AND visibility = 'public';
-- Repost is a toggle: at most one repost per user per target.
CREATE UNIQUE INDEX IF NOT EXISTS posts_repost_unique_idx
  ON posts (author_id, repost_of_id) WHERE kind = 'repost';

-- -----------------------------------------------------------------------------
-- post_likes  (one row = one user's like on one post). Composite PK de-dupes,
-- makes the toggle a single INSERT ... ON CONFLICT DO NOTHING / DELETE.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS post_likes (
  post_id    uuid        NOT NULL REFERENCES posts (id) ON DELETE CASCADE,
  user_id    uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (post_id, user_id)
);
CREATE INDEX IF NOT EXISTS post_likes_user_idx ON post_likes (user_id);

-- -----------------------------------------------------------------------------
-- post_saves  (one row = one user's private bookmark of one post).
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS post_saves (
  post_id    uuid        NOT NULL REFERENCES posts (id) ON DELETE CASCADE,
  user_id    uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (post_id, user_id)
);
-- Keyset for GET /me/saves (newest-saved first).
CREATE INDEX IF NOT EXISTS post_saves_user_idx ON post_saves (user_id, created_at DESC);

-- -----------------------------------------------------------------------------
-- post_mentions  (one row = one user @-mentioned in one post). Mirrors
-- chat_message_mentions; reuses makeMentionRepo(sql, 'post_mentions').
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS post_mentions (
  post_id           uuid NOT NULL REFERENCES posts (id) ON DELETE CASCADE,
  mentioned_user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  PRIMARY KEY (post_id, mentioned_user_id)
);
CREATE INDEX IF NOT EXISTS post_mentions_user_idx ON post_mentions (mentioned_user_id);

-- -----------------------------------------------------------------------------
-- Post media reuses the existing intake pipeline: a nullable FK + the 'post'
-- purpose value (mirrored LAST in src/db/schema/types.ts MEDIA_PURPOSE_VALUES).
-- -----------------------------------------------------------------------------
ALTER TABLE media_assets ADD COLUMN IF NOT EXISTS post_id uuid REFERENCES posts (id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS media_assets_post_idx
  ON media_assets (post_id) WHERE post_id IS NOT NULL;

-- -----------------------------------------------------------------------------
-- notification_prefs.post_interactions: per-user toggle for the like/repost/
-- reply/quote bells. DEFAULT true so existing rows keep receiving them (§8.9).
-- -----------------------------------------------------------------------------
ALTER TABLE notification_prefs
  ADD COLUMN IF NOT EXISTS post_interactions boolean NOT NULL DEFAULT true;

COMMENT ON COLUMN posts.kind IS
  'post | repost | quote | reply — enforced app-side by shared PostKindSchema (mirror POST_KIND_VALUES in src/db/schema/types.ts; no DB CHECK by convention).';
