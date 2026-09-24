import { createReadStream } from "node:fs"
import { createInterface } from "node:readline"
import type { Queryable, Sql } from "./client.js"

interface GeoJsonFeature {
  type: "Feature"
  properties: Record<string, unknown> | null
  geometry: { type: string; coordinates: unknown } | null
}
interface GeoJsonFeatureCollection {
  type: "FeatureCollection"
  features: GeoJsonFeature[]
}

export interface IngestRow {
  geoid: string
  name: string
  layer: "federal" | "tribal" | "place" | "county" | "state"
  population: number | null
  geometry: { type: string; coordinates: unknown }
}

function pickString(props: Record<string, unknown> | null, keys: string[]): string | null {
  if (!props) return null
  for (const k of keys) {
    const v = props[k]
    if (typeof v === "string" && v.trim() !== "") return v.trim()
    if (typeof v === "number" && Number.isFinite(v)) return String(v)
  }
  return null
}

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

const UPSERT_BATCH_SIZE = 1000

export function normalizeFeature(
  f: GeoJsonFeature,
  defaultLayer: IngestRow["layer"],
  geoidPrefix?: string,
): IngestRow | null {
  const geometry = f.geometry
  const isPolygon =
    geometry !== null && (geometry.type === "Polygon" || geometry.type === "MultiPolygon")
  const geoid = pickString(f.properties, [
    "geoid",
    "GEOID",
    "UNIT_CODE",
    "unit_code",
    "id",
    "OBJECTID",
  ])
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

export function normalizeFeatures(
  fc: GeoJsonFeatureCollection,
  defaultLayer: IngestRow["layer"],
  geoidPrefix?: string,
): { rows: IngestRow[]; skipped: number } {
  const rows: IngestRow[] = []
  let skipped = 0
  for (const f of fc.features ?? []) {
    if (typeof f !== "object" || f === null) {
      skipped += 1
      continue
    }
    const row = normalizeFeature(f, defaultLayer, geoidPrefix)
    if (row === null) skipped += 1
    else rows.push(row)
  }
  return { rows, skipped }
}

export async function upsertJurisdictionBatch(
  sql: Queryable,
  rows: readonly IngestRow[],
): Promise<number> {
  if (rows.length === 0) return 0
  const byGeoid = new Map<string, IngestRow>()
  for (const r of rows) byGeoid.set(r.geoid, r)
  const unique = [...byGeoid.values()]
  const geoids = unique.map((r) => r.geoid)
  const names = unique.map((r) => r.name)
  const layers = unique.map((r) => r.layer)
  const priorities = unique.map((r) => LAYER_RANK[r.layer])
  const geojsons = unique.map((r) => JSON.stringify(r.geometry))
  const populations = unique.map((r) => r.population)
  const written = await sql<{ geoid: string }[]>`
    INSERT INTO jurisdictions (geoid, name, layer, priority, geom, population, code)
    SELECT t.geoid, t.name, t.layer, t.priority, t.geom, t.population, nextval('jurisdiction_code_seq')
    FROM (
      SELECT
        u.geoid AS geoid,
        u.name AS name,
        u.layer AS layer,
        u.priority AS priority,
        u.population AS population,
        ST_Multi(ST_SetSRID(ST_GeomFromGeoJSON(u.geojson), 4326)) AS geom
      FROM unnest(
        ${geoids}::text[],
        ${names}::text[],
        ${layers}::text[],
        ${priorities}::int[],
        ${geojsons}::text[],
        ${populations}::int[]
      ) AS u(geoid, name, layer, priority, geojson, population)
    ) t
    WHERE ST_IsValid(t.geom)
    ON CONFLICT (geoid) DO UPDATE SET
      name = EXCLUDED.name,
      layer = EXCLUDED.layer,
      priority = EXCLUDED.priority,
      geom = EXCLUDED.geom,
      population = COALESCE(EXCLUDED.population, jurisdictions.population),
      code = COALESCE(jurisdictions.code, EXCLUDED.code),
      contact_emails = CASE
        WHEN cardinality(jurisdictions.contact_emails) > 0
          AND NOT EXISTS (
            SELECT 1
            FROM unnest(jurisdictions.contact_emails) AS addr
            WHERE lower(addr) NOT LIKE '%@example.%'
          )
        THEN NULL
        ELSE jurisdictions.contact_emails
      END
    RETURNING geoid
  `
  return written.length
}

export async function upsertJurisdiction(sql: Queryable, row: IngestRow): Promise<boolean> {
  return (await upsertJurisdictionBatch(sql, [row])) > 0
}

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
  let upserted = 0
  await sql.begin(async (tx) => {
    for (let i = 0; i < rows.length; i += UPSERT_BATCH_SIZE) {
      upserted += await upsertJurisdictionBatch(tx, rows.slice(i, i + UPSERT_BATCH_SIZE))
    }
  })
  return { upserted, skipped: skipped + (rows.length - upserted), features }
}

export async function ingestGeoJsonSeqFile(
  sql: Sql,
  filePath: string,
  defaultLayer: IngestRow["layer"],
  geoidPrefix?: string,
): Promise<{ upserted: number; skipped: number; features: number }> {
  let features = 0
  let skipped = 0
  let upserted = 0
  let batch: IngestRow[] = []
  const flush = async (): Promise<void> => {
    if (batch.length === 0) return
    const attempted = new Set(batch.map((r) => r.geoid)).size
    const current = batch
    batch = []
    const written = await sql.begin(async (tx) => upsertJurisdictionBatch(tx, current))
    upserted += written
    skipped += attempted - written
  }
  const lines = createInterface({ input: createReadStream(filePath, "utf8"), crlfDelay: Infinity })
  for await (const raw of lines) {
    const line = (raw.charCodeAt(0) === 0x1e ? raw.slice(1) : raw).trim()
    if (line === "") continue
    features += 1
    const row = normalizeFeature(JSON.parse(line) as GeoJsonFeature, defaultLayer, geoidPrefix)
    if (row === null) {
      skipped += 1
      continue
    }
    batch.push(row)
    if (batch.length >= UPSERT_BATCH_SIZE) await flush()
  }
  await flush()
  return { upserted, skipped, features }
}

export type { GeoJsonFeature, GeoJsonFeatureCollection }
