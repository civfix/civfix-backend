/**
 * Ingest CLI: load REAL jurisdiction boundaries from an external GeoJSON FeatureCollection into the
 * `jurisdictions` table. This is the production path for loading full-fidelity federal / tribal land
 * boundaries (and could equally load TIGER place/county/state) at scale - the curated dev set in
 * data/federal-lands.ts is just a small offline sample of what this ingests.
 *
 *   pnpm db:ingest <path/to/boundaries.geojson> [layer] [geoid-prefix]
 *
 * `layer` (default "federal") is the fallback jurisdiction layer for features whose properties do not
 * carry one; pass "tribal" for a reservations export, etc.
 *
 * Prefix rule (the optional third arg `geoid-prefix`)
 * --------------------------------------------------
 * Census TIGER geoids are FIPS-hierarchical: the leading 2 chars of a place/county/state GEOID ARE the
 * state FIPS, which the TIGER geocoder exploits as a shortcut (uspsFromGeoid -> "City, ST" without a
 * second spatial round-trip; see geocoder.tiger.ts:152-155). That shortcut is ONLY safe when the geoid
 * really is a Census FIPS id. Two non-FIPS layers break it:
 *   - AIANNH (tribal) geoids are 5 chars (AIANNHCE + comptype) and can be NUMERICALLY EQUAL to a 5-char
 *     county GEOID — a primary-key collision on jurisdictions.geoid AND a wrong-state FIPS shortcut.
 *   - PAD-US (federal) OBJECTIDs are arbitrary integers whose first 2 digits can be a valid-but-WRONG
 *     state FIPS, so trusting the prefix would mislabel the state.
 * The fix is to namespace those layers at load time: pass "AIANNH-" for an AIANNH/tribal export and
 * "PADUS-" for a PAD-US/federal export. An alpha-prefixed geoid (a) is globally unique so it can never
 * collide with a numeric county PK, and (b) makes uspsFromGeoid() return null, so the geocoder correctly
 * falls back to the authoritative spatial state query instead of trusting a bogus FIPS prefix. TIGER
 * place/county/state ingests pass NO prefix and keep their raw Census GEOID (the FIPS shortcut stays
 * valid). Curated dev federal data already carries alpha prefixes (NPS-/USFS-/BIA-) and is NOT
 * re-prefixed.
 *
 * Prefixing happens ONLY here, in normalizeFeatures — NEVER at ogr2ogr conversion time (the boundary-prep
 * manifest keeps the raw census ids). Applying it in exactly one place makes a double-prefix impossible,
 * and because the prefix is deterministic, re-ingesting the SAME source with the SAME prefix is idempotent
 * via ON CONFLICT (geoid) (the geoid is byte-identical on the re-run). normalizeFeatures stays PURE: it
 * does not trim the prefix or guard against an operator passing it twice — that is operator discipline,
 * documented in the runbook.
 *
 * Real, public-domain sources:
 *   - NPS unit boundaries (National Parks/Monuments/etc.):
 *       https://public-nps.opendata.arcgis.com/datasets/nps-boundary    (download as GeoJSON)
 *       properties: UNIT_CODE (geoid), UNIT_NAME (name).
 *   - USGS PAD-US (Protected Areas DB) - federal/state ownership polygons:
 *       https://www.usgs.gov/programs/gap-analysis-project/science/pad-us-data-download
 *   - BIA American Indian Reservations (tribal):
 *       https://biamaps.geoplatform.gov/   (export the "American Indian Reservations" layer as GeoJSON).
 *
 * Each feature becomes one jurisdiction row. geoid / name / layer / population are read from properties
 * (with the common key fallbacks below); the geometry is ingested via ST_GeomFromGeoJSON (Polygon OR
 * MultiPolygon, promoted to MultiPolygon(4326)). Upsert by geoid REFRESHES the boundary/name/population
 * but PRESERVES operator-mapped routing (contact_emails / report_form_url / notes / flags are never
 * touched). Requires DATABASE_URL + live Postgres/PostGIS; not exercised by the offline unit suite.
 */

import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import type { Queryable, Sql } from "./client.js"
import { makeDb } from "./client.js"
import { loadEnv } from "../env.js"

/** A loosely-typed GeoJSON feature (we only read `properties` + `geometry`). */
interface GeoJsonFeature {
  type: "Feature"
  properties: Record<string, unknown> | null
  geometry: { type: string; coordinates: unknown } | null
}
interface GeoJsonFeatureCollection {
  type: "FeatureCollection"
  features: GeoJsonFeature[]
}

/** One normalized jurisdiction to upsert. */
export interface IngestRow {
  geoid: string
  name: string
  layer: "federal" | "tribal" | "place" | "county" | "state"
  population: number | null
  geometry: { type: string; coordinates: unknown }
}

/** Read a string property under any of `keys` (first non-empty wins), else null. */
function pickString(props: Record<string, unknown> | null, keys: string[]): string | null {
  if (!props) return null
  for (const k of keys) {
    const v = props[k]
    if (typeof v === "string" && v.trim() !== "") return v.trim()
    if (typeof v === "number" && Number.isFinite(v)) return String(v)
  }
  return null
}

/** Read a numeric property under any of `keys`, else null. */
function pickNumber(props: Record<string, unknown> | null, keys: string[]): number | null {
  if (!props) return null
  for (const k of keys) {
    const v = props[k]
    if (typeof v === "number" && Number.isFinite(v)) return v
    if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v)
  }
  return null
}

const LAYER_RANK: Record<IngestRow["layer"], number> = {
  federal: -2,
  tribal: -1,
  place: 0,
  county: 1,
  state: 2,
}

/**
 * Normalize a GeoJSON FeatureCollection into IngestRow[]. Features missing a geoid, name, or polygon
 * geometry are dropped (their geoids are returned in `skipped` for logging). `defaultLayer` fills in
 * features whose properties carry no layer/owner type.
 *
 * `geoidPrefix` (optional) is the load-time geoid namespace described in the file header. When it is a
 * non-empty string it is prepended to the geoid read from the feature's properties, BEFORE the null/skip
 * check, so the prefixed value flows into both the skip decision and the pushed row (an AIANNH/tribal
 * export uses "AIANNH-", a PAD-US/federal export uses "PADUS-"). An empty/undefined prefix is a no-op, so
 * existing callers (TIGER place/county/state, curated dev data) keep their raw geoids unchanged. This
 * function stays PURE: it does not trim the prefix or detect a double application — the CLI main() owns
 * arg parsing/trimming, and not re-prefixing already-prefixed data is operator discipline (file header).
 */
export function normalizeFeatures(
  fc: GeoJsonFeatureCollection,
  defaultLayer: IngestRow["layer"],
  geoidPrefix?: string,
): { rows: IngestRow[]; skipped: number } {
  const rows: IngestRow[] = []
  let skipped = 0
  for (const f of fc.features ?? []) {
    const geometry = f.geometry
    const isPolygon =
      geometry !== null && (geometry.type === "Polygon" || geometry.type === "MultiPolygon")
    const geoid = pickString(f.properties, ["geoid", "GEOID", "UNIT_CODE", "unit_code", "id", "OBJECTID"])
    // Apply the load-time prefix to the picked geoid (only when both a geoid and a non-empty prefix are
    // present). Prefixing here — the single place a geoid is computed — guarantees it happens exactly once.
    const prefixedGeoid = geoid !== null && geoidPrefix ? geoidPrefix + geoid : geoid
    const name = pickString(f.properties, ["name", "NAME", "UNIT_NAME", "unit_name", "Unit_Name"])
    const rawLayer = pickString(f.properties, ["layer", "LAYER", "owner_type", "Own_Type"])
    const layer =
      rawLayer && rawLayer.toLowerCase() in LAYER_RANK
        ? (rawLayer.toLowerCase() as IngestRow["layer"])
        : defaultLayer
    if (!isPolygon || prefixedGeoid === null || name === null) {
      skipped += 1
      continue
    }
    rows.push({
      geoid: prefixedGeoid,
      name,
      layer,
      population: pickNumber(f.properties, ["population", "POPULATION", "POP", "pop"]),
      geometry,
    })
  }
  return { rows, skipped }
}

/**
 * Upsert one normalized row. Refreshes name/layer/priority/geom/population by geoid; PRESERVES the
 * routing columns (contact_emails / report_form_url / notes / flagged_at) so re-ingesting authoritative
 * boundaries never wipes operator-mapped contacts. Returns true on insert/update.
 *
 * Accepts `Queryable` (Sql | TransactionSql) so the caller can run a whole ingest under one
 * `sql.begin(...)` transaction — collapsing N per-row commits/fsyncs into a single commit.
 */
export async function upsertJurisdiction(sql: Queryable, row: IngestRow): Promise<void> {
  const geojson = JSON.stringify(row.geometry)
  await sql`
    INSERT INTO jurisdictions (geoid, name, layer, priority, geom, population)
    VALUES (
      ${row.geoid},
      ${row.name},
      ${row.layer},
      ${LAYER_RANK[row.layer]},
      ST_Multi(ST_SetSRID(ST_GeomFromGeoJSON(${geojson}), 4326)),
      ${row.population}
    )
    ON CONFLICT (geoid) DO UPDATE SET
      name = EXCLUDED.name,
      layer = EXCLUDED.layer,
      priority = EXCLUDED.priority,
      geom = EXCLUDED.geom,
      population = COALESCE(EXCLUDED.population, jurisdictions.population)
  `
}

/**
 * Ingest one GeoJSON FeatureCollection (already-read TEXT) into `jurisdictions` under a SINGLE
 * transaction. Parses + validates the text, normalizes via normalizeFeatures (applying the optional
 * load-time geoid prefix), and upserts every row (ON CONFLICT preserves operator-mapped contacts).
 * Returns the upserted count, the number of features SKIPPED (missing geoid/name/non-polygon), and the
 * total `features` parsed from the file.
 *
 * Factored out of main() so the on-box `jurisdiction.refresh` cron (services/admin/boundary-refresh-jobs.ts)
 * and the Testcontainers integration harness drive the EXACT same load path the CLI uses: the cron streams
 * each layer's GeoJSON out of R2 and calls this once per file. Takes a raw `Sql` tag (postgres-js) because
 * it owns the `sql.begin(...)` transaction; geometry flows only through this raw tag (ST_GeomFromGeoJSON),
 * never Drizzle.
 *
 * THROWS on invalid JSON or a non-FeatureCollection payload — a truncated/corrupt download surfaces as an
 * error so the caller (cron) aborts the whole refresh and never stamps a partial vintage. `features` lets
 * the cron cross-check the parsed count against the publish-time manifest count (a second truncation guard
 * on top of JSON.parse already rejecting an incomplete file).
 */
export async function ingestGeoJsonFile(
  sql: Sql,
  geojsonText: string,
  defaultLayer: IngestRow["layer"],
  geoidPrefix?: string,
): Promise<{ upserted: number; skipped: number; features: number }> {
  const fc = JSON.parse(geojsonText) as GeoJsonFeatureCollection
  if (fc.type !== "FeatureCollection" || !Array.isArray(fc.features)) {
    throw new Error("ingest: input is not a GeoJSON FeatureCollection")
  }
  const features = fc.features.length
  const { rows, skipped } = normalizeFeatures(fc, defaultLayer, geoidPrefix)
  // Run every upsert under ONE transaction: with a row-by-row loop each await is its own commit/fsync
  // round-trip (rows x RTT, fully serialized on a max:1 pool). Wrapping in a single `begin` collapses
  // those N commits into one, so the only remaining per-row cost is the ST_GeomFromGeoJSON parse
  // (Postgres-side CPU). If any row fails the whole file rolls back — the right semantics for an
  // authoritative boundary import (a layer either lands fully or not at all).
  await sql.begin(async (tx) => {
    for (const row of rows) await upsertJurisdiction(tx, row)
  })
  return { upserted: rows.length, skipped, features }
}

async function main(): Promise<void> {
  const file = process.argv[2]
  const defaultLayer = (process.argv[3] ?? "federal") as IngestRow["layer"]
  // Optional load-time geoid namespace (see file header "Prefix rule"): "AIANNH-" for tribal/AIANNH,
  // "PADUS-" for PAD-US/federal, empty for TIGER place/county/state. main() owns the trimming; the pure
  // normalizeFeatures takes the value as-is.
  const geoidPrefix = (process.argv[4] ?? "").trim()
  if (!file) {
    console.error("usage: tsx src/db/ingest-jurisdictions.ts <boundaries.geojson> [layer] [geoid-prefix]")
    process.exit(2)
  }
  if (!(defaultLayer in LAYER_RANK)) {
    console.error(`ingest: unknown layer "${defaultLayer}" (expected one of ${Object.keys(LAYER_RANK).join(", ")})`)
    process.exit(2)
  }

  const text = await readFile(file, "utf8")
  const env = loadEnv()
  const handle = makeDb(env.DATABASE_URL, { max: 1 })
  try {
    const { upserted, skipped } = await ingestGeoJsonFile(handle.sql, text, defaultLayer, geoidPrefix)
    console.log(`ingest: ${upserted} jurisdictions upserted from ${file} (${skipped} features skipped)`)
  } finally {
    await handle.close()
  }
}

// Run only when executed directly (tsx src/db/ingest-jurisdictions.ts <file>), not when imported.
const invokedDirectly =
  process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]
if (invokedDirectly) {
  main().catch((err: unknown) => {
    console.error("ingest: failed")
    console.error(err)
    process.exit(1)
  })
}
