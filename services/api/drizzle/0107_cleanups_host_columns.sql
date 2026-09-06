-- =============================================================================
-- 0107_cleanups_host_columns.sql
-- -----------------------------------------------------------------------------
-- The host-platform columns an event carries beyond its civic core (W1.3). All
-- additive on `cleanups`; nothing existing changes shape.
--
--   ends_at, timezone          an event had a start instant and nothing else, so
--                              "when does this finish" and "in which wall clock"
--                              were guesses. timezone is an IANA name validated in
--                              the service against the runtime's own zone list.
--   visibility                 public | unlisted | private. The list and map feeds
--                              show public only; an unlisted event is reachable by
--                              its link, a private one only by its team. 404, never
--                              403, for a non-member - the endpoint must not be an
--                              existence oracle.
--   cover_media_id,            event imagery. Claimed on commit with purposes
--   gallery_media_ids          event_cover / event_gallery (0110), so an upload id
--                              can never be re-bound out of a private DM into a
--                              public event page. The gallery is an array, not a
--                              child table: it is an ordered, capped document the
--                              host edits as a whole.
--   donation_url               an outbound link, write-gated in the service to
--                              organizations verified as nonprofits and re-checked
--                              at read. https only.
--   page_slug                  the public signup page segment (/e/:slug). Unique
--                              among rows that have one; reserved words rejected in
--                              the service.
--   registration_opens_at,     the registration window, independent of the event's
--   registration_closes_at     own schedule.
--   organization_id            the owning organization, SET NULL so deleting an org
--                              never deletes a published civic event.
--   reminder_offsets_min       at most three offsets from a closed set, consumed by
--                              the reminder lane.
--   host_reply_to,             the address attendee replies go to. Stored unverified;
--   host_reply_to_verified_at  nothing sends from it until the verification flow
--                              stamps the second column.
--
-- CHECKs land NOT VALID: `cleanups` already holds live rows, and a validating
-- ADD CONSTRAINT takes ACCESS EXCLUSIVE for a full scan inside the deploy's single
-- migration transaction. Every new row is checked from the moment the constraint
-- exists (that is what NOT VALID means - it skips the back-scan, not the guard), and
-- the columns are all new, so the unscanned rows are exactly the ones holding NULL /
-- the default. VALIDATE CONSTRAINT is deferred to a later release, out of band.
--
-- `cleanups` is NOT one of the hot tables (users, reports, chat_messages,
-- dm_messages, media_assets, notifications, sessions): it is one row per community
-- event, so the index builds below are plain, non-CONCURRENTLY builds.
--
-- CANONICAL DDL: hand-authored source of truth. Mirror: schema/cleanups.ts.
--
-- Conventions: additive ADD COLUMN IF NOT EXISTS; one concern per file; one
-- transaction per file. Forward-only, no down.
--
-- LOCK ORDER (binding on every writer): organizations -> organization_members
--   -> cleanups -> cleanup_members -> cleanup_guests -> cleanup_registrations
--   -> cleanup_registration_seats -> cleanup_answers -> cleanup_waitlist ->
--   cleanup_ticket_types -> cleanup_slots -> cleanup_slot_claims
--
-- Ordering rules: requires 0001_core.sql (cleanups), 0016_user_verification.sql
-- (media_assets) and 0105_organizations.sql.
-- =============================================================================

ALTER TABLE cleanups ADD COLUMN IF NOT EXISTS ends_at timestamptz;
ALTER TABLE cleanups ADD COLUMN IF NOT EXISTS timezone text;
ALTER TABLE cleanups ADD COLUMN IF NOT EXISTS visibility text NOT NULL DEFAULT 'public';
ALTER TABLE cleanups ADD COLUMN IF NOT EXISTS cover_media_id uuid
  REFERENCES media_assets(id) ON DELETE SET NULL;
ALTER TABLE cleanups ADD COLUMN IF NOT EXISTS gallery_media_ids uuid[] NOT NULL DEFAULT '{}';
ALTER TABLE cleanups ADD COLUMN IF NOT EXISTS donation_url text;
ALTER TABLE cleanups ADD COLUMN IF NOT EXISTS page_slug citext;
ALTER TABLE cleanups ADD COLUMN IF NOT EXISTS registration_opens_at timestamptz;
ALTER TABLE cleanups ADD COLUMN IF NOT EXISTS registration_closes_at timestamptz;
ALTER TABLE cleanups ADD COLUMN IF NOT EXISTS organization_id uuid
  REFERENCES organizations(id) ON DELETE SET NULL;
ALTER TABLE cleanups ADD COLUMN IF NOT EXISTS reminder_offsets_min integer[];
ALTER TABLE cleanups ADD COLUMN IF NOT EXISTS host_reply_to citext;
ALTER TABLE cleanups ADD COLUMN IF NOT EXISTS host_reply_to_verified_at timestamptz;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'cleanups_visibility_chk' AND conrelid = 'cleanups'::regclass
  ) THEN
    ALTER TABLE cleanups
      ADD CONSTRAINT cleanups_visibility_chk
      CHECK (visibility IN ('public', 'unlisted', 'private')) NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'cleanups_ends_after_start_chk' AND conrelid = 'cleanups'::regclass
  ) THEN
    ALTER TABLE cleanups
      ADD CONSTRAINT cleanups_ends_after_start_chk
      CHECK (ends_at IS NULL OR ends_at > scheduled_at) NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'cleanups_registration_window_chk' AND conrelid = 'cleanups'::regclass
  ) THEN
    ALTER TABLE cleanups
      ADD CONSTRAINT cleanups_registration_window_chk
      CHECK (
        registration_opens_at IS NULL
        OR registration_closes_at IS NULL
        OR registration_closes_at > registration_opens_at
      ) NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'cleanups_gallery_size_chk' AND conrelid = 'cleanups'::regclass
  ) THEN
    ALTER TABLE cleanups
      ADD CONSTRAINT cleanups_gallery_size_chk
      CHECK (cardinality(gallery_media_ids) <= 12) NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'cleanups_reminder_offsets_chk' AND conrelid = 'cleanups'::regclass
  ) THEN
    ALTER TABLE cleanups
      ADD CONSTRAINT cleanups_reminder_offsets_chk
      CHECK (
        reminder_offsets_min IS NULL
        OR (
          cardinality(reminder_offsets_min) <= 3
          AND reminder_offsets_min <@ ARRAY[60, 180, 1440, 2880, 10080]
        )
      ) NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'cleanups_donation_url_https_chk' AND conrelid = 'cleanups'::regclass
  ) THEN
    ALTER TABLE cleanups
      ADD CONSTRAINT cleanups_donation_url_https_chk
      CHECK (donation_url IS NULL OR donation_url LIKE 'https://%') NOT VALID;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS cleanups_page_slug_uidx
  ON cleanups (page_slug)
  WHERE page_slug IS NOT NULL;

CREATE INDEX IF NOT EXISTS cleanups_organization_scheduled_idx
  ON cleanups (organization_id, scheduled_at DESC, id DESC)
  WHERE organization_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS cleanups_public_scheduled_idx
  ON cleanups (scheduled_at, id)
  WHERE visibility = 'public';

CREATE INDEX IF NOT EXISTS cleanups_cover_media_idx
  ON cleanups (cover_media_id)
  WHERE cover_media_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS cleanups_gallery_media_gin_idx
  ON cleanups USING gin (gallery_media_ids);

COMMENT ON COLUMN cleanups.visibility IS
  'public | unlisted | private. List/map feeds show public only; a non-member of an unlisted or private event gets 404, never 403.';
COMMENT ON COLUMN cleanups.donation_url IS
  'Outbound https donation link. Writable only while the owning organization is a verified nonprofit, and re-checked on read.';
COMMENT ON COLUMN cleanups.host_reply_to IS
  'Stored unverified. host_reply_to_verified_at is stamped by the reply-to verification flow; nothing is sent from this address until it is.';
COMMENT ON INDEX cleanups_public_scheduled_idx IS
  'Index support for the visibility-filtered list/map feeds added with this column.';
