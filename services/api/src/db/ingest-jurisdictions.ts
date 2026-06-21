/**
 * Ingest CLI: load REAL jurisdiction boundaries from an external GeoJSON FeatureCollection into the
 * `jurisdictions` table.
 *
 *   pnpm db:ingest <path/to/boundaries.geojson> [layer] [geoid-prefix]
 *
 * `layer` (default "federal") is the fallback jurisdiction layer for features whose properties do not
 * carry one; pass "tribal" for a reservations export, etc.
 *
 * The actual ingest LOGIC (normalizeFeatures / upsertJurisdiction / ingestGeoJsonFile, the geoid-prefix
 * rule, the contact-preserving upsert) lives in ./ingest-jurisdictions-core.ts — a side-effect-free module
 * with NO `main()` and NO CLI guard, so other code (the local refresh tool scripts/refresh-boundaries.ts)
 * can import it without dragging in this file's `main()`. THIS file is ONLY the CLI shell: arg parsing +
 * DB handle + main(). It
 * is also a tsup entry, emitted to dist/db/ingest-jurisdictions.js so the production image can run
 * `node dist/db/ingest-jurisdictions.js <file> <layer> [geoid-prefix]` without tsx.
 *
 * Prefix rule (the optional third arg `geoid-prefix`): Census TIGER geoids are FIPS-hierarchical, so the
 * TIGER geocoder derives "City, ST" from the leading 2 chars — valid ONLY for real Census FIPS ids. The
 * two non-FIPS layers must be namespaced at load time to stay globally unique AND make uspsFromGeoid()
 * return null (so the geocoder falls back to the authoritative spatial state query): pass "AIANNH-" for an
 * AIANNH/tribal export and "PADUS-" for a PAD-US/federal export. TIGER place/county/state pass NO prefix.
 *
 * Real, public-domain sources: US Census TIGER/Line (place/county/state/AIANNH), USGS PAD-US (federal).
 * Requires DATABASE_URL + live Postgres/PostGIS; not exercised by the offline unit suite.
 */

import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { makeDb } from "./client.js"
import { loadEnv } from "../env.js"
import { LAYER_RANK, ingestGeoJsonFile, type IngestRow } from "./ingest-jurisdictions-core.js"

// Re-export the core API from the historical path so existing importers (e.g. the unit test importing
// `normalizeFeatures` from this module) keep working without reaching into the core module directly.
export {
  normalizeFeatures,
  upsertJurisdiction,
  ingestGeoJsonFile,
  LAYER_RANK,
} from "./ingest-jurisdictions-core.js"
export type { IngestRow } from "./ingest-jurisdictions-core.js"

async function main(): Promise<void> {
  const file = process.argv[2]
  const defaultLayer = (process.argv[3] ?? "federal") as IngestRow["layer"]
  // Optional load-time geoid namespace (see file header "Prefix rule"). main() owns the trimming; the
  // pure normalizeFeatures takes the value as-is.
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

// Run only when executed directly (tsx src/db/ingest-jurisdictions.ts <file> / node dist/db/ingest-jurisdictions.js),
// not when imported. This guard is SAFE here because this CLI module is NEVER imported by the API runtime
// (runtime imports the guard-free ./ingest-jurisdictions-core.js instead), so it can only ever be the
// entry of its own tsup bundle. See ingest-jurisdictions-core.ts for the bundling rationale.
const invokedDirectly =
  process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]
if (invokedDirectly) {
  main().catch((err: unknown) => {
    console.error("ingest: failed")
    console.error(err)
    process.exit(1)
  })
}
