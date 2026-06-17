-- =============================================================================
-- 0017_report_discussion.sql
-- -----------------------------------------------------------------------------
-- Per-report public discussion: threaded comments on a report, lightweight emoji
-- reactions, and city/jurisdiction @mentions that can be forwarded to the
-- responsible authority. This is the citizen-facing comment thread on a report
-- detail (NOT the cleanup chat in chat_messages, NOT the operator-to-municipal
-- mail in mail_messages).
--
-- DELIBERATELY NON-PARTITIONED, plain uuid PK tables (unlike chat_messages, which
-- is RANGE-partitioned with a composite PK(id, created_at)). Comment volume per
-- report is bounded and the reaction/reply foreign keys must point at a single
-- column, so a flat uuid PK keeps the child FKs trivial. The self-referential
-- parent_id gives one level of replies; ON DELETE CASCADE on parent_id removes a
-- subtree, and ON DELETE CASCADE on report_id removes the whole thread when its
-- report is hard-deleted.
--
-- CANONICAL DDL: this hand-authored SQL is the source of truth. The Drizzle
-- definitions under src/db/schema mirror it for typed queries / diff inspection
-- (src/db/schema/discussion.ts, plus the additive column mirrors in media.ts and
-- jurisdictions.ts).
--
-- Conventions (match Phase 1/2): timestamptz, gen_random_uuid() defaults
-- (pgcrypto, enabled in 0000_extensions.sql), additive IF NOT EXISTS so a partial
-- or repeat apply is safe; the migrate runner (src/db/migrate.ts) also records
-- applied files and wraps each file in one transaction.
--
-- Ordering rules:
--   * Requires 0000_extensions.sql (pgcrypto for gen_random_uuid()).
--   * Requires 0001_core.sql (reports, users, jurisdictions, media_assets).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- report_discussion_messages  (one comment, or one reply). `parent_id` NULL = a
-- top-level comment; non-NULL = a reply to another message in the same thread.
-- `author_user_id` is NULL for system-authored entries (e.g. a city forward
-- note); `forwarded_to_city` marks a message that has been relayed to the
-- responsible jurisdiction. `edited_at` / `deleted_at` support edit + soft-delete
-- (soft-deleted rows stay so reply subtrees + reaction counts survive moderation).
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS report_discussion_messages (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  report_id         uuid        NOT NULL REFERENCES reports (id) ON DELETE CASCADE,
  parent_id         uuid        REFERENCES report_discussion_messages (id) ON DELETE CASCADE,
  author_user_id    uuid        REFERENCES users (id),
  body              text        NOT NULL,
  forwarded_to_city boolean     NOT NULL DEFAULT false,
  created_at        timestamptz NOT NULL DEFAULT now(),
  edited_at         timestamptz,
  deleted_at        timestamptz
);
-- Thread render + reply pagination: top-level + replies ordered chronologically
-- within a report.
CREATE INDEX IF NOT EXISTS report_discussion_messages_report_parent_created_idx
  ON report_discussion_messages (report_id, parent_id, created_at);

-- -----------------------------------------------------------------------------
-- report_message_reactions  (one row = one user's one emoji on one message). The
-- composite PK (message_id, user_id, emoji) makes a reaction idempotent and the
-- toggle a single DELETE / INSERT. `emoji` stores one of the ASCII reaction enum
-- names (like|heart|celebrate|support|insightful|concerned), NOT a raw glyph;
-- the allowed set is enforced in the application layer (REACTION_EMOJIS).
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS report_message_reactions (
  message_id uuid        NOT NULL REFERENCES report_discussion_messages (id) ON DELETE CASCADE,
  user_id    uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  emoji      text        NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (message_id, user_id, emoji)
);

-- -----------------------------------------------------------------------------
-- report_message_mentions  (a jurisdiction/city @mentioned in a message). The
-- composite PK (message_id, geoid) de-dupes a geoid mentioned twice in one
-- message. `forwarded_at` stamps when that mention was relayed to the
-- jurisdiction (NULL = mentioned but not yet forwarded).
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS report_message_mentions (
  message_id   uuid        NOT NULL REFERENCES report_discussion_messages (id) ON DELETE CASCADE,
  geoid        text        NOT NULL REFERENCES jurisdictions (geoid),
  forwarded_at timestamptz,
  PRIMARY KEY (message_id, geoid)
);

-- -----------------------------------------------------------------------------
-- media_assets.discussion_message_id  (attach media to a discussion message).
-- Additive sibling of media_assets.report_id; ON DELETE SET NULL orphans (rather
-- than deletes) the media row for moderation/audit, matching report_id's policy.
-- Do NOT overload report_id: a discussion attachment belongs to a message, and
-- the message already carries its own report_id link.
-- -----------------------------------------------------------------------------
ALTER TABLE media_assets
  ADD COLUMN IF NOT EXISTS discussion_message_id uuid
  REFERENCES report_discussion_messages (id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS media_assets_discussion_message_idx
  ON media_assets (discussion_message_id);

-- -----------------------------------------------------------------------------
-- jurisdictions.handle  (the @handle used to mention a jurisdiction in a
-- discussion message, e.g. "@sf"). Nullable: most jurisdictions have no handle.
-- A PARTIAL UNIQUE index on lower(handle) (WHERE handle IS NOT NULL) keeps
-- handles case-insensitively unique while still allowing many NULL-handle rows.
-- -----------------------------------------------------------------------------
ALTER TABLE jurisdictions ADD COLUMN IF NOT EXISTS handle text;
CREATE UNIQUE INDEX IF NOT EXISTS jurisdictions_handle_lower_key
  ON jurisdictions (lower(handle))
  WHERE handle IS NOT NULL;
