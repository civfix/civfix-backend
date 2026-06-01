-- =============================================================================
-- 0001_core.sql
-- -----------------------------------------------------------------------------
-- All NON-partitioned civfix tables, with full column types (including PostGIS
-- geometry), foreign keys, and every index (b-tree, unique, partial, and GiST).
--
-- chat_messages is intentionally NOT here: it is declaratively partitioned and is
-- created in 0002_chat_partitioning.sql.
--
-- CANONICAL DDL: this hand-authored SQL is the source of truth. The Drizzle
-- definitions under src/db/schema mirror it for typed queries / diff inspection.
--
-- Ordering rules:
--   * Requires 0000_extensions.sql (postgis, pgcrypto, citext) already applied.
--   * Tables are created parent-before-child so inline REFERENCES resolve.
--   * Statements use IF NOT EXISTS where Postgres supports it so a partial / repeat
--     apply is safe; the migrate runner additionally records applied files.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- users
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  role         text        NOT NULL DEFAULT 'citizen',
  display_name text        NOT NULL,
  handle       citext,
  bio          text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  deleted_at   timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS users_handle_key ON users (handle);
CREATE INDEX        IF NOT EXISTS users_role_idx   ON users (role);

-- -----------------------------------------------------------------------------
-- oauth_identities
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS oauth_identities (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  provider         text        NOT NULL,
  provider_user_id text        NOT NULL,
  created_at       timestamptz DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS oauth_identities_provider_user_key
  ON oauth_identities (provider, provider_user_id);
CREATE INDEX        IF NOT EXISTS oauth_identities_user_idx
  ON oauth_identities (user_id);

-- -----------------------------------------------------------------------------
-- email_otps
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS email_otps (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  email       citext      NOT NULL,
  code_hash   text        NOT NULL,
  expires_at  timestamptz NOT NULL,
  attempts    integer     NOT NULL DEFAULT 0,
  consumed_at timestamptz,
  created_at  timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS email_otps_email_created_idx ON email_otps (email, created_at);

-- -----------------------------------------------------------------------------
-- sessions  (id = SHA-256 hex of the 256-bit session token)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sessions (
  id           text        PRIMARY KEY,
  user_id      uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  created_at   timestamptz DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  user_agent   text,
  ip           inet
);
CREATE INDEX IF NOT EXISTS sessions_user_idx    ON sessions (user_id);
CREATE INDEX IF NOT EXISTS sessions_expires_idx ON sessions (expires_at);

-- -----------------------------------------------------------------------------
-- jurisdictions  (geom is MultiPolygon(4326); GiST index below)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS jurisdictions (
  geoid              text                          PRIMARY KEY,
  name               text                          NOT NULL,
  layer              text                          NOT NULL,
  priority           integer                       NOT NULL,
  geom               geometry(MultiPolygon, 4326)  NOT NULL,
  population         integer,
  contact_emails     text[],
  report_form_url    text,
  notes              text,
  contact_updated_at timestamptz
);
CREATE INDEX IF NOT EXISTS jurisdictions_layer_idx      ON jurisdictions (layer);
CREATE INDEX IF NOT EXISTS jurisdictions_population_idx ON jurisdictions (population);
-- Spatial index: makes ST_Contains(geom, point) jurisdiction lookups fast.
CREATE INDEX IF NOT EXISTS jurisdictions_geom_gist ON jurisdictions USING gist (geom);

-- -----------------------------------------------------------------------------
-- reports  (geom is Point(4326); GiST index below)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS reports (
  id                uuid                   PRIMARY KEY DEFAULT gen_random_uuid(),
  reporter_user_id  uuid                   REFERENCES users (id),
  anon_session_id   text,
  idempotency_key   uuid                   NOT NULL,
  geom              geometry(Point, 4326)  NOT NULL,
  geom_source       text                   NOT NULL,
  jurisdiction_geoid text                  REFERENCES jurisdictions (geoid),
  category          text                   NOT NULL,
  title             text,
  description       text,
  status            text                   NOT NULL,
  visibility        text                   NOT NULL DEFAULT 'public',
  h3_cell           text                   NOT NULL,
  created_at        timestamptz            DEFAULT now(),
  published_at      timestamptz,
  deleted_at        timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS reports_idempotency_key_key ON reports (idempotency_key);
CREATE INDEX        IF NOT EXISTS reports_jurisdiction_idx    ON reports (jurisdiction_geoid);
CREATE INDEX        IF NOT EXISTS reports_status_idx          ON reports (status);
CREATE INDEX        IF NOT EXISTS reports_h3_created_idx      ON reports (h3_cell, created_at);
CREATE INDEX        IF NOT EXISTS reports_reporter_idx        ON reports (reporter_user_id);
CREATE INDEX        IF NOT EXISTS reports_anon_session_idx    ON reports (anon_session_id);
-- Spatial index for bbox / radius / contains queries on report points.
CREATE INDEX        IF NOT EXISTS reports_geom_gist           ON reports USING gist (geom);

-- -----------------------------------------------------------------------------
-- media_assets
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS media_assets (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  report_id  uuid        REFERENCES reports (id) ON DELETE SET NULL,
  upload_id  uuid        NOT NULL,
  kind       text        NOT NULL,
  codec      text,
  r2_key     text        NOT NULL,
  thumb_key  text,
  status     text        NOT NULL,
  width      integer,
  height     integer,
  byte_size  bigint,
  phash      text,
  created_at timestamptz DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS media_assets_upload_id_key ON media_assets (upload_id);
CREATE INDEX        IF NOT EXISTS media_assets_report_idx    ON media_assets (report_id);
CREATE INDEX        IF NOT EXISTS media_assets_status_idx    ON media_assets (status);
CREATE INDEX        IF NOT EXISTS media_assets_phash_idx     ON media_assets (phash);

-- -----------------------------------------------------------------------------
-- report_timeline
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS report_timeline (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  report_id  uuid        NOT NULL REFERENCES reports (id) ON DELETE CASCADE,
  status     text        NOT NULL,
  note       text,
  actor_id   uuid        REFERENCES users (id),
  created_at timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS report_timeline_report_idx ON report_timeline (report_id, created_at);

-- -----------------------------------------------------------------------------
-- cleanups  (geom is Point(4326); GiST index below)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS cleanups (
  id                uuid                   PRIMARY KEY DEFAULT gen_random_uuid(),
  organizer_user_id uuid                   NOT NULL REFERENCES users (id),
  type              text                   NOT NULL,
  title             text                   NOT NULL,
  description       text,
  geom              geometry(Point, 4326)  NOT NULL,
  scheduled_at      timestamptz            NOT NULL,
  status            text                   NOT NULL,
  bring             text[],
  created_at        timestamptz            DEFAULT now()
);
CREATE INDEX IF NOT EXISTS cleanups_scheduled_idx ON cleanups (scheduled_at);
CREATE INDEX IF NOT EXISTS cleanups_status_idx    ON cleanups (status);
CREATE INDEX IF NOT EXISTS cleanups_organizer_idx ON cleanups (organizer_user_id);
-- Spatial index for "cleanups near me".
CREATE INDEX IF NOT EXISTS cleanups_geom_gist     ON cleanups USING gist (geom);

-- -----------------------------------------------------------------------------
-- cleanup_members  (composite PK)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS cleanup_members (
  cleanup_id uuid        NOT NULL REFERENCES cleanups (id) ON DELETE CASCADE,
  user_id    uuid        NOT NULL REFERENCES users (id),
  role       text        NOT NULL,
  joined_at  timestamptz DEFAULT now(),
  PRIMARY KEY (cleanup_id, user_id)
);
CREATE INDEX IF NOT EXISTS cleanup_members_user_idx ON cleanup_members (user_id);

-- -----------------------------------------------------------------------------
-- follows_people  (composite PK)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS follows_people (
  follower_id uuid        NOT NULL REFERENCES users (id),
  followee_id uuid        NOT NULL REFERENCES users (id),
  created_at  timestamptz DEFAULT now(),
  PRIMARY KEY (follower_id, followee_id)
);
CREATE INDEX IF NOT EXISTS follows_people_followee_idx ON follows_people (followee_id);

-- -----------------------------------------------------------------------------
-- report_follows  (composite PK)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS report_follows (
  user_id    uuid        NOT NULL REFERENCES users (id),
  report_id  uuid        NOT NULL REFERENCES reports (id) ON DELETE CASCADE,
  created_at timestamptz DEFAULT now(),
  PRIMARY KEY (user_id, report_id)
);
CREATE INDEX IF NOT EXISTS report_follows_report_idx ON report_follows (report_id);

-- -----------------------------------------------------------------------------
-- notifications  (partial index for unread badge)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS notifications (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid        NOT NULL REFERENCES users (id),
  type       text        NOT NULL,
  title      text        NOT NULL,
  body       text,
  link       text,
  read_at    timestamptz,
  created_at timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS notifications_user_created_idx
  ON notifications (user_id, created_at DESC);
-- Partial index: cheap unread-count / badge query.
CREATE INDEX IF NOT EXISTS notifications_user_unread_idx
  ON notifications (user_id) WHERE read_at IS NULL;

-- -----------------------------------------------------------------------------
-- notification_prefs  (1:1 with users; time-of-day quiet hours)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS notification_prefs (
  user_id        uuid    PRIMARY KEY REFERENCES users (id),
  push           boolean NOT NULL DEFAULT true,
  cleanup_chat   boolean NOT NULL DEFAULT true,
  report_updates boolean NOT NULL DEFAULT true,
  follows        boolean NOT NULL DEFAULT true,
  quiet_start    time,
  quiet_end      time
);

-- -----------------------------------------------------------------------------
-- push_tokens
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS push_tokens (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid        NOT NULL REFERENCES users (id),
  platform   text        NOT NULL,
  token      text        NOT NULL,
  device_id  text,
  created_at timestamptz DEFAULT now(),
  revoked_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS push_tokens_platform_token_key ON push_tokens (platform, token);
CREATE INDEX        IF NOT EXISTS push_tokens_user_idx           ON push_tokens (user_id);

-- -----------------------------------------------------------------------------
-- anon_tokens  (per-IP / per-H3 hourly counters live in Redis, NOT here)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS anon_tokens (
  id           text        PRIMARY KEY,
  created_at   timestamptz DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  report_count integer     NOT NULL DEFAULT 0,
  flagged      boolean     NOT NULL DEFAULT false,
  claim_code   text
);
CREATE INDEX IF NOT EXISTS anon_tokens_expires_idx ON anon_tokens (expires_at);

-- -----------------------------------------------------------------------------
-- abuse_flags  (partial index for the open mod queue)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS abuse_flags (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  subject_type text        NOT NULL,
  subject_id   text        NOT NULL,
  reason       text        NOT NULL,
  source       text        NOT NULL,
  created_at   timestamptz DEFAULT now(),
  resolved_at  timestamptz
);
CREATE INDEX IF NOT EXISTS abuse_flags_subject_idx ON abuse_flags (subject_type, subject_id);
CREATE INDEX IF NOT EXISTS abuse_flags_open_idx
  ON abuse_flags (created_at) WHERE resolved_at IS NULL;

-- -----------------------------------------------------------------------------
-- idempotency_keys
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS idempotency_keys (
  key               uuid        PRIMARY KEY,
  scope             text        NOT NULL,
  user_or_anon      text,
  response_snapshot jsonb       NOT NULL,
  created_at        timestamptz DEFAULT now()
);

-- -----------------------------------------------------------------------------
-- jurisdiction_discovery_tasks  (partial UNIQUE on open tasks per geoid)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS jurisdiction_discovery_tasks (
  id                   uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  geoid                text,
  place_geojson        jsonb,
  sample_report_id     uuid        REFERENCES reports (id),
  population           integer,
  status               text        NOT NULL DEFAULT 'open',
  assigned_operator_id uuid        REFERENCES users (id),
  created_at           timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS jurisdiction_discovery_status_pop_idx
  ON jurisdiction_discovery_tasks (status, population DESC);
-- Partial UNIQUE: at most one not-done discovery task per geoid, while allowing many done rows.
CREATE UNIQUE INDEX IF NOT EXISTS jurisdiction_discovery_geoid_open_key
  ON jurisdiction_discovery_tasks (geoid) WHERE status <> 'done';

-- -----------------------------------------------------------------------------
-- audit_log
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS audit_log (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id   uuid        REFERENCES users (id),
  action     text        NOT NULL,
  target     text,
  meta       jsonb,
  created_at timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS audit_log_actor_created_idx ON audit_log (actor_id, created_at);
CREATE INDEX IF NOT EXISTS audit_log_action_idx        ON audit_log (action);
