/**
 *   pnpm db:ingest <path/to/boundaries.geojson> [layer] [geoid-prefix]
 *
 * `layer` (default "federal") is the fallback for features whose properties carry none.
 */

import { readFile } from "node:fs/promises"
import { runDbCli, runIfMain } from "./cli.js"
import {
  LAYER_RANK,
  ingestGeoJsonFile,
  isIngestLayer,
  type IngestRow,
} from "./ingest-jurisdictions-core.js"

// Re-exported from the historical path so existing importers keep resolving.
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
  if (!isIngestLayer(defaultLayer)) {
    console.error(
      `ingest: unknown layer "${defaultLayer}" (expected one of ${Object.keys(LAYER_RANK).join(", ")})`,
    )
    process.exit(2)
  }

  // Read up front so a missing path is a clear error rather than something that looks like a DB failure.
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
