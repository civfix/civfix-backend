-- =============================================================================
-- 0132_event_metrics_daily.sql
-- -----------------------------------------------------------------------------
-- The ONE analytics store (W2.7). Every number a host is shown comes from here
-- (or from a live count of their own roster) -- there is no analytics SDK, no
-- cookie, no device id, no IP and no per-person row anywhere in this table.
--
-- Shape is deliberately a narrow (metric, bucket) key-value grid rather than a
-- wide table: a new metric is a new row value, never a migration.
--   metric   'registrations' | 'cancellations' | 'checkins' | 'no_shows' |
--            'waitlist_joined' | 'waitlist_promoted' | 'page_views' |
--            'donation_clicks' | 'broadcast_recipients' | 'broadcast_sent' |
--            'broadcast_failed' | 'broadcast_suppressed' | 'unsubscribes'
--   bucket   '' for a plain daily total, otherwise a CLOSED-SET dimension value
--            (a page-view source bucket, a ticket type id, a channel).
--
-- `day` is the calendar day in the EVENT's timezone, not UTC: a host reads their
-- own day boundaries. The rollup recomputes the last N days idempotently, so a
-- backfill and a re-run converge on the same numbers.
--
-- The counters fed from Redis (page views, sources, donation clicks) are flushed
-- with GREATEST(existing, incoming): a flush can only ever raise a value, so a
-- lost Redis window or a double flush never rewrites history downwards.
--
-- Created empty in Phase 1 on purpose, so history accrues before the analytics
-- screens exist to render it. Retention: NEVER swept -- these are aggregates
-- with no identifier in them, and they are the only long-run record a host has.
--
-- CANONICAL DDL: hand-authored source of truth. Mirrors: schema/event_metrics_daily.ts.
-- =============================================================================

CREATE TABLE IF NOT EXISTS event_metrics_daily (
  cleanup_id uuid NOT NULL REFERENCES cleanups(id) ON DELETE CASCADE,
  day        date NOT NULL,
  metric     text NOT NULL,
  bucket     text NOT NULL DEFAULT '',
  value      bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (cleanup_id, day, metric, bucket),
  CONSTRAINT event_metrics_daily_value_check CHECK (value >= 0),
  CONSTRAINT event_metrics_daily_bucket_len_check CHECK (length(bucket) <= 64)
);

CREATE INDEX IF NOT EXISTS event_metrics_daily_metric_day_idx
  ON event_metrics_daily (cleanup_id, metric, day);
