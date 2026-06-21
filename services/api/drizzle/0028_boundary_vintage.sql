-- boundary_vintage: a single-row tracker for the active jurisdiction-boundary dataset currently loaded
-- into the `jurisdictions` table by the automated `jurisdiction.refresh` cron
-- (services/api/src/services/admin/boundary-refresh-jobs.ts).
--
-- WHY. Real US boundaries (Census TIGER place/county/state + Census AIANNH tribal + USGS PAD-US federal)
-- are too large to bake into the image, so a scheduled GitHub Actions workflow converts them to GeoJSON
-- and publishes a vintage-tagged bundle to R2 (boundaries/<tag>/...), flipping boundaries/current.json
-- last. The on-box cron reads current.json, compares the published `vintageTag` against THIS row, and is
-- a no-op when they match. It stamps this row ONLY after a full nationwide ingest + report backfill
-- succeeds, so a failed/partial refresh leaves the recorded vintage unchanged and the next tick retries.
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
