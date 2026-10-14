/**
 * Stamps historical reports and cleanups with reference codes after a deploy is healthy, never inside the
 * migration transaction.
 *
 *   pnpm db:backfill:reference-codes        (dev: tsx)
 *   node dist/db/backfill-reference-codes.js (prod)
 */

import { runDbCli, runIfMain } from "./cli.js"
import { backfillReferenceCodes } from "./backfill-reference-codes-core.js"

async function main(): Promise<void> {
  await runDbCli(async (_db, sql) => {
    const { reports, cleanupJurisdictions, cleanups } = await backfillReferenceCodes(sql)
    console.log(
      `reference-codes: done: reports stamped=${reports.stamped} failed=${reports.failed}; ` +
        `cleanup jurisdictions resolved=${cleanupJurisdictions.resolved} ` +
        `still-null=${cleanupJurisdictions.stayedNull}; ` +
        `cleanups stamped=${cleanups.stamped} failed=${cleanups.failed}`,
    )
  })
}

runIfMain(import.meta.url, "backfill-reference-codes", main)
