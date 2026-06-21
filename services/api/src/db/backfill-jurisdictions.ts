/**
 * Backfill CLI (Phase 5): re-resolve `reports.jurisdiction_geoid` for rows where it IS NULL, after an
 * ingest run populates real boundaries (resolution happens once at insert time and never re-runs, so rows
 * inserted while coverage was missing stay NULL until this sweep).
 *
 *   pnpm db:backfill        (dev: tsx)   /   node dist/db/backfill-jurisdictions.js   (prod)
 *
 * The actual keyset loop lives in ./backfill-jurisdictions-core.ts — a side-effect-free module with NO
 * `main()`/guard, so runtime code (the jurisdiction.refresh cron) imports `backfillReports` from there
 * without dragging in this CLI's `main()`. THIS file is only the CLI shell (DB handle + main()), and a
 * tsup entry emitted to dist/db/backfill-jurisdictions.js for the production image. See
 * backfill-jurisdictions-core.ts for scope (reports only), the shared ranking constant, and termination.
 *
 * Requires DATABASE_URL + live Postgres/PostGIS; not exercised by the offline unit suite (the keyset loop
 * is covered by the Testcontainers integration harness).
 */

import { fileURLToPath } from "node:url"
import { makeDb } from "./client.js"
import { loadEnv } from "../env.js"
import { backfillReports } from "./backfill-jurisdictions-core.js"

// Re-export from the historical path so existing importers keep resolving against this module.
export { backfillReports } from "./backfill-jurisdictions-core.js"

async function main(): Promise<void> {
  const env = loadEnv()
  const handle = makeDb(env.DATABASE_URL, { max: 1 })
  try {
    const { resolved, stayedNull } = await backfillReports(handle.sql)
    console.log(
      `backfill: done — ${resolved} reports resolved to a jurisdiction, ` +
        `${stayedNull} still null (point outside all loaded coverage)`,
    )
  } finally {
    await handle.close()
  }
}

// Run only when executed directly, not when imported. SAFE here because this CLI module is NEVER imported
// by the API runtime (runtime imports the guard-free ./backfill-jurisdictions-core.js), so it can only be
// the entry of its own tsup bundle. See ingest-jurisdictions-core.ts for the bundling rationale.
const invokedDirectly =
  process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]
if (invokedDirectly) {
  main().catch((err: unknown) => {
    console.error("backfill: failed")
    console.error(err)
    process.exit(1)
  })
}
