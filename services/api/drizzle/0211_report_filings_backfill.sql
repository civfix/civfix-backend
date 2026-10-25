-- =============================================================================
-- 0211_report_filings_backfill.sql
-- -----------------------------------------------------------------------------
-- City filing (epic #164, D5): a report routed to its city before filings
-- existed gets the submitted email filing routeReport records from this
-- release on, so residents see it as filed and it is not filed twice. It ships
-- with that recording, so no report routed in between is missed.
--
-- "Sent" is the code's proof of delivery, not mail_threads.status (which is
-- 'sent' from the moment the thread is created): an outbound packet message
-- (direction 'out', kind 'packet' or NULL, as getOutreach's packet_sent reads
-- it) with a mail_events row of type 'sent' for it, which recordSent writes
-- after the mailer accepts the message. A thread whose packets only failed
-- gets nothing; a cleanup thread (report_id NULL) gets nothing.
--
-- One filing per such thread whose report has no filing yet, dated by the
-- thread's earliest sent event (created_at, submitted_at and updated_at, so
-- the admin's filed list orders it by when it was filed, not by this
-- migration). It matched no route, so route_category is NULL, and the text
-- the city got is the packet on the thread, so ticket_text is empty.
--
-- DATA ONLY: no DDL, so no schema mirror change. Insert-only: filing rows are
-- never deleted. Idempotent: a re-run finds every such report already filed.
-- =============================================================================

WITH sent AS (
  SELECT m.thread_id, min(e.created_at) AS sent_at
  FROM mail_messages m
  JOIN mail_events e ON e.message_id = m.id::text AND e.type = 'sent'
  WHERE m.direction = 'out' AND COALESCE(m.kind, 'packet') = 'packet'
  GROUP BY m.thread_id
)
INSERT INTO report_filings (
  report_id, geoid, category, route_category, channel, status, method, ticket_text,
  mail_thread_id, created_at, updated_at, submitted_at
)
SELECT t.report_id, r.jurisdiction_geoid, r.category, NULL, 'email', 'submitted', 'email', '',
       t.id, s.sent_at, s.sent_at, s.sent_at
FROM mail_threads t
JOIN sent s ON s.thread_id = t.id
JOIN reports r ON r.id = t.report_id
WHERE NOT EXISTS (SELECT 1 FROM report_filings f WHERE f.report_id = t.report_id);
