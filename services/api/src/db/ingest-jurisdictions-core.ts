/**
 * Ingest CORE: the pure, side-effect-free jurisdiction-ingest logic — GeoJSON normalization + the
 * upsert + the single-file loader. This module has NO `main()` and NO "run as CLI" guard, so other code
 * can import it freely: the CLI (ingest-jurisdictions.ts) and the local refresh tool
 * (scripts/refresh-boundaries.ts) both import `ingestGeoJsonFile` from here.
 *
 * WHY this is split from ingest-jurisdictions.ts (the CLI): the CLI carries an
 * `if (import.meta.url === argv[1]) main()` guard. tsup builds with `splitting: false`, so importing a
 * module INLINES its whole source into the importing entry's bundle, and esbuild rewrites the inlined
 * `import.meta.url` to that bundle's own URL — so if any tsup-bundled ENTRY (e.g. the API server) ever
 * imported the CLI, the guard would fire at boot and run `main()` (a usage-error exit → crash loop). Hard
 * rule, enforced by this split: bundled runtime code imports the guard-FREE core, never the CLI.
 *
 * See ingest-jurisdictions.ts for the full prose on the geoid-prefix rule, the upsert's contact-preserving
 * semantics, and the public-domain sources.
 */

import { createReadStream } from "node:fs"
import { createInterface } from "node:readline"
import type { Queryable, Sql } from "./client.js"

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

export const LAYER_RANK: Record<IngestRow["layer"], number> = {
  federal: -2,
  tribal: -1,
  place: 0,
  county: 1,
  state: 2,
}

/**
 * Normalize ONE GeoJSON feature into an IngestRow, or null if it must be dropped (missing geoid or name, or
 * a non-polygon geometry). `defaultLayer` fills a feature whose properties carry no layer/owner type.
 * `geoidPrefix` (optional, non-empty) is the load-time geoid namespace (AIANNH-/PADUS-) prepended to the
 * picked geoid BEFORE the null check; an empty/undefined prefix is a no-op. PURE.
 */
export function normalizeFeature(
  f: GeoJsonFeature,
  defaultLayer: IngestRow["layer"],
  geoidPrefix?: string,
): IngestRow | null {
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
  if (!isPolygon || prefixedGeoid === null || name === null) return null
  return {
    geoid: prefixedGeoid,
    name,
    layer,
    population: pickNumber(f.properties, ["population", "POPULATION", "POP", "pop"]),
    geometry,
  }
}

/**
 * Normalize a GeoJSON FeatureCollection into IngestRow[]. Features dropped by normalizeFeature (missing
 * geoid/name or non-polygon geometry) are counted in `skipped`. See normalizeFeature for the per-feature
 * rules (geoid pick + prefix, name pick, layer fallback). PURE.
 */
export function normalizeFeatures(
  fc: GeoJsonFeatureCollection,
  defaultLayer: IngestRow["layer"],
  geoidPrefix?: string,
): { rows: IngestRow[]; skipped: number } {
  const rows: IngestRow[] = []
  let skipped = 0
  for (const f of fc.features ?? []) {
    const row = normalizeFeature(f, defaultLayer, geoidPrefix)
    if (row === null) skipped += 1
    else rows.push(row)
  }
  return { rows, skipped }
}

/**
 * Upsert one normalized row. Refreshes name/layer/priority/geom/population by geoid; PRESERVES the
 * routing columns (contact_emails / report_form_url / notes / flagged_at) so re-ingesting authoritative
 * boundaries never wipes operator-mapped contacts. Accepts `Queryable` (Sql | TransactionSql).
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
 * transaction. Parses + validates the text, normalizes (applying the optional load-time geoid prefix),
 * and upserts every row (ON CONFLICT preserves operator-mapped contacts). Returns the upserted count, the
 * number of features SKIPPED (missing geoid/name/non-polygon), and the total `features` parsed.
 *
 * The local refresh tool (scripts/refresh-boundaries.ts) calls this once per converted layer file. Takes a
 * raw `Sql` tag because it owns the `sql.begin(...)` transaction; geometry flows only through this raw tag
 * (ST_GeomFromGeoJSON), never Drizzle. THROWS on invalid JSON or a non-FeatureCollection payload so the
 * caller aborts rather than loading a corrupt file. `features` (vs `upserted`) lets a caller spot a layer
 * whose geometry was dropped in conversion (features > 0 but upserted 0).
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
  // One transaction per file: collapses N per-row commits into a single commit (the only remaining
  // per-row cost is the ST_GeomFromGeoJSON parse). Any row failing rolls back the whole file — the right
  // semantics for an authoritative boundary import (a layer lands fully or not at all).
  await sql.begin(async (tx) => {
    for (const row of rows) await upsertJurisdiction(tx, row)
  })
  return { upserted: rows.length, skipped, features }
}

/**
 * Ingest a GeoJSON Text Sequence file (RFC 8142 — ONE GeoJSON Feature per line, the `-f GeoJSONSeq` ogr2ogr
 * output), STREAMING it line by line so the file is never materialized as a single JS string. This is the
 * loader for layers too large for ingestGeoJsonFile: the PAD-US federal export is >512 MB, which exceeds
 * Node's max string length, so `readFileSync(path, "utf8")` on it throws ERR_STRING_TOO_LONG.
 *
 * Same semantics as ingestGeoJsonFile otherwise — ONE transaction for the whole file (a layer lands fully
 * or not at all), the optional load-time geoid prefix, the contact-preserving upsert, and the same
 * {upserted, skipped, features} return. Tolerates a leading RS (0x1e) byte (RFC 8142) and blank lines.
 * THROWS on a malformed line (JSON.parse) so the caller can roll the layer back rather than load it partly.
 */
export async function ingestGeoJsonSeqFile(
  sql: Sql,
  filePath: string,
  defaultLayer: IngestRow["layer"],
  geoidPrefix?: string,
): Promise<{ upserted: number; skipped: number; features: number }> {
  let features = 0
  let skipped = 0
  let upserted = 0
  await sql.begin(async (tx) => {
    const lines = createInterface({ input: createReadStream(filePath, "utf8"), crlfDelay: Infinity })
    for await (const raw of lines) {
      // RFC 8142 may prefix each record with an RS (0x1e) byte; drop it before parsing.
      const line = (raw.charCodeAt(0) === 0x1e ? raw.slice(1) : raw).trim()
      if (line === "") continue
      features += 1
      const row = normalizeFeature(JSON.parse(line) as GeoJsonFeature, defaultLayer, geoidPrefix)
      if (row === null) {
        skipped += 1
        continue
      }
      await upsertJurisdiction(tx, row)
      upserted += 1
    }
  })
  return { upserted, skipped, features }
}

export type { GeoJsonFeature, GeoJsonFeatureCollection }
