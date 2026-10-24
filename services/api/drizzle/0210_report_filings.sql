-- =============================================================================
-- 0196_report_filings.sql
-- -----------------------------------------------------------------------------
-- Automated city filing (epic #164): where each report was filed, how, and what
-- the city said back. Until now the only trace was the report's mail_threads
-- row and its `route` timeline entries.
--
--   1. `report_filings`: one row per attempt to file a report with its city
--      (D5). At most one ACTIVE filing (queued, running, needs_human) per
--      report, enforced by report_filings_active_report_key, so a second
--      "file this" while one is in flight is refused by the database rather
--      than raced in the service. `geoid` and `channel` are NULL for a report
--      with no jurisdiction or no route (D4). `run_id` is minted by each
--      claim (queued -> running), so a filer's late result for an older run
--      matches nothing. Rows are never deleted: they are the record of what
--      was sent to a city on a resident's behalf.
--   2. `filing_evidence`: R2 keys of the screenshots and scripts a filer run
--      kept as proof.
--   3. `filing_routes`: per jurisdiction and category, how to file (D4). A
--      NULL category is the jurisdiction's default; uniqueness is two partial
--      indexes because a plain UNIQUE treats NULLs as distinct (the
--      jurisdiction_contacts idiom).
--   4. `filing_settings`: the singleton pause switch, the
--      forward_template_settings idiom (`id smallint PRIMARY KEY CHECK (id =
--      1)`), seeded here so every read finds its row.
--   5. `filing_messages`: a city message correlated to a filing (D11), either
--      a filings-inbox message or an email-channel reply, never both. Each
--      message is linked at most once, which is what makes its effects
--      at-most-once. inbound_email_id is ON DELETE SET NULL so the inbox's
--      180-day retention sweep still deletes the message; the row keeps only
--      its classification and summary.
--
-- The CHECK value sets are the contract's D15 enums; their TS mirrors are
-- FILING_*_VALUES in schema/types.ts.
--
-- NO CASCADES onto reports or jurisdictions: reports are never hard-deleted,
-- and the two jobs that do delete these FK targets (the boundary prune and the
-- demo purge) clear filing rows first.
--
-- LOCK TIMEOUT: the FKs take a SHARE ROW EXCLUSIVE lock on reports (a hot
-- table), and a queued lock request stalls every report read behind it. The
-- timeout fails this file instead, and the deploy is retried.
--
-- INDEXES: all five tables are new and empty, so plain CREATE INDEX.
--
-- CANONICAL DDL: hand-authored source of truth. Mirror: schema/filings.ts.
--
-- Conventions: one transaction per file. Forward-only, no down. Idempotent:
-- every statement is IF NOT EXISTS or ON CONFLICT DO NOTHING.
-- =============================================================================

SET LOCAL lock_timeout = '3s';

CREATE TABLE IF NOT EXISTS report_filings (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  report_id       uuid        NOT NULL REFERENCES reports (id),
  geoid           text        REFERENCES jurisdictions (geoid),
  category        text        NOT NULL,
  route_category  text,
  channel         text        CHECK (channel IN ('email', 'portal', 'manual')),
  portal_host     text,
  form_url        text,
  status          text        NOT NULL
                              CHECK (status IN ('queued', 'running', 'submitted', 'linked_existing',
                                                'needs_human', 'cancelled')),
  method          text        CHECK (method IN ('email', 'script', 'operator')),
  reason          text        CHECK (reason IN ('no_route', 'route_disabled', 'manual_route',
                                                'filing_off', 'dry_run', 'captcha',
                                                'login_required', 'missing_info', 'portal_error',
                                                'attempts_exhausted', 'uncertain_submission',
                                                'ai_unavailable', 'city_needs_info',
                                                'reopened_after_city_closed', 'other')),
  reason_detail   text        CHECK (char_length(reason_detail) <= 500),
  case_id         text        CHECK (char_length(case_id) <= 64),
  case_url        text,
  city_closed_at  timestamptz,
  attempts        integer     NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  run_id          uuid,
  next_attempt_at timestamptz,
  ai_wait_since   timestamptz,
  script_version  text,
  dry_run         boolean     NOT NULL DEFAULT false,
  ticket_text     text        NOT NULL,
  note            text        CHECK (char_length(note) <= 500),
  mail_thread_id  uuid        REFERENCES mail_threads (id),
  created_by      uuid        REFERENCES users (id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  submitted_at    timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS report_filings_active_report_key
  ON report_filings (report_id)
  WHERE status IN ('queued', 'running', 'needs_human');
-- The admin list per group, newest first.
CREATE INDEX IF NOT EXISTS report_filings_status_updated_idx
  ON report_filings (status, updated_at DESC);
CREATE INDEX IF NOT EXISTS report_filings_report_created_idx
  ON report_filings (report_id, created_at DESC);
-- Inbound correlation matches case ids found in a city's message (D11).
CREATE INDEX IF NOT EXISTS report_filings_case_id_idx
  ON report_filings (case_id) WHERE case_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS report_filings_mail_thread_idx
  ON report_filings (mail_thread_id) WHERE mail_thread_id IS NOT NULL;
-- Route health per jurisdiction, and the boundary prune's geoid lookups.
CREATE INDEX IF NOT EXISTS report_filings_geoid_route_idx
  ON report_filings (geoid, route_category) WHERE geoid IS NOT NULL;

CREATE TABLE IF NOT EXISTS filing_evidence (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  filing_id  uuid        NOT NULL REFERENCES report_filings (id),
  r2_key     text        NOT NULL,
  kind       text        NOT NULL CHECK (kind IN ('screenshot', 'script')),
  label      text        CHECK (char_length(label) <= 120),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS filing_evidence_filing_created_idx
  ON filing_evidence (filing_id, created_at);

CREATE TABLE IF NOT EXISTS filing_routes (
  id                    uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  geoid                 text        NOT NULL REFERENCES jurisdictions (geoid),
  category              text,
  channel               text        NOT NULL CHECK (channel IN ('email', 'portal', 'manual')),
  form_url              text,
  request_type_hint     text        CHECK (char_length(request_type_hint) <= 200),
  include_link          boolean     NOT NULL DEFAULT true,
  status_sender_domains text[]      NOT NULL DEFAULT '{}'
                                    CHECK (cardinality(status_sender_domains) <= 5),
  enabled               boolean     NOT NULL DEFAULT true,
  updated_at            timestamptz NOT NULL DEFAULT now(),
  updated_by            uuid        REFERENCES users (id),
  CONSTRAINT filing_routes_portal_form_url_check CHECK (channel <> 'portal' OR form_url IS NOT NULL)
);

CREATE UNIQUE INDEX IF NOT EXISTS filing_routes_geoid_category_key
  ON filing_routes (geoid, category) WHERE category IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS filing_routes_geoid_default_key
  ON filing_routes (geoid) WHERE category IS NULL;

CREATE TABLE IF NOT EXISTS filing_settings (
  id         smallint    PRIMARY KEY CHECK (id = 1),
  paused     boolean     NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid        REFERENCES users (id)
);

INSERT INTO filing_settings (id, paused) VALUES (1, false) ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS filing_messages (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  filing_id        uuid        NOT NULL REFERENCES report_filings (id),
  inbound_email_id uuid        REFERENCES inbound_emails (id) ON DELETE SET NULL,
  mail_message_id  uuid        REFERENCES mail_messages (id),
  trusted          boolean     NOT NULL DEFAULT false,
  flagged          boolean     NOT NULL DEFAULT false,
  classification   jsonb,
  summary          text        CHECK (char_length(summary) <= 280),
  applied_at       timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT filing_messages_one_message_check
    CHECK (inbound_email_id IS NULL OR mail_message_id IS NULL)
);

CREATE UNIQUE INDEX IF NOT EXISTS filing_messages_inbound_email_key
  ON filing_messages (inbound_email_id) WHERE inbound_email_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS filing_messages_mail_message_key
  ON filing_messages (mail_message_id) WHERE mail_message_id IS NOT NULL;
-- A filing's messages, and the FK check when a filing row is purged.
CREATE INDEX IF NOT EXISTS filing_messages_filing_created_idx
  ON filing_messages (filing_id, created_at);
