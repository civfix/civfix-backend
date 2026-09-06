-- =============================================================================
-- 0123_cleanup_page_media.sql
-- -----------------------------------------------------------------------------
-- The explicit binding between an event and the media its signup page embeds
-- (W1.3, W3.4). One row per (event, asset) pair a page block references.
--
-- WHY THIS TABLE EXISTS AT ALL. `cleanup_pages.blocks` is a jsonb document
-- (0119) and the image ids inside it are the ONLY reference those assets have.
-- The media-worker orphan sweep runs hourly and deletes every `media_assets` row
-- that no binding points at, plus its R2 objects: an asset referenced only from
-- inside a jsonb block is indistinguishable from an abandoned upload, so the
-- page's imagery is reaped the first sweep after `created_at + orphanTtl`. The
-- sweep must be able to answer "is this asset bound?" with an indexed EXISTS on
-- a real relation - a jsonb containment scan over every page on every sweep is
-- not something the reaper may run. Hence a join table, written by `savePage`
-- from the block list it is already validating.
--
-- WHY (cleanup_id, media_id) IS THE PRIMARY KEY: the binding is a SET, not a
-- list. The same asset may appear in several blocks of one page (a sponsor logo
-- reused in the hero), and the reaper only ever asks whether at least one
-- reference exists. `savePage` rewrites the whole set on every save - delete the
-- rows the new block list dropped, insert the ones it added - which is why there
-- is no ordering or per-block column here: nothing joins to a block.
--
-- BOTH FKs CASCADE, and that is the point on the media side: when the reaper (or
-- an erasure) deletes a `media_assets` row for a legitimate reason, the binding
-- goes with it instead of dangling. The page block keeps the id and simply
-- renders no image, exactly as it does today for an id that never resolved.
--
-- `cleanup_page_media_media_idx` is what the sweep actually uses: it probes by
-- media_id, never by cleanup_id (the PK covers the page-side reads).
--
-- LOCK ORDER (binding on every writer): organizations -> organization_members
--   -> cleanups -> cleanup_members -> cleanup_guests -> cleanup_registrations
--   -> cleanup_registration_seats -> cleanup_answers -> cleanup_waitlist ->
--   cleanup_ticket_types -> cleanup_slots -> cleanup_slot_claims. cleanup_page_media is a leaf: the
--   only writer is `savePage`, which already holds `cleanups FOR SHARE`.
--
-- CANONICAL DDL: this file. Drizzle mirror: src/db/schema/cleanup_page_media.ts.
-- Conventions: CREATE TABLE / INDEX IF NOT EXISTS; one concern per file; one
-- transaction per file; non-CONCURRENTLY builds accepted (brand-new, empty
-- table). Forward-only, no down.
-- Ordering rules: requires 0001_core.sql (cleanups), 0016_user_verification.sql
-- (media_assets) and 0119_cleanup_pages.sql.
-- =============================================================================

CREATE TABLE IF NOT EXISTS cleanup_page_media (
  cleanup_id uuid        NOT NULL REFERENCES cleanups (id) ON DELETE CASCADE,
  media_id   uuid        NOT NULL REFERENCES media_assets (id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (cleanup_id, media_id)
);

CREATE INDEX IF NOT EXISTS cleanup_page_media_media_idx
  ON cleanup_page_media (media_id);

COMMENT ON TABLE cleanup_page_media IS
  'Explicit (event, media) binding for images embedded in cleanup_pages.blocks. Written by savePage; read by the media-worker orphan sweep and the media view authorizer so a page image is never reaped or served as an orphan.';
