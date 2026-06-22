/**
 * Backfill CLI: re-resolve `reports.jurisdiction_geoid` for rows where it IS NULL, after an ingest run
 * populates real boundaries (resolution happens once at insert time, so rows inserted while coverage was
 * missing stay NULL until this sweep).
 *
 *   pnpm db:backfill        (dev: tsx)   /   node dist/db/backfill-jurisdictions.js   (prod)
 *
 * The keyset loop lives in the guard-free ./backfill-jurisdictions-core.js (imported by both this shell
 * and scripts/refresh-boundaries.ts; see that file for scope, the shared ranking constant, termination,
 * and the tsup-bundling rationale that requires the split). This file is ONLY the CLI shell.
 */

import { runDbCli, runIfMain } from "./cli.js"
import { backfillReports } from "./backfill-jurisdictions-core.js"

export { backfillReports } from "./backfill-jurisdictions-core.js"

async function main(): Promise<void> {
  await runDbCli(async (_db, sql) => {
    const { resolved, stayedNull } = await backfillReports(sql)
    console.log(
      `backfill: done — ${resolved} reports resolved to a jurisdiction, ` +
        `${stayedNull} still null (point outside all loaded coverage)`,
    )
  })
}

runIfMain(import.meta.url, "backfill", main)
