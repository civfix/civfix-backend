-- =============================================================================
-- 0030_reference_codes.sql
-- -----------------------------------------------------------------------------
-- Issue #56 data-model foundation: human-readable reference codes + report
-- verification. Adds, all NULLABLE so existing INSERTs stay green:
--   * jurisdictions.code (integer UNIQUE) + jurisdiction_code_seq (D2)
--   * reference_counters table (per-scope atomic sequence) (D4)
--   * reports.reference_code / cleanups.reference_code (D1) + the EVENT
--     jurisdiction linkage cleanups.jurisdiction_geoid (D6)
--   * report verification cols on reports + user_moderation (D7) + a ONE-TIME
--     grandfather of report_verified for already-trusted reporters (D8)
--
-- CANONICAL DDL: this hand-authored SQL is the source of truth. The Drizzle
-- definitions under src/db/schema mirror it for typed queries / diff inspection.
--
-- Ordering rules:
--   * Requires 0001_core.sql (reports, cleanups, jurisdictions, report_timeline,
--     users) and 0007_admin_phase2.sql (user_moderation) and
--     0016_user_verification.sql (user_verification) already applied.
--   * Statements are IF NOT EXISTS / additive ALTERs / guarded constraints so a
--     partial or repeat apply is safe; the migrate runner also records applied
--     files.
--
-- H2/H3 NOTE: the reference_code UNIQUE indexes are created here in the same
-- transaction as the column add. That is intentional and safe: at creation the
-- column is 100% NULL on every row, so the index build is instant (a UNIQUE
-- index tolerates any number of NULLs). The DATA backfill that fills these codes
-- is a SEPARATE keyset-batched script (db:backfill:reference-codes), NOT run
-- inside this migration's transaction (a long table rewrite would block boot).
-- reference_code stays NULLABLE forever — never add NOT NULL.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- jurisdiction code (D2): ONE Postgres sequence is the single source of truth.
-- Backfilled rows get a stable ordinal by geoid here; lazily-upserted rows get
-- nextval(jurisdiction_code_seq) later (wired into jurisdiction-service by a
-- separate agent — this migration only creates the sequence + column + index).
-- -----------------------------------------------------------------------------
CREATE SEQUENCE IF NOT EXISTS jurisdiction_code_seq;

ALTER TABLE jurisdictions ADD COLUMN IF NOT EXISTS code integer;

-- Assign a stable ordinal by geoid (jurisdictions is ~28k rows — small, OK
-- in-migration). Only touches rows still NULL, so a repeat apply is a no-op.
UPDATE jurisdictions j
SET code = sub.rn
FROM (
  SELECT geoid, row_number() OVER (ORDER BY geoid) AS rn
  FROM jurisdictions
  WHERE code IS NULL
) sub
WHERE j.geoid = sub.geoid
  AND j.code IS NULL;

-- Advance the sequence past the max assigned code so new lazy upserts never
-- collide with a backfilled ordinal.
SELECT setval(
  'jurisdiction_code_seq',
  GREATEST((SELECT COALESCE(max(code), 0) FROM jurisdictions), 1)
);

-- UNIQUE permits many NULLs; here every row is backfilled so this is total.
CREATE UNIQUE INDEX IF NOT EXISTS jurisdictions_code_uidx ON jurisdictions (code);

-- -----------------------------------------------------------------------------
-- reference_counters (D4): per-scope monotonic counter. scope_key is
-- "{typecode}:{jurcode}" for reports / "EVENT:{jurcode}" for events. Allocation
-- is the atomic upsert (INSERT ... ON CONFLICT DO UPDATE SET next_val = next_val
-- + 1 RETURNING next_val), which both live create paths AND the backfill share,
-- so they can never mint a colliding code.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS reference_counters (
  scope_key text   PRIMARY KEY,
  next_val  bigint NOT NULL
);

-- -----------------------------------------------------------------------------
-- reference codes (D1) + EVENT jurisdiction linkage (D6). All NULLABLE; filled
-- by the live create paths going forward and by the post-deploy backfill for
-- historical rows. The UNIQUE indexes guarantee no two rows ever share a code.
-- -----------------------------------------------------------------------------
ALTER TABLE reports  ADD COLUMN IF NOT EXISTS reference_code text;
ALTER TABLE cleanups ADD COLUMN IF NOT EXISTS reference_code text;
ALTER TABLE cleanups ADD COLUMN IF NOT EXISTS jurisdiction_geoid text
  REFERENCES jurisdictions (geoid);

CREATE UNIQUE INDEX IF NOT EXISTS reports_reference_code_uidx  ON reports  (reference_code);
CREATE UNIQUE INDEX IF NOT EXISTS cleanups_reference_code_uidx ON cleanups (reference_code);
-- Backs EVENT mail routing + the cleanups-by-jurisdiction read.
CREATE INDEX IF NOT EXISTS cleanups_jurisdiction_idx ON cleanups (jurisdiction_geoid);

-- -----------------------------------------------------------------------------
-- report verification (D7): an operator verdict on a report, distinct from the
-- civic `status`. All NULLABLE; set by the (later) setReportVerdict endpoint.
-- -----------------------------------------------------------------------------
ALTER TABLE reports ADD COLUMN IF NOT EXISTS verification_verdict text;
ALTER TABLE reports DROP CONSTRAINT IF EXISTS reports_verification_verdict_check;
ALTER TABLE reports ADD CONSTRAINT reports_verification_verdict_check
  CHECK (verification_verdict IS NULL OR verification_verdict IN ('approved', 'rejected'));
ALTER TABLE reports ADD COLUMN IF NOT EXISTS verified_by uuid REFERENCES users (id);
ALTER TABLE reports ADD COLUMN IF NOT EXISTS verified_at timestamptz;

-- user_moderation gains the earned "report-verified" trust flag (D7). The
-- threshold (>= 2 approved reports) earns it; an explicit admin toggle can set
-- it too. NOT NULL DEFAULT false is safe because user_moderation rows carry
-- defaults for every other column.
ALTER TABLE user_moderation ADD COLUMN IF NOT EXISTS report_verified boolean NOT NULL DEFAULT false;
ALTER TABLE user_moderation ADD COLUMN IF NOT EXISTS report_verified_at timestamptz;
ALTER TABLE user_moderation ADD COLUMN IF NOT EXISTS report_verified_by uuid REFERENCES users (id);

-- -----------------------------------------------------------------------------
-- grandfather (D8) — run ONCE here. user_moderation rows are created LAZILY (on
-- the first moderation action for a user), so a plain UPDATE would miss every
-- already-trusted user who has never been moderated. We therefore UPSERT: insert
-- a fresh row (relying on user_moderation's column DEFAULTS for account_status /
-- strikes / removals / risk / flagged / updated_at) OR flip report_verified on
-- an existing row, for every user who either has >= 2 "real" (non-anon,
-- non-deleted, post-triage) reports OR an identity-verified record. Bounded /
-- small -> OK in-migration. Idempotent: re-running only re-sets a true flag.
-- -----------------------------------------------------------------------------
INSERT INTO user_moderation (user_id, report_verified, report_verified_at)
SELECT u.id, true, now()
FROM users u
WHERE u.id IN (
        SELECT reporter_user_id
        FROM reports
        WHERE reporter_user_id IS NOT NULL
          AND deleted_at IS NULL
          AND status IN ('acknowledged', 'in_progress', 'resolved')
        GROUP BY reporter_user_id
        HAVING count(*) >= 2
      )
   OR u.id IN (SELECT user_id FROM user_verification WHERE status = 'verified')
ON CONFLICT (user_id) DO UPDATE SET
  report_verified = true,
  report_verified_at = COALESCE(user_moderation.report_verified_at, now());
