-- =============================================================================
-- 0016_user_verification.sql
-- -----------------------------------------------------------------------------
-- User document-verification ("verified neighbor") feature. A signed-in user
-- applies for verification by uploading supporting documents + a note; an
-- operator reviews them in the admin user section and approves/rejects. The
-- approved state drives the verified mark on accounts + the events they host.
--
-- Mirrors the gov_claims application-review pattern (0007_admin_phase2.sql): a
-- pending -> verified|rejected state machine with a reviewer + decision stamp,
-- all transitions audited via writeAudit. Unlike gov_claims it is 1:1 with the
-- user (PK user_id) and changes NO role -- it is a cosmetic trust signal only.
--
-- Also tags media_assets with a `purpose` so verification document images are
-- isolated from the public report-media serve path (see media.routes guard).
--
-- CANONICAL DDL: this hand-authored SQL is the source of truth. The Drizzle
-- definitions under src/db/schema mirror it for typed queries / diff inspection.
--
-- Conventions (match Phase 1/2): timestamptz, jsonb for structured blobs, status
-- CHECK constraints, additive IF NOT EXISTS so a partial / repeat apply is safe.
--
-- Ordering:
--   * Requires 0001_core.sql (users, media_assets) already applied.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- user_verification  (document-verification queue; 1:1 with users via the PK).
-- A row exists once the user has applied; ABSENCE of a row = "unverified". Re-
-- applying after a rejection upserts the row back to 'pending'. `documents`
-- jsonb shape: array of { mediaId: uuid, status?: 'pending'|'verified'|'rejected',
-- note?: string } referencing media_assets rows tagged purpose='verification'.
-- Approve sets status='verified' (NO role change); reject sets status='rejected'
-- + rejection_reason. All transitions audited.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS user_verification (
  user_id          uuid        PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  status           text        NOT NULL DEFAULT 'pending'
                               CHECK (status IN ('pending', 'verified', 'rejected')),
  note             text,
  documents        jsonb       NOT NULL DEFAULT '[]'::jsonb,
  rejection_reason text,
  reviewed_by      uuid        REFERENCES users (id),
  reviewed_at      timestamptz,
  applied_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
-- The admin verification queue scans by (status, applied_at DESC) for the
-- pending-first review view.
CREATE INDEX IF NOT EXISTS user_verification_status_applied_idx
  ON user_verification (status, applied_at DESC);

-- -----------------------------------------------------------------------------
-- media_assets.purpose  (isolates verification document images from the public
-- report-media path). Default 'report' keeps every existing row + the report
-- upload flow unchanged; verification finalize sets 'verification', and the
-- public GET /media/:id serve path refuses to serve 'verification' media (it is
-- reachable only via the authenticated owner / admin signed-URL routes).
-- -----------------------------------------------------------------------------
ALTER TABLE media_assets
  ADD COLUMN IF NOT EXISTS purpose text NOT NULL DEFAULT 'report'
  CHECK (purpose IN ('report', 'verification'));
