-- =============================================================================
-- 0079_idempotency_drop_key_pk.sql
-- -----------------------------------------------------------------------------
-- FINDING F028 (part 2). Drop the old key-only PRIMARY KEY on idempotency_keys;
-- the composite UNIQUE from 0078 (idempotency_key_scope_owner_uk) is now the
-- uniqueness arbiter. New code's `ON CONFLICT` targets the composite index.
--
-- !! DEPLOY BANNER !! Between this migration applying and the app restart, OLD
-- code still runs `ON CONFLICT (key)` which references the constraint this file
-- removes → it will error (seconds-to-minutes of 500s on report create until the
-- new build is live). This is ACCEPTED for this pre-launch release (no real
-- users). Do NOT ship this file to a live-traffic environment without draining
-- first.
--
-- The PK constraint was auto-named by Postgres; it is discovered dynamically
-- (contype='p') and dropped by the found name rather than hardcoding
-- `idempotency_keys_pkey`. `key` is then pinned NOT NULL explicitly so the column
-- keeps its non-null guarantee independent of the PK-drop's version-specific
-- NOT-NULL retention behavior (matches the mirror, which keeps key .notNull()).
-- Idempotent: once the PK is gone the lookup finds nothing and the drop is skipped.
--
-- CANONICAL DDL: hand-authored source of truth. Mirror: schema/idempotency.ts
-- (key loses .primaryKey(), keeps .notNull()).
--
-- Conventions: one transaction per file (src/db/migrate.ts). Forward-only, no down.
--
-- Ordering rules: requires 0078_idempotency_owner_unique.sql.
-- =============================================================================

DO $$
DECLARE
  pk_name text;
BEGIN
  SELECT conname INTO pk_name FROM pg_constraint
    WHERE conrelid = 'idempotency_keys'::regclass AND contype = 'p';
  IF pk_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE idempotency_keys DROP CONSTRAINT %I', pk_name);
  END IF;

  ALTER TABLE idempotency_keys ALTER COLUMN key SET NOT NULL;
END $$;
