-- =============================================================================
-- 0102_users_last_activity.sql
-- -----------------------------------------------------------------------------
-- AUDIT H18: GET /users/follow-suggestions built its candidate set from EVERY
-- non-deleted, handle-bearing user and then ran, PER CANDIDATE, a LATERAL over
-- reports + cleanups plus a geography ST_Distance, applying the LIMIT only after
-- the full sort. Cost was O(total users) per request, inside a 15s
-- statement_timeout, at 30 req/min per identity.
--
-- The fix materialises the point that LATERAL used to derive (the user's most
-- recent locatable public act: report filed, event organized/completed) onto
-- the users row, so the candidate set can be bounded BEFORE any per-row work by
-- a KNN index scan (see social-repository.drizzle.ts suggestFollows).
--
-- HOT TABLE: `users`. Both columns are NULLABLE with NO DEFAULT, so this is a
-- catalog-only ADD COLUMN: no table rewrite, no full-table lock beyond the
-- brief ACCESS EXCLUSIVE for the catalog update.
--
-- INDEXES ARE NOT CREATED HERE. The migration runner wraps every file in one
-- transaction (src/db/migrate.ts), and CREATE INDEX CONCURRENTLY cannot run in
-- a transaction block; a plain CREATE INDEX on `users` would hold ACCESS
-- EXCLUSIVE for the whole build and queue every login behind it. The two
-- indexes the new query needs are therefore built OUT OF BAND, exactly as
-- docs/out-of-band-indexes.md specifies. The DO block below creates nothing: it
-- is an idempotent guard that RAISES A WARNING in the deploy log when either
-- index is still missing, so a forgotten out-of-band build is loud instead of
-- silent. The query is correct without them, only slower.
--
-- Existing rows are backfilled AFTER the deploy is healthy by
-- `pnpm db:backfill:user-activity` (src/db/backfill-user-activity.ts), which is
-- keyset-paged and idempotent.
--
-- PRIVACY: no new class of data. The point is a copy of a location this same
-- user already published on a report or an event; it is never returned to any
-- client (it only orders suggestions) and erasure nulls both columns in the
-- same transaction as the rest of the tombstone (auth/pg-stores.ts).
--
-- CANONICAL DDL: hand-authored source of truth. Mirror: schema/users.ts.
--
-- Conventions: additive ADD COLUMN IF NOT EXISTS; one concern per file; one
-- transaction per file. Forward-only, no down.
--
-- Ordering rules: requires 0001_core.sql (users).
-- =============================================================================

ALTER TABLE users ADD COLUMN IF NOT EXISTS last_activity_geom geometry(Point, 4326);
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_activity_at   timestamptz;

COMMENT ON COLUMN users.last_activity_geom IS
  'Materialized point of the user''s most recent locatable public act (report filed, event organized or completed). Feeds the bounded KNN candidate scan in suggestFollows; never served to clients; nulled on erasure. Backfill: pnpm db:backfill:user-activity.';

COMMENT ON COLUMN users.last_activity_at IS
  'Timestamp paired with last_activity_geom; also the recency-bounded fallback ordering for suggestFollows when the viewer has no location. Monotonic: writers only move it forward.';

DO $$
BEGIN
  IF to_regclass('public.users_last_activity_gist') IS NULL THEN
    RAISE WARNING 'users_last_activity_gist is missing - build it out of band with CREATE INDEX CONCURRENTLY (docs/out-of-band-indexes.md); follow suggestions fall back to a sequential scan until then';
  END IF;
  IF to_regclass('public.users_last_activity_at_idx') IS NULL THEN
    RAISE WARNING 'users_last_activity_at_idx is missing - build it out of band with CREATE INDEX CONCURRENTLY (docs/out-of-band-indexes.md); the no-location suggestion fallback sorts without an index until then';
  END IF;
END $$;
