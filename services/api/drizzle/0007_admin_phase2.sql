-- =============================================================================
-- 0007_admin_phase2.sql
-- -----------------------------------------------------------------------------
-- Phase 2 (admin / operator dashboard) schema. Adds the tables + columns the
-- operator backend needs, per documents/phase2/00-architecture-decisions.md
-- section 3. Mirrored in src/db/schema/{jurisdiction_contacts,gov_claims,
-- user_moderation,moderation_items,mail,outreach_state,cleanup_timeline}.ts and
-- the cleanups column additions in src/db/schema/cleanups.ts.
--
-- CANONICAL DDL: this hand-authored SQL is the source of truth. The Drizzle
-- definitions under src/db/schema mirror it for typed queries / diff inspection.
--
-- Conventions (match Phase 1): timestamptz, gen_random_uuid() defaults, inet for
-- IP columns, jsonb for structured blobs, and b-tree indexes on the columns
-- operators filter/sort by (status, created_at, geoid, subject). Statements use
-- IF NOT EXISTS / additive ALTERs so a partial or repeat apply is safe; the
-- migrate runner also records applied files.
--
-- L1 NOTE: the Phase-2 email columns here (jurisdiction_contacts.email,
-- gov_claims.contact_email, mail_messages.from_addr/to_addr) are plain `text`,
-- NOT citext - per decisions 3.1/3.2 (routing-contact / mail addresses are stored
-- as-is, not case-folded). citext is used only for users.email / users.handle in
-- Phase 1. Do not "fix" these to citext: that would change comparison/uniqueness
-- semantics. The Drizzle mirrors agree (text).
--
-- Ordering rules:
--   * Requires 0001_core.sql (users, jurisdictions, cleanups) already applied.
--   * Requires 0000_extensions.sql (pgcrypto for gen_random_uuid, citext).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- jurisdiction_contacts  (per-category routing contacts; extends jurisdictions
-- without breaking the legacy jurisdictions.contact_emails[]). Resolution order
-- at routing time: category-specific row -> default row (category NULL) ->
-- legacy jurisdictions.contact_emails[]. unique(geoid, category) makes the
-- per-category upsert a single ON CONFLICT.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS jurisdiction_contacts (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  geoid      text        NOT NULL REFERENCES jurisdictions (geoid),
  -- NULL category = the default/all-categories contact for the jurisdiction.
  category   text,
  email      text,
  form_url   text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
-- One contact row per (geoid, category). A NULL category is treated as a
-- distinct value by a UNIQUE constraint in Postgres (two NULLs would NOT
-- collide), so we enforce the "single default per geoid" invariant with two
-- partial unique indexes instead: one for the typed rows, one for the default.
CREATE UNIQUE INDEX IF NOT EXISTS jurisdiction_contacts_geoid_category_key
  ON jurisdiction_contacts (geoid, category)
  WHERE category IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS jurisdiction_contacts_geoid_default_key
  ON jurisdiction_contacts (geoid)
  WHERE category IS NULL;
CREATE INDEX IF NOT EXISTS jurisdiction_contacts_geoid_idx
  ON jurisdiction_contacts (geoid);

-- -----------------------------------------------------------------------------
-- gov_claims  (government provisioning queue). Approve sets the linked user's
-- role to gov_admin and links the jurisdiction; all transitions audited.
-- `checks` jsonb shape: { linkedin|directory|callback:
--   { status:'verified'|'pending', evidence?:string, note?:string, at?:ts } }.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS gov_claims (
  id                 uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            uuid        REFERENCES users (id),
  name               text        NOT NULL,
  title              text,
  org                text,
  jurisdiction_geoid text        REFERENCES jurisdictions (geoid),
  method             text        NOT NULL CHECK (method IN ('email', 'cold_outreach')),
  contact_email      text,
  status             text        NOT NULL DEFAULT 'pending'
                                 CHECK (status IN ('pending', 'approved', 'rejected')),
  checks             jsonb       NOT NULL DEFAULT '{}'::jsonb,
  reject_reason      text,
  decided_by         uuid        REFERENCES users (id),
  decided_at         timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS gov_claims_status_created_idx ON gov_claims (status, created_at DESC);
CREATE INDEX IF NOT EXISTS gov_claims_geoid_idx          ON gov_claims (jurisdiction_geoid);
CREATE INDEX IF NOT EXISTS gov_claims_user_idx           ON gov_claims (user_id);

-- -----------------------------------------------------------------------------
-- user_moderation  (trust/abuse side table; keeps `users` lean). 1:1 with
-- users via the PK. account_status drives suspend/ban; "verified neighbor" vs
-- "unverified" trust is DERIVED at read time (verified email / oauth identity),
-- never stored. Counts (reports, cleanups, removals) are derived via queries.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS user_moderation (
  user_id        uuid        PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  account_status text        NOT NULL DEFAULT 'active'
                             CHECK (account_status IN ('active', 'suspended', 'review', 'banned')),
  strikes        integer     NOT NULL DEFAULT 0,
  removals       integer     NOT NULL DEFAULT 0,
  risk           text        NOT NULL DEFAULT 'low'
                             CHECK (risk IN ('low', 'watch', 'elevated', 'high')),
  flagged        boolean     NOT NULL DEFAULT false,
  flag_reason    text,
  last_device    text,
  last_ip        inet,
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS user_moderation_status_idx ON user_moderation (account_status);
-- Partial index for the "flagged accounts" operator filter.
CREATE INDEX IF NOT EXISTS user_moderation_flagged_idx
  ON user_moderation (user_id) WHERE flagged = true;

-- -----------------------------------------------------------------------------
-- moderation_items  (the moderation queue of held media / patterns / appeals).
-- Producers: the media-worker hold path + anon hold-then-publish + abuse
-- detection. Operator actions transition `status` and apply the underlying
-- effect; items clear from the queue on action (status <> 'open').
--   signals jsonb : array of { label, val, tone:'ok'|'warn'|'bad' }
--   similar jsonb : array of { id, note, when }
--   meta    jsonb : user-context snapshot (trust, priorReports, priorRemovals,
--                   strikes, device)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS moderation_items (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  kind         text        NOT NULL
                           CHECK (kind IN ('image', 'pattern', 'appeal', 'gps', 'duplicate')),
  subject_type text        NOT NULL CHECK (subject_type IN ('report', 'user', 'chat')),
  subject_id   uuid        NOT NULL,
  flag         text,
  reason       text,
  category     text,
  place        text,
  priority     text        NOT NULL DEFAULT 'med' CHECK (priority IN ('low', 'med', 'high')),
  auto_action  text,
  signals      jsonb       NOT NULL DEFAULT '[]'::jsonb,
  similar      jsonb       NOT NULL DEFAULT '[]'::jsonb,
  status       text        NOT NULL DEFAULT 'open'
                           CHECK (status IN ('open', 'approved', 'removed', 'held')),
  meta         jsonb       NOT NULL DEFAULT '{}'::jsonb,
  resolved_by  uuid        REFERENCES users (id),
  resolved_at  timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS moderation_items_status_created_idx
  ON moderation_items (status, created_at DESC);
CREATE INDEX IF NOT EXISTS moderation_items_subject_idx
  ON moderation_items (subject_type, subject_id);
-- Partial index keeps the open-queue scan (the hot operator view) tight.
CREATE INDEX IF NOT EXISTS moderation_items_open_idx
  ON moderation_items (priority, created_at DESC) WHERE status = 'open';

-- -----------------------------------------------------------------------------
-- mail_threads  (one conversation with a municipal contact). thread_token is
-- minted into reply+{token}@{MAIL_REPLY_DOMAIN}, so it is globally unique.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS mail_threads (
  id                 uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_token       text        NOT NULL UNIQUE,
  jurisdiction_geoid text        REFERENCES jurisdictions (geoid),
  org                text,
  subject            text,
  status             text        NOT NULL DEFAULT 'sent'
                                 CHECK (status IN ('sent', 'delivered', 'opened', 'replied',
                                                   'bounced', 'needs_action', 'auto')),
  unread             boolean     NOT NULL DEFAULT false,
  last_message_at    timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS mail_threads_status_idx       ON mail_threads (status);
CREATE INDEX IF NOT EXISTS mail_threads_geoid_idx        ON mail_threads (jurisdiction_geoid);
CREATE INDEX IF NOT EXISTS mail_threads_last_message_idx ON mail_threads (last_message_at DESC);
-- Partial index for the "unread" mailbox filter.
CREATE INDEX IF NOT EXISTS mail_threads_unread_idx
  ON mail_threads (last_message_at DESC) WHERE unread = true;

-- -----------------------------------------------------------------------------
-- mail_messages  (one message in a thread). attachments jsonb: array of
-- { key (R2), filename, size }. direction in|out.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS mail_messages (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_id   uuid        NOT NULL REFERENCES mail_threads (id) ON DELETE CASCADE,
  direction   text        NOT NULL CHECK (direction IN ('in', 'out')),
  from_addr   text,
  to_addr     text,
  subject     text,
  body        text,
  attachments jsonb       NOT NULL DEFAULT '[]'::jsonb,
  message_id  text,
  in_reply_to text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS mail_messages_thread_created_idx ON mail_messages (thread_id, created_at);
-- Inbound threading resolves by RFC822 Message-ID; index the ones we store.
CREATE INDEX IF NOT EXISTS mail_messages_message_id_idx
  ON mail_messages (message_id) WHERE message_id IS NOT NULL;

-- -----------------------------------------------------------------------------
-- mail_events  (OCI delivery webhook feed: sent/delivered/bounced/complained/
-- opened). Deliverability stats derive from this table over a rolling window.
-- thread_id / message_id are nullable: an event may arrive before we can
-- correlate it to a stored thread/message.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS mail_events (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_id  uuid        REFERENCES mail_threads (id) ON DELETE SET NULL,
  message_id text,
  type       text        NOT NULL
                         CHECK (type IN ('sent', 'delivered', 'bounced', 'complained', 'opened')),
  meta       jsonb       NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS mail_events_type_created_idx ON mail_events (type, created_at DESC);
CREATE INDEX IF NOT EXISTS mail_events_thread_idx       ON mail_events (thread_id);

-- -----------------------------------------------------------------------------
-- outreach_state  (one row per jurisdiction). Enforces the <=1 outreach /
-- jurisdiction / OUTREACH_THROTTLE_DAYS throttle and a manual suppression flag.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS outreach_state (
  geoid            text        PRIMARY KEY REFERENCES jurisdictions (geoid),
  last_outreach_at timestamptz,
  suppressed       boolean     NOT NULL DEFAULT false
);

-- -----------------------------------------------------------------------------
-- cleanups additions  (events domain). capacity + bags back the Turnout panel.
-- The status column is free text (no Phase 1 check constraint), so the Phase 2
-- event statuses (upcoming|in_progress|completed|cancelled) need no constraint
-- change; the application writes the reconciled values.
-- -----------------------------------------------------------------------------
ALTER TABLE cleanups ADD COLUMN IF NOT EXISTS capacity integer;
ALTER TABLE cleanups ADD COLUMN IF NOT EXISTS bags     integer NOT NULL DEFAULT 0;

-- -----------------------------------------------------------------------------
-- cleanup_timeline  (mirrors report_timeline for event activity). Deleting the
-- cleanup cascades. Indexed by (cleanup_id, created_at) for the ordered render.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS cleanup_timeline (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  cleanup_id uuid        NOT NULL REFERENCES cleanups (id) ON DELETE CASCADE,
  kind       text        NOT NULL,
  note       text,
  actor_id   uuid        REFERENCES users (id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS cleanup_timeline_cleanup_idx ON cleanup_timeline (cleanup_id, created_at);
