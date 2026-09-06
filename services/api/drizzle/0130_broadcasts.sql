-- =============================================================================
-- 0130_broadcasts.sql
-- -----------------------------------------------------------------------------
-- Host broadcasts (W2.1). civfix is the RELAY between an event host and the
-- people who signed up: the host composes once, the platform resolves the
-- audience, renders per channel and sends per recipient. A host NEVER learns a
-- member's email address, and nothing here stores one.
--
--   broadcasts             one composed message. `segment` is the contract's
--                          discriminated union stored as jsonb (one hand-written
--                          query per branch -- see broadcast-audience-sql.ts --
--                          so audience resolution never becomes dynamic SQL).
--                          `body_md` is scrubbed at 180d by the host retention
--                          sweep; the counts and the row survive as the audit
--                          record of "a message was sent".
--                          UNIQUE (cleanup_id, reminder_offset_min) WHERE
--                          kind='reminder' IS the reminder idempotency key: the
--                          */10 sweep can fire twice on the same offset and the
--                          second insert is a no-op.
--   broadcast_deliveries   one row per (recipient, channel). Deliberately holds
--                          NO subject, NO body, NO address and NO name -- the
--                          contact is re-resolved from the roster at send time,
--                          so a scrub or an unsubscribe between plan and send is
--                          honoured. UNIQUE (broadcast_id, channel,
--                          recipient_kind, recipient_id) is the per-recipient
--                          idempotency guard that makes the chunked pipeline
--                          safe to interrupt and resume.
--   cleanup_broadcast_mutes  per-event opt-out by a signed-in member. Bulk kinds
--                          honour it; the two critical kinds (event_updated,
--                          event_cancelled) bypass it, because "this event was
--                          cancelled" is a service message, not marketing.
--
-- recipient_id is a STORED generated column over (user_id, guest_id) so the
-- per-recipient unique index can be one index over one column. A user hard-delete
-- SET NULLs user_id and therefore NULLs recipient_id; Postgres treats NULLs as
-- distinct, which is exactly right -- there is no recipient left to deduplicate.
--
-- CANONICAL DDL: hand-authored source of truth. Mirrors: schema/broadcasts.ts,
-- schema/broadcast_deliveries.ts, schema/cleanup_broadcast_mutes.ts.
--
-- LOCK ORDER (binding on every writer, W1.2): organizations ->
-- organization_members -> cleanups -> cleanup_members -> cleanup_guests ->
-- cleanup_registrations -> cleanup_registration_seats -> cleanup_answers ->
-- cleanup_waitlist -> cleanup_ticket_types -> cleanup_slots ->
-- cleanup_slot_claims. Broadcast writers take no lock on any of
-- them beyond the row they read.
--
-- Conventions: CREATE TABLE / CREATE INDEX IF NOT EXISTS; one concern per file;
-- applied in one transaction by the migration runner.
-- =============================================================================

CREATE TABLE IF NOT EXISTS broadcasts (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cleanup_id          uuid NOT NULL REFERENCES cleanups(id) ON DELETE CASCADE,
  created_by          uuid REFERENCES users(id) ON DELETE SET NULL,
  kind                text NOT NULL,
  reminder_offset_min integer,
  status              text NOT NULL DEFAULT 'draft',
  subject             text,
  body_md             text,
  cta_label           text,
  cta_url             text,
  segment             jsonb,
  channels            text[] NOT NULL DEFAULT ARRAY['inapp','push','email']::text[],
  reply_to            text,
  scheduled_at        timestamptz,
  planned_at          timestamptz,
  started_at          timestamptz,
  finished_at         timestamptz,
  chunk_size          integer NOT NULL DEFAULT 200,
  chunk_count         integer NOT NULL DEFAULT 0,
  recipient_count     integer NOT NULL DEFAULT 0,
  sent_count          integer NOT NULL DEFAULT 0,
  failed_count        integer NOT NULL DEFAULT 0,
  suppressed_count    integer NOT NULL DEFAULT 0,
  content_scrubbed_at timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT broadcasts_kind_check CHECK (kind IN (
    'host_broadcast','confirmation','waitlist_promoted','reminder',
    'event_updated','event_cancelled','thank_you')),
  CONSTRAINT broadcasts_status_check CHECK (status IN (
    'draft','scheduled','sending','sent','cancelled','failed')),
  CONSTRAINT broadcasts_chunk_size_check CHECK (chunk_size BETWEEN 1 AND 1000),
  CONSTRAINT broadcasts_cta_url_https_check CHECK (cta_url IS NULL OR cta_url LIKE 'https://%'),
  CONSTRAINT broadcasts_reminder_offset_check CHECK (
    (kind = 'reminder' AND reminder_offset_min IS NOT NULL AND reminder_offset_min > 0)
    OR (kind <> 'reminder' AND reminder_offset_min IS NULL))
);

CREATE INDEX IF NOT EXISTS broadcasts_cleanup_created_idx
  ON broadcasts (cleanup_id, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS broadcasts_due_idx
  ON broadcasts (scheduled_at)
  WHERE status = 'scheduled';

CREATE INDEX IF NOT EXISTS broadcasts_inflight_idx
  ON broadcasts (started_at)
  WHERE status = 'sending';

CREATE UNIQUE INDEX IF NOT EXISTS broadcasts_reminder_uidx
  ON broadcasts (cleanup_id, reminder_offset_min)
  WHERE kind = 'reminder';

CREATE INDEX IF NOT EXISTS broadcasts_scrub_idx
  ON broadcasts (finished_at)
  WHERE content_scrubbed_at IS NULL AND body_md IS NOT NULL;

CREATE INDEX IF NOT EXISTS broadcasts_admin_log_idx
  ON broadcasts (created_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS broadcast_deliveries (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  broadcast_id       uuid NOT NULL REFERENCES broadcasts(id) ON DELETE CASCADE,
  chunk_no           integer NOT NULL DEFAULT 0,
  recipient_kind     text NOT NULL,
  user_id            uuid REFERENCES users(id) ON DELETE SET NULL,
  guest_id           uuid REFERENCES cleanup_guests(id) ON DELETE CASCADE,
  recipient_id       uuid GENERATED ALWAYS AS (COALESCE(user_id, guest_id)) STORED,
  channel            text NOT NULL,
  status             text NOT NULL DEFAULT 'pending',
  suppression_reason text,
  failure_kind       text,
  provider_message_id text,
  attempts           integer NOT NULL DEFAULT 0,
  sent_at            timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT broadcast_deliveries_recipient_kind_check CHECK (recipient_kind IN ('member','guest')),
  CONSTRAINT broadcast_deliveries_channel_check CHECK (channel IN ('inapp','push','email','sms')),
  CONSTRAINT broadcast_deliveries_status_check CHECK (status IN (
    'pending','in_flight','sent','failed','suppressed','skipped')),
  CONSTRAINT broadcast_deliveries_suppression_reason_check CHECK (
    suppression_reason IS NULL OR suppression_reason IN (
      'unsubscribed','muted','prefs_off','stop_listed','bounce_suppressed','no_contact',
      'contact_scrubbed','kill_switch','banned','deleted_user','cap')),
  CONSTRAINT broadcast_deliveries_failure_kind_check CHECK (
    failure_kind IS NULL OR failure_kind IN ('transient','permanent','auth','oversize','unknown')),
  CONSTRAINT broadcast_deliveries_subject_check CHECK (
    (recipient_kind = 'member' AND guest_id IS NULL)
    OR (recipient_kind = 'guest' AND user_id IS NULL AND guest_id IS NOT NULL)),
  CONSTRAINT broadcast_deliveries_guest_channel_check CHECK (
    recipient_kind = 'member' OR channel IN ('email','sms'))
);

CREATE UNIQUE INDEX IF NOT EXISTS broadcast_deliveries_recipient_uidx
  ON broadcast_deliveries (broadcast_id, channel, recipient_kind, recipient_id);

CREATE INDEX IF NOT EXISTS broadcast_deliveries_pending_idx
  ON broadcast_deliveries (broadcast_id, chunk_no)
  WHERE status IN ('pending','in_flight');

CREATE INDEX IF NOT EXISTS broadcast_deliveries_rollup_idx
  ON broadcast_deliveries (broadcast_id, channel, status);

CREATE INDEX IF NOT EXISTS broadcast_deliveries_created_idx
  ON broadcast_deliveries (created_at);

CREATE TABLE IF NOT EXISTS cleanup_broadcast_mutes (
  cleanup_id uuid NOT NULL REFERENCES cleanups(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (cleanup_id, user_id)
);

CREATE INDEX IF NOT EXISTS cleanup_broadcast_mutes_user_idx
  ON cleanup_broadcast_mutes (user_id);
