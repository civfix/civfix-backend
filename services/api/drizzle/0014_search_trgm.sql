-- =============================================================================
-- 0014_search_trgm.sql
-- -----------------------------------------------------------------------------
-- Trigram (pg_trgm) GIN indexes that make the leading-/infix-wildcard ILIKE
-- searches across the admin console and social typeahead index-assisted instead
-- of per-keystroke Seq Scans. Today only postgis / pgcrypto / citext are
-- installed (0000_extensions.sql), so this file FIRST enables pg_trgm, then
-- builds the GIN indexes that depend on the gin_trgm_ops opclass.
--
-- WHY pg_trgm (vs a btree text_pattern_ops index): the searched predicates are
-- INFIX `ILIKE '%term%'` (admin reports/users/events, people directory) which no
-- btree can serve, and the @handle typeahead uses `handle ILIKE 'prefix%'` on a
-- CITEXT column whose unique btree cannot help an ILIKE. A trigram GIN serves all
-- of these WITHOUT any change to the (separately-owned) query text.
--
-- TRANSACTION NOTE: the runner wraps each file in ONE transaction, so no CREATE
-- INDEX CONCURRENTLY; plain CREATE INDEX IF NOT EXISTS is used throughout. The
-- CREATE EXTENSION must precede the GIN indexes IN THIS SAME file.
--
-- SCOPE: these are scale-headroom indexes for searched text columns; each finding
-- (7, 8, 16, 17, 18, 19) was verified against a real ILIKE query in src/services.
-- gin_trgm_ops works on text; for the CITEXT users.handle column we cast to text
-- in the index expression so the opclass applies (ILIKE folds case anyway).
--
-- Ordering rules:
--   * Requires 0001_core.sql (users, reports, jurisdictions, cleanups) and
--     0007_admin_phase2.sql (mail_threads).
-- =============================================================================

-- Enable trigram matching + the gin_trgm_ops GIN opclass. Idempotent.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- -----------------------------------------------------------------------------
-- users.handle + users.display_name  (findings 16, 17, 19 — handle; 7, 8 — both)
-- -----------------------------------------------------------------------------
-- @handle typeahead: `(handle::text) ILIKE 'prefix%'` (social-repository.drizzle.ts searchByHandlePrefix).
-- People directory + admin reports/events/users search: infix `ILIKE '%term%'` on
-- handle and display_name (social-repository.drizzle.ts, admin-report/-event/-user-repository).
-- handle is CITEXT, and gin_trgm_ops has no citext operator class, so this is an EXPRESSION index on
-- (handle::text). For the planner to USE it, the consuming queries must filter on the SAME expression —
-- so every handle search above was updated to `(u.handle::text) ILIKE ...` (a bare `handle ILIKE` would
-- not match the index and, when OR'd with other branches, would force a seq scan for the whole predicate).
-- ILIKE is case-insensitive on text, so the cast does not change which rows match. display_name is plain
-- text and uses users_display_name_trgm directly (no cast needed). Worth an EXPLAIN check at real scale.
CREATE INDEX IF NOT EXISTS users_handle_trgm
  ON users USING gin ((handle::text) gin_trgm_ops);
CREATE INDEX IF NOT EXISTS users_display_name_trgm
  ON users USING gin (display_name gin_trgm_ops);

-- -----------------------------------------------------------------------------
-- reports.title  (finding 8)
-- -----------------------------------------------------------------------------
-- Admin reports list search: `r.title ILIKE '%term%'`.
--   admin-report-repository.drizzle.ts:159.
CREATE INDEX IF NOT EXISTS reports_title_trgm
  ON reports USING gin (title gin_trgm_ops);

-- -----------------------------------------------------------------------------
-- jurisdictions.name  (finding 8)
-- -----------------------------------------------------------------------------
-- Admin reports list search joins jurisdictions and matches `j.name ILIKE '%term%'`.
--   admin-report-repository.drizzle.ts:160.
CREATE INDEX IF NOT EXISTS jurisdictions_name_trgm
  ON jurisdictions USING gin (name gin_trgm_ops);

-- -----------------------------------------------------------------------------
-- cleanups.title + cleanups.address  (finding 7)
-- -----------------------------------------------------------------------------
-- Admin event list q-search: `cleanups.title ILIKE '%term%'` and
-- `cleanups.address ILIKE '%term%'`.
--   admin-event-repository.drizzle.ts:179-185.
CREATE INDEX IF NOT EXISTS cleanups_title_trgm
  ON cleanups USING gin (title gin_trgm_ops);
CREATE INDEX IF NOT EXISTS cleanups_address_trgm
  ON cleanups USING gin (address gin_trgm_ops);

-- -----------------------------------------------------------------------------
-- mail_threads.org + mail_threads.subject  (finding 18)
-- -----------------------------------------------------------------------------
-- Inbox thread search: `t.org ILIKE '%q%' OR t.subject ILIKE '%q%'`. (The third
-- search column, latest-message from_addr, is reached through a per-row LATERAL
-- and is intentionally NOT indexed here — it would require denormalizing the
-- latest from_addr onto mail_threads; left as-is per finding 18.)
--   mail-repository.drizzle.ts:542.
CREATE INDEX IF NOT EXISTS mail_threads_org_trgm
  ON mail_threads USING gin (org gin_trgm_ops);
CREATE INDEX IF NOT EXISTS mail_threads_subject_trgm
  ON mail_threads USING gin (subject gin_trgm_ops);
