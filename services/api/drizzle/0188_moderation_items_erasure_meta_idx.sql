-- =============================================================================
-- 0188_moderation_items_erasure_meta_idx.sql
-- -----------------------------------------------------------------------------
-- Account erasure scrubs the user's identity out of moderation snapshots with
-- two statements keyed on jsonb paths:
--
--   UPDATE moderation_items ... WHERE meta->'user'->>'id' = $1
--   UPDATE moderation_items ... WHERE meta->>'reporterUserId' = $1
--
-- Neither expression was indexed, so each was a sequential scan of
-- moderation_items inside the erasure transaction. A strict `expr = $1`
-- implies `expr IS NOT NULL`, so these partial expression indexes serve the
-- unchanged statements; rows that carry no user id (backfills store
-- 'user': null) stay out of the index. The indexed ids already live in the
-- rows and survive the scrub, so this adds no PII or retention surface.
--
-- NOT A HOT TABLE: `moderation_items` is absent from the hot-table list in
-- docs/out-of-band-indexes.md, so this builds inline. If it has grown large by
-- the time this deploys, build it with CREATE INDEX CONCURRENTLY first and the
-- IF NOT EXISTS guard turns this into a no-op.
--
-- CANONICAL DDL: hand-authored source of truth. Mirror: schema/moderation_items.ts.
--
-- Conventions: one concern per file; one transaction per file. Forward-only,
-- no down.
--
-- Ordering rules: requires 0007_admin_phase2.sql (moderation_items).
-- =============================================================================

CREATE INDEX IF NOT EXISTS moderation_items_meta_user_id_idx
  ON moderation_items ((meta -> 'user' ->> 'id'))
  WHERE (meta -> 'user' ->> 'id') IS NOT NULL;

CREATE INDEX IF NOT EXISTS moderation_items_meta_reporter_user_id_idx
  ON moderation_items ((meta ->> 'reporterUserId'))
  WHERE (meta ->> 'reporterUserId') IS NOT NULL;
