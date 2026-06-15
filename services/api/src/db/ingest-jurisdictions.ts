/**
 * Ingest CLI: load REAL jurisdiction boundaries from an external GeoJSON FeatureCollection into the
 * `jurisdictions` table. This is the production path for loading full-fidelity federal / tribal land
 * boundaries (and could equally load TIGER place/county/state) at scale - the curated dev set in
 * data/federal-lands.ts is just a small offline sample of what this ingests.
 *
 *   pnpm db:ingest <path/to/boundaries.geojson> [layer]
 *
 * `layer` (default "federal") is the fallback jurisdiction layer for features whose properties do not
 * carry one; pass "tribal" for a reservations export, etc.
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
import type { Queryable } from "./client.js"
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
 */
export function normalizeFeatures(
  fc: GeoJsonFeatureCollection,
  defaultLayer: IngestRow["layer"],
): { rows: IngestRow[]; skipped: number } {
  const rows: IngestRow[] = []
  let skipped = 0
  for (const f of fc.features ?? []) {
    const geometry = f.geometry
    const isPolygon =
      geometry !== null && (geometry.type === "Polygon" || geometry.type === "MultiPolygon")
    const geoid = pickString(f.properties, ["geoid", "GEOID", "UNIT_CODE", "unit_code", "id", "OBJECTID"])
    const name = pickString(f.properties, ["name", "NAME", "UNIT_NAME", "unit_name", "Unit_Name"])
    const rawLayer = pickString(f.properties, ["layer", "LAYER", "owner_type", "Own_Type"])
    const layer =
      rawLayer && rawLayer.toLowerCase() in LAYER_RANK
        ? (rawLayer.toLowerCase() as IngestRow["layer"])
        : defaultLayer
    if (!isPolygon || geoid === null || name === null) {
      skipped += 1
      continue
    }
    rows.push({
      geoid,
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

async function main(): Promise<void> {
  const file = process.argv[2]
  const defaultLayer = (process.argv[3] ?? "federal") as IngestRow["layer"]
  if (!file) {
    console.error("usage: tsx src/db/ingest-jurisdictions.ts <boundaries.geojson> [layer]")
    process.exit(2)
  }
  if (!(defaultLayer in LAYER_RANK)) {
    console.error(`ingest: unknown layer "${defaultLayer}" (expected one of ${Object.keys(LAYER_RANK).join(", ")})`)
    process.exit(2)
  }

  const text = await readFile(file, "utf8")
  const fc = JSON.parse(text) as GeoJsonFeatureCollection
  if (fc.type !== "FeatureCollection" || !Array.isArray(fc.features)) {
    console.error("ingest: input is not a GeoJSON FeatureCollection")
    process.exit(2)
  }
  const { rows, skipped } = normalizeFeatures(fc, defaultLayer)

  const env = loadEnv()
  const handle = makeDb(env.DATABASE_URL, { max: 1 })
  try {
    // Run every upsert under ONE transaction: with the row-by-row loop each await was its own
    // commit/fsync round-trip (rows x RTT, fully serialized on a max:1 pool). Wrapping in a single
    // `begin` collapses those N commits into one, so the only remaining per-row cost is the
    // ST_GeomFromGeoJSON parse (Postgres-side CPU, unchanged here). If any row fails the whole
    // ingest rolls back, which is the right semantics for an authoritative boundary import.
    await handle.sql.begin(async (tx) => {
      for (const row of rows) await upsertJurisdiction(tx, row)
    })
    console.log(`ingest: ${rows.length} jurisdictions upserted from ${file} (${skipped} features skipped)`)
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
