-- =============================================================================
-- 0000_extensions.sql
-- -----------------------------------------------------------------------------
-- Required Postgres extensions. This MUST run first: the geometry() columns in
-- 0001_core.sql depend on PostGIS, the gen_random_uuid() column defaults depend
-- on pgcrypto, and the CITEXT columns depend on citext.
--
-- This file is part of the CANONICAL, hand-authored DDL for civfix. The Drizzle
-- table definitions under src/db/schema mirror these tables for typed queries and
-- `drizzle-kit generate` diff inspection, but THIS SQL is the source of truth.
--
-- All statements are idempotent (IF NOT EXISTS), so re-applying is a no-op. The
-- migrate runner (src/db/migrate.ts) also guards each file with a bookkeeping row.
-- =============================================================================

-- PostGIS: geometry types, spatial operators, ST_* functions, GiST opclasses.
CREATE EXTENSION IF NOT EXISTS postgis;

-- pgcrypto: provides gen_random_uuid() used as the default for uuid primary keys.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- citext: case-insensitive text type used by users.handle and email columns.
CREATE EXTENSION IF NOT EXISTS citext;
