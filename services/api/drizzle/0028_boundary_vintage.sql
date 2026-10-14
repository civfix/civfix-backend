-- boundary_vintage: a single-row audit record of the jurisdiction-boundary dataset currently loaded into
-- the `jurisdictions` table, stamped by the local refresh tool (services/api/scripts/refresh-boundaries.ts)
-- after each successful nationwide load.
--
-- WHY. Real US boundaries (Census TIGER place/county/state + Census AIANNH tribal + USGS PAD-US federal)
-- are loaded on demand by running `pnpm db:boundaries:refresh` on a workstation (with GDAL) over an SSH
-- tunnel to prod Postgres: it downloads the public-domain sources, converts them with ogr2ogr, ingests
-- each layer (idempotent upsert), backfills NULL reports, then records WHAT was loaded (vintage + per-layer
-- counts + when) in this row. Purely informational: the load itself is idempotent and doesn't depend on it.
--
-- SINGLETON. `id` is a boolean PK pinned true (CHECK id), so there is at most one row = the one active
-- vintage. Upserts use `INSERT ... ON CONFLICT (id) DO UPDATE`.
CREATE TABLE IF NOT EXISTS boundary_vintage (
  id            boolean PRIMARY KEY DEFAULT true CHECK (id),
  -- The dataset identity, e.g. "tiger2025-padus4.1". Idempotency key shared with the R2 bundle + cron.
  vintage_tag   text NOT NULL,
  -- The TIGER/Line vintage year (Census places/counties/states + AIANNH share this annual vintage).
  tiger_vintage integer NOT NULL,
  -- The USGS PAD-US version loaded (released on its own cadence, not annual), e.g. "4.1".
  padus_version text NOT NULL,
  -- When this vintage finished loading (after ingest + backfill). Advisory.
  loaded_at     timestamptz NOT NULL DEFAULT now(),
  -- Per-layer upserted counts from the last load, e.g. {"states":56,"counties":3235,...}. Observability.
  row_counts    jsonb NOT NULL DEFAULT '{}'::jsonb
);
