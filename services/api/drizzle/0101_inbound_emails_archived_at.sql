-- 0101_inbound_emails_archived_at.sql
--
-- H10: inbound_emails holds complete third-party correspondence (body_text, body_html, allowlisted
-- headers, R2 attachment keys) and had no retention rule. DECIDED RULE: an ARCHIVED thread's row is
-- purged 180 days after it was archived; unread/read rows are untouched (they are still open work), and
-- the R2 attachment objects go with the row. `archived_at` is the clock that rule needs; the table
-- previously recorded only the `status` string, so "when was this archived" was unrecoverable.
--
-- Backfill: existing archived rows get `received_at` as their archive time (the only timestamp the row
-- carries). That is conservative: it can only make an already-archived row eligible sooner, never later,
-- and pre-launch the table is empty.
--
-- inbound_emails is a small operator-plane table (catch-all inbox), not a hot table, so a plain
-- CREATE INDEX inside the migration transaction is safe.

ALTER TABLE inbound_emails ADD COLUMN IF NOT EXISTS archived_at timestamptz;

UPDATE inbound_emails SET archived_at = received_at
WHERE status = 'archived' AND archived_at IS NULL;

-- The retention sweep's predicate: archived rows past the TTL, oldest first.
CREATE INDEX IF NOT EXISTS inbound_emails_archived_at_idx
  ON inbound_emails (archived_at)
  WHERE archived_at IS NOT NULL;
