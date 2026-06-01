-- =============================================================================
-- 0002_chat_partitioning.sql
-- -----------------------------------------------------------------------------
-- chat_messages: declaratively PARTITIONED BY RANGE (created_at), one partition
-- per calendar month, plus a catch-all DEFAULT partition.
--
-- Why partitioning: cleanup chat is append-heavy and time-ordered. Monthly range
-- partitions keep indexes small, make retention/drop cheap (DROP a month), and
-- let the planner prune by created_at on history queries.
--
-- Why PK(id, created_at): a partitioned table's PRIMARY KEY (and every UNIQUE
-- constraint) MUST include all partition-key columns. created_at is the partition
-- key, so the PK is the composite (id, created_at). This matches the Drizzle model
-- in src/db/schema/chat.ts.
--
-- Requires 0000_extensions.sql (pgcrypto -> gen_random_uuid) and 0001_core.sql
-- (cleanups, users) to exist first for the foreign keys below.
--
-- PARTITION MANAGEMENT: the fixed monthly partitions below are seed/example
-- partitions for the current and next two months as of this migration's authoring
-- (2026-05). A later worker step adds a monthly cron that pre-creates the upcoming
-- month's partition. The DEFAULT partition guarantees inserts never fail even if a
-- month's partition has not been created yet (rows simply land in chat_messages_default
-- and can be redistributed later). Bounds are [lower inclusive, upper exclusive).
-- =============================================================================

-- Parent partitioned table. No data lives here directly; rows route to partitions.
CREATE TABLE IF NOT EXISTS chat_messages (
  id         uuid        NOT NULL DEFAULT gen_random_uuid(),
  cleanup_id uuid        NOT NULL REFERENCES cleanups (id),
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
-- Serves history pagination: newest-first within a cleanup.
CREATE INDEX IF NOT EXISTS chat_messages_cleanup_created_idx
  ON chat_messages (cleanup_id, created_at DESC);

-- DEFAULT partition: catches any row whose created_at falls outside every explicit
-- monthly range, so inserts can never fail for lack of a partition.
CREATE TABLE IF NOT EXISTS chat_messages_default
  PARTITION OF chat_messages DEFAULT;

-- Current month: 2026-05 (example/seed partition; bounds are [inclusive, exclusive)).
CREATE TABLE IF NOT EXISTS chat_messages_2026_05
  PARTITION OF chat_messages
  FOR VALUES FROM ('2026-05-01 00:00:00+00') TO ('2026-06-01 00:00:00+00');

-- Next month: 2026-06.
CREATE TABLE IF NOT EXISTS chat_messages_2026_06
  PARTITION OF chat_messages
  FOR VALUES FROM ('2026-06-01 00:00:00+00') TO ('2026-07-01 00:00:00+00');

-- Month after next: 2026-07.
CREATE TABLE IF NOT EXISTS chat_messages_2026_07
  PARTITION OF chat_messages
  FOR VALUES FROM ('2026-07-01 00:00:00+00') TO ('2026-08-01 00:00:00+00');
