/**
 * Ingest CLI: load REAL jurisdiction boundaries from an external GeoJSON FeatureCollection into the
 * `jurisdictions` table.
 *
 *   pnpm db:ingest <path/to/boundaries.geojson> [layer] [geoid-prefix]
 *
 * `layer` (default "federal") is the fallback layer for features whose properties carry none. The
 * geoid-prefix rule (AIANNH-/PADUS- for the non-FIPS layers) and the ingest LOGIC live in the guard-free
 * ./ingest-jurisdictions-core.js (imported by both this shell and scripts/refresh-boundaries.ts; see that
 * file's header for the prefix rule, the contact-preserving upsert, the public-domain sources, and the
 * tsup-bundling rationale that requires the split). This file is ONLY the CLI shell (args + run).
 */

import { readFile } from "node:fs/promises"
import { runDbCli, runIfMain } from "./cli.js"
import { LAYER_RANK, ingestGeoJsonFile, type IngestRow } from "./ingest-jurisdictions-core.js"

// Re-export the core API from the historical path so existing importers (e.g. the unit test importing
// `normalizeFeatures` from this module) keep resolving against this module.
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
  const geoidPrefix = (process.argv[4] ?? "").trim()
  if (!file) {
    console.error(
      "usage: tsx src/db/ingest-jurisdictions.ts <boundaries.geojson> [layer] [geoid-prefix]",
    )
    process.exit(2)
  }
  if (!(defaultLayer in LAYER_RANK)) {
    console.error(
      `ingest: unknown layer "${defaultLayer}" (expected one of ${Object.keys(LAYER_RANK).join(", ")})`,
    )
    process.exit(2)
  }

  // Read the file up front so a missing/unreadable path is a clear error, not confused with a DB failure.
  let text: string
  try {
    text = await readFile(file, "utf8")
  } catch (err) {
    throw new Error(`ingest: cannot read ${file}`, { cause: err })
  }

  await runDbCli(async (_db, sql) => {
    const { upserted, skipped } = await ingestGeoJsonFile(sql, text, defaultLayer, geoidPrefix)
    console.log(
      `ingest: ${upserted} jurisdictions upserted from ${file} (${skipped} features skipped)`,
    )
  })
}

runIfMain(import.meta.url, "ingest", main)
