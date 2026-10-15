import { runDbCli, runIfMain } from "./cli.js"
import { backfillPostGeom } from "./backfill-post-geom-core.js"

async function main(): Promise<void> {
  await runDbCli(async (_db, sql) => {
    const { scanned, filled } = await backfillPostGeom(sql)
    console.log(`backfill-post-geom: done: scanned=${scanned} filled=${filled}`)
  })
}

runIfMain(import.meta.url, "backfill-post-geom", main)
