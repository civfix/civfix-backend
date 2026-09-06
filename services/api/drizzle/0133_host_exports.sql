-- =============================================================================
-- 0133_host_exports.sql
-- -----------------------------------------------------------------------------
-- Host CSV exports (W2.8). A host asks for a roster / answers / check-ins /
-- donations CSV; a job builds it in bounded pages, writes ONE object to storage
-- and records only its key here.
--
-- The row deliberately does NOT carry a URL. The download endpoint re-checks the
-- caller's capability at request time and mints a 5-MINUTE forceSigned presign,
-- so no long-lived roster URL is ever parked in a 90-day notification row or in
-- a database backup.
--
-- expires_at is the OBJECT's life (24h). The reaper deletes the object FIRST and
-- only then blanks r2_key and marks the row 'expired' (H10: an orphaned object
-- is unreachable but permanent; an orphaned row is merely untidy). The rows
-- themselves are deleted at 90d by the host retention sweep.
--
-- `filters` is the request's filter object as validated by the contract; it is
-- echoed into the CSV's provenance header so a stale spreadsheet can be traced
-- back to what was asked for.
--
-- CANONICAL DDL: hand-authored source of truth. Mirrors: schema/host_exports.ts.
-- =============================================================================

CREATE TABLE IF NOT EXISTS host_exports (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cleanup_id      uuid REFERENCES cleanups(id) ON DELETE CASCADE,
  organization_id uuid REFERENCES organizations(id) ON DELETE CASCADE,
  requested_by    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind            text NOT NULL,
  filters         jsonb NOT NULL DEFAULT '{}'::jsonb,
  status          text NOT NULL DEFAULT 'queued',
  r2_key          text,
  row_count       integer,
  byte_size       bigint,
  truncated       boolean NOT NULL DEFAULT false,
  error_code      text,
  requested_at    timestamptz NOT NULL DEFAULT now(),
  started_at      timestamptz,
  completed_at    timestamptz,
  expires_at      timestamptz,
  CONSTRAINT host_exports_kind_check CHECK (kind IN ('roster','answers','checkins','donations')),
  CONSTRAINT host_exports_status_check CHECK (status IN ('queued','running','ready','failed','expired')),
  CONSTRAINT host_exports_scope_check CHECK (cleanup_id IS NOT NULL OR organization_id IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS host_exports_cleanup_requested_idx
  ON host_exports (cleanup_id, requested_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS host_exports_requester_idx
  ON host_exports (requested_by, requested_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS host_exports_reap_idx
  ON host_exports (expires_at)
  WHERE status = 'ready';

CREATE INDEX IF NOT EXISTS host_exports_stuck_idx
  ON host_exports (started_at)
  WHERE status = 'running';
