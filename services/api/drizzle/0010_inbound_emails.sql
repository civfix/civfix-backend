-- 0010_inbound_emails.sql
--
-- Catch-all *@civfix.org inbound mail that is NOT an outreach reply. Reply mail (carrying a
-- reply+{token}@ thread token) still flows into mail_threads/mail_messages unchanged; everything else
-- lands here and is triaged in the admin Inbox feature.
--
-- Idempotency: message_id is the dedup key (the RFC822 Message-ID, or a derived stable hash when the
-- header is absent), enforced by a UNIQUE index. The inbound processor inserts ON CONFLICT DO NOTHING,
-- so a re-delivered email (webhook + sweep racing the same R2 object) never creates a duplicate row.
--
-- Pipeline: Cloudflare Email Worker -> R2 inbound/pending/<id>.eml -> backend webhook/sweep ->
-- this table. See documents/17-inbound-email-worker.md.

CREATE TABLE IF NOT EXISTS inbound_emails (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id      text        NOT NULL,                       -- RFC822 Message-ID OR a derived hash
  from_addr       text,
  to_addr         text,                                       -- the full To header
  recipient       text,                                       -- the chosen catch-all address (full, e.g. support@civfix.org)
  subject         text,
  body_text       text,
  body_html       text,
  headers         jsonb       NOT NULL DEFAULT '{}'::jsonb,
  attachments     jsonb       NOT NULL DEFAULT '[]'::jsonb,   -- [{ key, filename, size }], same shape as mail_messages
  has_attachments boolean     NOT NULL DEFAULT false,
  status          text        NOT NULL DEFAULT 'unread'
                              CHECK (status IN ('unread', 'read', 'archived')),
  received_at     timestamptz NOT NULL DEFAULT now(),
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- Idempotency: one row per message_id. The dedup key for BOTH the webhook and the sweep.
CREATE UNIQUE INDEX IF NOT EXISTS inbound_emails_message_id_key ON inbound_emails (message_id);
-- Inbox list: newest first, optionally status-filtered.
CREATE INDEX IF NOT EXISTS inbound_emails_received_idx ON inbound_emails (received_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS inbound_emails_status_received_idx ON inbound_emails (status, received_at DESC, id DESC);
-- Recipient facet (filter the inbox by catch-all local-part).
CREATE INDEX IF NOT EXISTS inbound_emails_recipient_idx ON inbound_emails (recipient);
