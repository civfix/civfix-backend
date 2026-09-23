import { runDbCli, runIfMain } from "./cli.js"
import { backfillUserActivity } from "./backfill-user-activity-core.js"

export { backfillUserActivity } from "./backfill-user-activity-core.js"

async function main(): Promise<void> {
  await runDbCli(async (_db, sql) => {
    const { scanned, filled } = await backfillUserActivity(sql)
    console.log(`backfill-user-activity: done — scanned=${scanned} filled=${filled}`)
  })
}

runIfMain(import.meta.url, "backfill-user-activity", main)
