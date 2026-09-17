-- =============================================================================
-- 0175_address_resolution.sql
-- -----------------------------------------------------------------------------
-- The address-resolution overhaul. Three concerns, one theme: a pin now yields a
-- HONEST address line, and every stored address carries where it came from.
--
--   1. `geocode_cache` (new). Reverse geocodes are stable per point, and the
--      same point is resolved several times over one creation flow (the client
--      previews it while the pin settles, then the create path resolves it
--      again server-side). This read-through cache collapses all of that onto
--      one row keyed by the SHARED 5-decimal point key
--      (@civfix/shared `geocodePointKey`, ~1.1 m), which is also the key the
--      client rounds its preview query on -- so a pin fine-tune hits one row
--      rather than minting a new provider call per micro-drag.
--
--      TTLs are enforced in SQL-adjacent code (services/geocode-cache.ts), not
--      by a cron: a row past its TTL is simply read as a MISS and overwritten by
--      the fresh resolve. 180 days for a resolved address; 15 minutes when the
--      resolve produced nothing. The short negative TTL is the compromise the
--      design spec asks for from both ends: caching nulls at all is what stops a
--      dragged pin from hammering a provider that is currently down, and
--      expiring them in minutes is what stops a provider OUTAGE from poisoning
--      those points for half a year.
--
--      DEVIATION from the design spec's sketch, deliberate: the column is
--      `address_precision`, not `precision` (`precision` is a Postgres keyword;
--      non-reserved, so it would parse, but this table is read by hand during
--      incidents and there is no upside to the ambiguity), and `address` /
--      `address_precision` are NULLABLE to carry a negative entry.
--
--      NOT user data. Every row is a public coordinate -> public address line,
--      derived from a third-party geocoder. It holds no reference to the user,
--      report or event that caused the lookup, so it is outside the erasure lane
--      by construction (docs/erasure-behavior.md).
--
--   2. `cleanups.address_source`. Events were NEVER reverse-geocoded: the column
--      held whatever the host typed into "name the spot", or NULL. New clients
--      now confirm a resolved line, so the column needs provenance --
--      'resolved' (shown to the host unchanged), 'edited' (host amended the
--      resolved line) or 'manual' (host typed it because resolution failed or
--      was locality-grade). Backfilled to 'manual' for every existing event that
--      has an address, which is the closest truth: a host typed it.
--
--   3. `reports.addr_source` + `reports.addr_precision`. Reports already
--      snapshot an address at creation, either the reporter's own text or the
--      server's reverse geocode, and nothing recorded WHICH. 'user' vs
--      'resolved' plus the precision rung the geocoder actually reached lets the
--      display layer be honest (a `landmark` line renders with a "Near " prefix
--      instead of posing as a postal address) and leaves a future
--      location-coarsening policy implementable as a display rule
--      (docs/location-coarsening-assessment.md) rather than a re-geocode.
--
-- NO NEW INDEX ON A HOT TABLE. `reports` IS on the hot-table list in
-- docs/out-of-band-indexes.md; both of its new columns are plain row columns
-- read only alongside the row itself, so nothing here needs an index. The one
-- index created below is on `geocode_cache`, a table this file creates empty.
--
-- CHECK constraints are added NOT VALID (`reports` is hot; `cleanups` follows
-- the same shape for consistency, as 0170 did). Every existing row has NULL in
-- these columns -- the columns are created by this file -- so each constraint
-- holds by construction from the instant it exists, and every INSERT/UPDATE is
-- checked from now on.
--
-- STILL OUTSTANDING (a later release, out of band, SHARE UPDATE EXCLUSIVE):
--   ALTER TABLE cleanups VALIDATE CONSTRAINT cleanups_address_source_chk;
--   ALTER TABLE reports  VALIDATE CONSTRAINT reports_addr_source_chk;
--   ALTER TABLE reports  VALIDATE CONSTRAINT reports_addr_precision_chk;
--
-- CANONICAL DDL: hand-authored source of truth. Mirrors: schema/geocode_cache.ts
-- (new), schema/cleanups.ts, schema/reports.ts. Enum mirrors: shared
-- AddressPrecisionSchema / EventAddressSourceSchema / ReportAddressSourceSchema.
--
-- Conventions: additive ADD COLUMN IF NOT EXISTS; one concern per file; one
-- transaction per file. Forward-only, no down.
--
-- Ordering rules: requires 0001_core.sql (reports, cleanups).
-- =============================================================================

CREATE TABLE IF NOT EXISTS geocode_cache (
  point_key text PRIMARY KEY,
  address text,
  address_precision text,
  city_state_label text NOT NULL DEFAULT '',
  provider text,
  resolved_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE geocode_cache IS
  'Read-through cache of reverse geocodes, keyed by the shared 5-decimal point key (@civfix/shared geocodePointKey). Derived public data only - no user, report or event reference. Rows past their TTL are read as misses and overwritten in place; see services/geocode-cache.ts.';

COMMENT ON COLUMN geocode_cache.address IS
  'The resolved one-line address, or NULL for a negative entry (the providers returned nothing). A landmark line is stored RAW - the "Near " prefix is a localized display concern.';

COMMENT ON COLUMN geocode_cache.address_precision IS
  'How far down the ladder the resolve got: street | intersection | landmark | locality. NULL on a negative entry. Named address_precision, not precision, to keep the column unambiguous in hand-written incident queries.';

COMMENT ON COLUMN geocode_cache.provider IS
  'Which adapter answered: mapbox | photon | tiger. NULL on a negative entry. Diagnostics only - never served to a client.';

CREATE INDEX IF NOT EXISTS geocode_cache_resolved_at_idx ON geocode_cache (resolved_at);

ALTER TABLE cleanups ADD COLUMN IF NOT EXISTS address_source text;

COMMENT ON COLUMN cleanups.address_source IS
  'Provenance of cleanups.address: resolved (host confirmed the reverse-geocoded line) | edited (host amended it) | manual (host typed it). NULL only for legacy rows with no address at all.';

ALTER TABLE reports ADD COLUMN IF NOT EXISTS addr_source text;
ALTER TABLE reports ADD COLUMN IF NOT EXISTS addr_precision text;

COMMENT ON COLUMN reports.addr_source IS
  'Provenance of reports.addr: user (the reporter typed it) | resolved (the server reverse-geocoded the pin at creation). NULL for legacy rows and for reports with no address.';

COMMENT ON COLUMN reports.addr_precision IS
  'Ladder rung the geocoder reached for a resolved addr: street | intersection | landmark | locality. Always NULL when addr_source is user - the reporter''s own text carries no provider precision.';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'cleanups_address_source_chk' AND conrelid = 'cleanups'::regclass
  ) THEN
    ALTER TABLE cleanups
      ADD CONSTRAINT cleanups_address_source_chk
      CHECK (address_source IS NULL OR address_source IN ('resolved', 'edited', 'manual')) NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'reports_addr_source_chk' AND conrelid = 'reports'::regclass
  ) THEN
    ALTER TABLE reports
      ADD CONSTRAINT reports_addr_source_chk
      CHECK (addr_source IS NULL OR addr_source IN ('user', 'resolved')) NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'reports_addr_precision_chk' AND conrelid = 'reports'::regclass
  ) THEN
    ALTER TABLE reports
      ADD CONSTRAINT reports_addr_precision_chk
      CHECK (
        addr_precision IS NULL
        OR addr_precision IN ('street', 'intersection', 'landmark', 'locality')
      ) NOT VALID;
  END IF;
END $$;

-- Backfill, inline and deliberately: `cleanups` is small (one row per event, not
-- per interaction) and is absent from the hot-table list, so this single UPDATE
-- inside the runner's transaction is not the lock hazard the same statement
-- would be on `reports` or `posts`. Idempotent via the IS NULL predicate.
--
-- Existing events with address IS NULL get NOTHING here on purpose: host
-- verification is the whole feature, and the server cannot verify on a host's
-- behalf. Those events keep the client's "Meeting point" fallback and the host
-- is nudged to add one. Likewise `reports.addr_source` is NOT backfilled - for a
-- legacy row there is no way to tell the reporter's text from the server's
-- snapshot, and guessing would be worse than NULL.
UPDATE cleanups SET address_source = 'manual' WHERE address IS NOT NULL AND address_source IS NULL;
