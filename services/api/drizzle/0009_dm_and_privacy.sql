-- =============================================================================
-- 0009_dm_and_privacy.sql
-- -----------------------------------------------------------------------------
-- 1:1 direct messages + the privacy primitives they need (DM toggle + blocking).
--
-- DM chat is a SEPARATE stack from cleanup group chat (dm_threads / dm_messages /
-- dm_read_state) so the existing cleanup chat (chat_messages, cleanup_members) is
-- left byte-for-byte unchanged. dm_messages mirrors chat_messages EXACTLY: it is
-- declaratively PARTITIONED BY RANGE (created_at), one partition per calendar
-- month, plus a catch-all DEFAULT partition, with PK(id, created_at) (a partitioned
-- table's PK must include the partition key). Same naming/bounds convention as
-- 0002_chat_partitioning.sql; the same monthly maintenance cron pre-creates next
-- month's partition (ensureNextMonthDmPartition).
--
-- Requires 0000_extensions.sql (pgcrypto -> gen_random_uuid) and 0001_core.sql
-- (users) to exist first for the foreign keys below.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- users.allow_direct_messages: the per-account DM toggle.
--
-- When false the user is hidden from people search AND a NEW openDm toward them is
-- rejected (403); EXISTING dm threads keep working. Additive + NOT NULL with a
-- DEFAULT true so the ALTER is instant and every existing account stays DM-able.
-- IF NOT EXISTS keeps the migration re-runnable.
-- -----------------------------------------------------------------------------
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS allow_direct_messages boolean NOT NULL DEFAULT true;

-- -----------------------------------------------------------------------------
-- dm_threads: one row per unordered user PAIR. A thread is unique per pair, so we
-- store the two participants as (user_lo, user_hi) with user_lo < user_hi and a
-- UNIQUE(user_lo, user_hi). Combined with an ON CONFLICT DO NOTHING insert this
-- makes openOrCreateThread idempotent regardless of which party initiates.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS dm_threads (
  id         uuid        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_lo    uuid        NOT NULL REFERENCES users (id),
  user_hi    uuid        NOT NULL REFERENCES users (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (user_lo < user_hi),
  UNIQUE (user_lo, user_hi)
);

-- -----------------------------------------------------------------------------
-- dm_messages: messages in a dm thread. Mirrors chat_messages (0002) exactly:
-- declaratively PARTITIONED BY RANGE (created_at), PK(id, created_at), and the
-- per-thread newest-first index on the parent (propagates to every partition).
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS dm_messages (
  id         uuid        NOT NULL DEFAULT gen_random_uuid(),
  thread_id  uuid        NOT NULL REFERENCES dm_threads (id) ON DELETE CASCADE,
  sender_id  uuid        NOT NULL REFERENCES users (id),
  body       text,
  kind       text        NOT NULL DEFAULT 'text',
  attachments jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  edited_at  timestamptz,
  deleted_at timestamptz,
  PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);

-- Index on the PARENT propagates to every (current and future) partition.
-- Serves history pagination: newest-first within a thread.
CREATE INDEX IF NOT EXISTS dm_messages_thread_created_idx
  ON dm_messages (thread_id, created_at DESC);

-- DEFAULT partition: catches any row whose created_at falls outside every explicit
-- monthly range, so inserts can never fail for lack of a partition.
CREATE TABLE IF NOT EXISTS dm_messages_default
  PARTITION OF dm_messages DEFAULT;

-- Current month: 2026-06 (bounds are [inclusive, exclusive)).
CREATE TABLE IF NOT EXISTS dm_messages_2026_06
  PARTITION OF dm_messages
  FOR VALUES FROM ('2026-06-01 00:00:00+00') TO ('2026-07-01 00:00:00+00');

-- Next month: 2026-07.
CREATE TABLE IF NOT EXISTS dm_messages_2026_07
  PARTITION OF dm_messages
  FOR VALUES FROM ('2026-07-01 00:00:00+00') TO ('2026-08-01 00:00:00+00');

-- Month after next: 2026-08.
CREATE TABLE IF NOT EXISTS dm_messages_2026_08
  PARTITION OF dm_messages
  FOR VALUES FROM ('2026-08-01 00:00:00+00') TO ('2026-09-01 00:00:00+00');

-- -----------------------------------------------------------------------------
-- dm_read_state: the per-(thread, user) read watermark, mirroring
-- cleanup_members.last_read_at. NULL last_read_at = never read (unread baseline
-- falls back to the thread's created_at). Written by the WS `ack` handler, read by
-- the threads service for unread counts.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS dm_read_state (
  thread_id    uuid        NOT NULL REFERENCES dm_threads (id) ON DELETE CASCADE,
  user_id      uuid        NOT NULL REFERENCES users (id),
  last_read_at timestamptz,
  PRIMARY KEY (thread_id, user_id)
);

-- -----------------------------------------------------------------------------
-- user_blocks: directed block edges. blocking hides the dm thread for BOTH sides
-- (excluded from the threads list when blocked either way) and rejects sends in the
-- WS gateway. PK(blocker_id, blocked_id) makes block idempotent; the CHECK forbids
-- self-blocks; the blocked_id index serves the reverse ("who blocked me?") lookups.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS user_blocks (
  blocker_id uuid        NOT NULL REFERENCES users (id),
  blocked_id uuid        NOT NULL REFERENCES users (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (blocker_id, blocked_id),
  CHECK (blocker_id <> blocked_id)
);

CREATE INDEX IF NOT EXISTS user_blocks_blocked_idx
  ON user_blocks (blocked_id);
