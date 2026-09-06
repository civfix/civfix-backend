-- =============================================================================
-- 0119_cleanup_pages.sql
-- -----------------------------------------------------------------------------
-- The public signup page (`/e/:slug`) behind one event (W1.3, W3.4).
--
-- WHY blocks IS jsonb AND NOT A CHILD TABLE: a page is EDITED AS A DOCUMENT. The
-- builder sends the whole ordered block list on every save, there is no
-- per-block API, nothing joins to a block, and no query ever filters by one. A
-- child table would buy an ordering column, a reconcile with sentinel sort values
-- and a multi-row transaction, and buy nothing back. The contract's discriminated
-- union (`EventPageBlockSchema`, 10 kinds) is the validator; the CHECK below is
-- the length backstop only.
--
-- TEXT INSIDE A BLOCK IS THE CONSTRAINED MARKDOWN SUBSET parsed by
-- `@civfix/shared/markdown` (paragraph / strong / em / https-only link / list).
-- The page service PARSES every text field on save to validate it; no HTML ever
-- crosses the wire in either direction, so there is no sanitizer to get wrong.
--
-- THE SLUG DOES NOT LIVE HERE. It is `cleanups.page_slug` (citext, partial
-- unique), because the slug is a property of the EVENT's public identity - the
-- ICS feed, the OG preview and the share link all resolve it without reading a
-- page row, and a page that has never been created must not make the URL
-- unavailable. `checkEventPageSlug` and `saveEventPage` both write that column.
--
-- VISIBILITY IS ALSO NOT HERE: the page inherits `cleanups.visibility`. A page
-- published on a private event is reachable only by the team (404 to everyone
-- else, never 403 - a 403 confirms the slug exists); on an unlisted event it is
-- reachable but served `noindex`. Status here is only the host's own draft /
-- published / unpublished lever.
--
-- view_count is a denormalized counter owned by the metrics lane
-- (`recordEventPageView`), not by this service; it is deliberately a bigint and
-- deliberately carries no per-visitor anything. Referrers are classified into a
-- closed bucket set and discarded, never stored.
--
-- flagged_at / flagged_by / flag_reason are the operator moderation lever
-- (admin plane). A flagged page serves as unpublished to the public.
--
-- LOCK ORDER: pages are a leaf - nothing else references them, and the page
-- writer takes `cleanups FOR SHARE` first like every other writer.
--
-- CANONICAL DDL: this file. Drizzle mirror: src/db/schema/cleanup_pages.ts.
-- Ordering rules: requires 0001 (cleanups, users) and 0105-0114 (cleanups.page_slug).
-- =============================================================================

CREATE TABLE IF NOT EXISTS cleanup_pages (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  cleanup_id   uuid        NOT NULL REFERENCES cleanups (id) ON DELETE CASCADE,
  status       text        NOT NULL DEFAULT 'draft',
  theme_accent text        NOT NULL DEFAULT 'bloom',
  blocks       jsonb       NOT NULL DEFAULT '[]'::jsonb,
  seo          jsonb       NOT NULL DEFAULT '{}'::jsonb,
  published_at timestamptz,
  published_by uuid        REFERENCES users (id),
  flagged_at   timestamptz,
  flagged_by   uuid        REFERENCES users (id),
  flag_reason  text,
  view_count   bigint      NOT NULL DEFAULT 0,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE cleanup_pages DROP CONSTRAINT IF EXISTS cleanup_pages_status_check;
ALTER TABLE cleanup_pages ADD  CONSTRAINT cleanup_pages_status_check
  CHECK (status IN ('draft', 'published', 'unpublished'));

ALTER TABLE cleanup_pages DROP CONSTRAINT IF EXISTS cleanup_pages_accent_check;
ALTER TABLE cleanup_pages ADD  CONSTRAINT cleanup_pages_accent_check
  CHECK (theme_accent IN ('bloom', 'moss', 'sun', 'sky', 'lilac'));

-- MAX_EVENT_PAGE_BLOCKS = 24 in the contract. Backstop only.
ALTER TABLE cleanup_pages DROP CONSTRAINT IF EXISTS cleanup_pages_blocks_shape;
ALTER TABLE cleanup_pages ADD  CONSTRAINT cleanup_pages_blocks_shape
  CHECK (jsonb_typeof(blocks) = 'array' AND jsonb_array_length(blocks) <= 24);

ALTER TABLE cleanup_pages DROP CONSTRAINT IF EXISTS cleanup_pages_seo_shape;
ALTER TABLE cleanup_pages ADD  CONSTRAINT cleanup_pages_seo_shape
  CHECK (jsonb_typeof(seo) = 'object');

ALTER TABLE cleanup_pages DROP CONSTRAINT IF EXISTS cleanup_pages_view_count_nonneg;
ALTER TABLE cleanup_pages ADD  CONSTRAINT cleanup_pages_view_count_nonneg
  CHECK (view_count >= 0);

-- Exactly one page per event.
CREATE UNIQUE INDEX IF NOT EXISTS cleanup_pages_cleanup_uidx
  ON cleanup_pages (cleanup_id);

-- The operator moderation queue.
CREATE INDEX IF NOT EXISTS cleanup_pages_published_idx
  ON cleanup_pages (published_at DESC, id DESC)
  WHERE status = 'published';

CREATE INDEX IF NOT EXISTS cleanup_pages_flagged_idx
  ON cleanup_pages (flagged_at DESC, id DESC)
  WHERE flagged_at IS NOT NULL;

COMMENT ON TABLE cleanup_pages IS
  'One signup page per event, edited as a jsonb block document. The slug lives on cleanups.page_slug; visibility is inherited from cleanups.visibility.';
COMMENT ON COLUMN cleanup_pages.view_count IS
  'Denormalized counter owned by the metrics lane (recordEventPageView). No per-visitor data is stored anywhere.';
