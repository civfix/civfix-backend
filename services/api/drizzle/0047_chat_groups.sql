-- =============================================================================
-- 0047_chat_groups.sql
-- -----------------------------------------------------------------------------
-- P4 (Groups): user-created standalone chat rooms. chat_groups is the room row;
-- a CHANNEL is just a group with kind='channel': same table, same messages,
-- same membership. Nothing here enforces the channel posting rules (only
-- owner/admins post in a channel); that gate is app-level and lands in P5.
--
-- chat_group_members mirrors report_chat_members (0041): composite
-- PK(group_id, user_id), joined_at, and the same last_read_at read watermark
-- (NULL = never read; unread baseline falls back to joined_at), with a
-- three-tier role ladder (owner|admin|member) instead of 0041's two.
--
-- chat_messages grows a THIRD scope: group_id. The 0036 two-way XOR
-- (cleanup_id XOR report_id) becomes exactly-one-of-three via num_nonnulls.
-- Every existing row has exactly one of (cleanup_id, report_id) set and a NULL
-- group_id, so the swapped constraint validates cleanly across all partitions.
--
-- group_id gets a REAL foreign key: FKs FROM the partitioned chat_messages
-- parent TO a normal table are supported (PG 11+; the box is PG 16), the same
-- stance as cleanup_id (0002, inline) and report_id (0036, guarded ADD). Only
-- FKs pointing AT chat_messages are impossible (why reply_to_id / pinned_by are
-- FK-less); chat_groups is NOT partitioned, so referencing it is fine. No
-- ON DELETE action: groups are not deletable yet (a delete flow decides
-- tombstone-vs-cascade when it lands).
--
-- Every statement is idempotent / guarded so re-applying the file is a no-op
-- (the constraint swap's DROP IF EXISTS + ADD is a no-op as a PAIR: a re-apply
-- drops the three-way constraint and re-adds the identical definition).
-- =============================================================================

CREATE TABLE IF NOT EXISTS chat_groups (
  id              uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  -- 'channel' = broadcast variant of a group (P5 restricts posting to owner/admins).
  kind            text NOT NULL DEFAULT 'group' CHECK (kind IN ('group', 'channel')),
  name            text NOT NULL,
  description     text,
  -- Optional group avatar; same FK stance as users.avatar_media_id (0019): removing
  -- the media row orphans the avatar cleanly instead of blocking the delete.
  avatar_media_id uuid REFERENCES media_assets (id) ON DELETE SET NULL,
  owner_id        uuid NOT NULL REFERENCES users (id),
  visibility      text NOT NULL DEFAULT 'private' CHECK (visibility IN ('private', 'public')),
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS chat_group_members (
  group_id     uuid NOT NULL REFERENCES chat_groups (id) ON DELETE CASCADE,
  user_id      uuid NOT NULL REFERENCES users (id)       ON DELETE CASCADE,
  role         text NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'admin', 'member')),
  joined_at    timestamptz NOT NULL DEFAULT now(),
  last_read_at timestamptz,
  PRIMARY KEY (group_id, user_id)
);

-- "Which groups am I in" lookup (conversation list), mirroring
-- report_chat_members_user_idx (0041).
CREATE INDEX IF NOT EXISTS chat_group_members_user_idx ON chat_group_members (user_id);

-- Third scope column on the partitioned parent. Column and FK added SEPARATELY,
-- each guarded, exactly like report_id in 0036.
ALTER TABLE chat_messages
  ADD COLUMN IF NOT EXISTS group_id uuid;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chat_messages_group_id_fkey'
  ) THEN
    ALTER TABLE chat_messages
      ADD CONSTRAINT chat_messages_group_id_fkey
      FOREIGN KEY (group_id) REFERENCES chat_groups (id);
  END IF;
END $$;

-- Constraint swap: the 0036 XOR becomes exactly-one-of-three. DROP + ADD on the
-- partitioned parent both recurse to every partition; the ADD re-validates
-- existing rows (all satisfy it; see header). num_nonnulls counts the set
-- scopes directly, so this reads as "exactly one scope" instead of chained XORs.
ALTER TABLE chat_messages DROP CONSTRAINT IF EXISTS chat_messages_scope_chk;
ALTER TABLE chat_messages ADD CONSTRAINT chat_messages_scope_chk
  CHECK (num_nonnulls(cleanup_id, report_id, group_id) = 1);

-- Group-scoped history pagination (newest-first within a group), mirroring the
-- cleanup/report twins from 0002/0036. Declared on the parent so it propagates
-- to every current and future partition.
CREATE INDEX IF NOT EXISTS chat_messages_group_created_idx
  ON chat_messages (group_id, created_at DESC);

-- Partial pin-list index for group rooms: the third twin of the 0046 pair
-- (only pinned rows are indexed; see 0046 for the rationale).
CREATE INDEX IF NOT EXISTS chat_messages_group_pinned_idx
  ON chat_messages (group_id, pinned_at DESC)
  WHERE pinned_at IS NOT NULL;
