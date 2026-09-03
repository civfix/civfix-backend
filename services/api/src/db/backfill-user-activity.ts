/**
 * Backfill CLI for users.last_activity_geom / last_activity_at (0102, audit H18):
 *
 *   pnpm db:backfill:user-activity            (dev: tsx)
 *   node dist/db/backfill-user-activity.js    (prod, after the deploy is healthy)
 *
 * Idempotent, keyset-paged, and safe to run while the API serves traffic — see the core module for the
 * monotonic guard that makes a concurrent live write always win. This file is ONLY the CLI shell.
 */

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
