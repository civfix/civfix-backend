/**
 * Resolution happens once at insert time, so reports filed while coverage was missing keep a NULL
 * jurisdiction_geoid until this sweep runs after an ingest.
 *
 *   pnpm db:backfill        (dev: tsx)   /   node dist/db/backfill-jurisdictions.js   (prod)
 */

import { runDbCli, runIfMain } from "./cli.js"
import { backfillReports } from "./backfill-jurisdictions-core.js"

async function main(): Promise<void> {
  await runDbCli(async (_db, sql) => {
    const { resolved, stayedNull } = await backfillReports(sql)
    console.log(
      `backfill: done, ${resolved} reports resolved to a jurisdiction, ` +
        `${stayedNull} still null (point outside all loaded coverage)`,
    )
  })
}

runIfMain(import.meta.url, "backfill", main)
