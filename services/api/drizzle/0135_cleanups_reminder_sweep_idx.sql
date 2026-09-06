-- =============================================================================
-- 0135_cleanups_reminder_sweep_idx.sql
-- -----------------------------------------------------------------------------
-- Support index for the every-10-minutes reminder sweep (W2.5).
--
-- The sweep asks: which upcoming events have a reminder offset that just came
-- due? It walks LATERAL unnest(COALESCE(reminder_offsets_min, DEFAULTS)) over
-- events whose scheduled_at is still ahead, so the driving predicate is
-- (status = 'upcoming') and a range scan on scheduled_at. Without this partial
-- index that is a seq scan of every event ever created, every ten minutes,
-- forever.
--
-- Partial on status='upcoming' keeps it small: a completed or cancelled event is
-- never a reminder candidate, and the vast majority of rows become one of those.
--
-- CREATE INDEX (not CONCURRENTLY) is safe here: `cleanups` is a small, cold table
-- by the standards of the hot set (reports, chat_messages, media_assets, users),
-- and the migration runner takes one transaction per file. If cleanups ever grows
-- to hot-table size, this becomes an out-of-band CONCURRENTLY build and this file
-- stays as the idempotent no-op.
--
-- The reminder_offsets_min / host_reply_to columns themselves belong to the
-- cleanups host-column migration in the 0105-0114 range; this file adds ONLY the
-- sweep's index.
-- =============================================================================

CREATE INDEX IF NOT EXISTS cleanups_reminder_sweep_idx
  ON cleanups (scheduled_at)
  WHERE status = 'upcoming';
