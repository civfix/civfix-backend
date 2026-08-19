-- =============================================================================
-- 0067_chat_partition_window.sql
-- -----------------------------------------------------------------------------
-- FINDING F001: the RANGE-partitioned message tables (chat_messages 0002,
-- dm_messages 0009) were seeded with only a handful of fixed monthly partitions
-- (chat through 2026-07, dm through 2026-08) plus a catch-all DEFAULT partition.
-- Once "now" passes the last seeded month, every new message routes into the
-- DEFAULT partition, which defeats pruning/retention and (once populated) makes
-- adding the correct monthly partition require an ACCESS EXCLUSIVE scan of the
-- default. This migration pre-creates the missing monthly partitions in a
-- DATE-RELATIVE window (no hardcoded end month) so a fresh deploy self-heals the
-- gap, and the worker's monthly cron (media-worker partition-maintenance, F001's
-- code half) keeps the window rolling forward from here.
--
-- DEFAULT-PARTITION SAFETY: creating a new range partition while a DEFAULT
-- partition exists takes ACCESS EXCLUSIVE on the default and scans it to prove no
-- existing row falls in the new range. That is instant on an EMPTY default and
-- unbounded on a populated one. So we create partitions ONLY when the relevant
-- default partition is empty; if it already holds rows we RAISE WARNING with the
-- runbook pointer and skip, never taking a long lock over a populated default at
-- deploy time. Pre-launch prod: both defaults are expected empty, so the full
-- window is created.
--
-- Window: [ current month - 1, current month + 3 ] inclusive. IF NOT EXISTS makes
-- re-application (and overlap with already-seeded months) a safe no-op.
--
-- CANONICAL DDL: this hand-authored SQL is the source of truth. There is no
-- Drizzle mirror change: partitions are physical children of the already-mirrored
-- chat_messages / dm_messages parents (schema/chat.ts, schema/dm_messages.ts).
--
-- Conventions: the migrate runner (src/db/migrate.ts) wraps each file in ONE
-- transaction; the DO block below is that single unit. Forward-only, no down.
--
-- Ordering rules: requires 0002_chat_partitioning.sql and 0009_dm_and_privacy.sql.
-- =============================================================================

DO $$
DECLARE
  m                     date;
  chat_default_has_rows boolean;
  dm_default_has_rows   boolean;
  lo                    timestamptz;
  hi                    timestamptz;
BEGIN
  SELECT EXISTS (SELECT 1 FROM chat_messages_default LIMIT 1) INTO chat_default_has_rows;
  SELECT EXISTS (SELECT 1 FROM dm_messages_default   LIMIT 1) INTO dm_default_has_rows;

  FOR m IN
    SELECT generate_series(
             date_trunc('month', now()) - interval '1 month',
             date_trunc('month', now()) + interval '3 months',
             interval '1 month'
           )::date
  LOOP
    lo := m::timestamptz;
    hi := (m + interval '1 month')::timestamptz;

    IF NOT chat_default_has_rows THEN
      EXECUTE format(
        'CREATE TABLE IF NOT EXISTS chat_messages_%s PARTITION OF chat_messages FOR VALUES FROM (%L) TO (%L)',
        to_char(m, 'YYYY_MM'), lo, hi
      );
    END IF;

    IF NOT dm_default_has_rows THEN
      EXECUTE format(
        'CREATE TABLE IF NOT EXISTS dm_messages_%s PARTITION OF dm_messages FOR VALUES FROM (%L) TO (%L)',
        to_char(m, 'YYYY_MM'), lo, hi
      );
    END IF;
  END LOOP;

  IF chat_default_has_rows THEN
    RAISE WARNING 'chat_messages_default is non-empty; skipped partition pre-creation to avoid an ACCESS EXCLUSIVE scan of a populated default. Redistribute the default and re-run F001 partition maintenance per civfix-backend/docs/retention-cleanup.md.';
  END IF;
  IF dm_default_has_rows THEN
    RAISE WARNING 'dm_messages_default is non-empty; skipped partition pre-creation to avoid an ACCESS EXCLUSIVE scan of a populated default. Redistribute the default and re-run F001 partition maintenance per civfix-backend/docs/retention-cleanup.md.';
  END IF;
END $$;
