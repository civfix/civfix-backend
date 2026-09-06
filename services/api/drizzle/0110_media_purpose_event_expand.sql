-- =============================================================================
-- 0110_media_purpose_event_expand.sql
-- -----------------------------------------------------------------------------
-- Widen media_assets.purpose for the host platform: an event now carries a cover
-- image and a small gallery, and an organization carries a logo. Three new values:
-- 'event_cover', 'event_gallery', 'org_logo'.
--
-- EXPAND / CONTRACT, step 1 of 2. 0054 replaced the inline CHECK with the named
-- `media_assets_purpose_check`; media_assets IS a hot table, so swapping that
-- constraint in one statement would take ACCESS EXCLUSIVE for a full validating
-- scan of every asset row inside the deploy's migration transaction. Instead:
--
--   this file (release N)   ADD CONSTRAINT media_assets_purpose_expanded ... NOT VALID
--                           - catalog-only, no scan. From this instant every INSERT
--                             and UPDATE is checked against the SUPERSET.
--   0111 (release N)        DROP the old three-value constraint, once the superset
--                           one is in place, so the new purposes can actually be
--                           written.
--   a later release         VALIDATE CONSTRAINT media_assets_purpose_expanded, out
--                           of band (SHARE UPDATE EXCLUSIVE, concurrent-safe).
--                           Deferred deliberately: the scan is the expensive half
--                           and it guards only rows that predate this migration,
--                           every one of which already satisfies the superset.
--
-- Paired code change: media-authorization.ts gives the two event purposes the
-- visibility of their event (public event -> public CDN URL; unlisted or private ->
-- signed, short-lived) and org_logo the public treatment of an avatar. 'verification'
-- stays denied on the public media path for every caller.
--
-- CANONICAL DDL: hand-authored source of truth. Mirror: schema/types-host.ts
-- (MEDIA_PURPOSE_VALUES), asserted byte-for-byte against the shared enum by
-- test/unit/enums.test.ts.
--
-- Conventions: guarded ADD CONSTRAINT (idempotent); one concern per file; one
-- transaction per file. Forward-only, no down.
--
-- Ordering rules: requires 0016_user_verification.sql (the purpose column) and
-- 0054_media_purpose_post.sql (the constraint being superseded).
-- =============================================================================

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'media_assets_purpose_expanded' AND conrelid = 'media_assets'::regclass
  ) THEN
    ALTER TABLE media_assets
      ADD CONSTRAINT media_assets_purpose_expanded
      CHECK (
        purpose IN (
          'report', 'verification', 'post', 'event_cover', 'event_gallery', 'org_logo'
        )
      ) NOT VALID;
  END IF;
END $$;
