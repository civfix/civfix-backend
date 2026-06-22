/**
 * Reference-code backfill CLI (issue #56): stamp historical reports + cleanups with reference codes, and
 * resolve cleanup jurisdictions, AFTER a deploy is healthy (H3 — never in the migration tx).
 *
 *   pnpm db:backfill:reference-codes        (dev: tsx)
 *   node dist/db/backfill-reference-codes.js (prod)
 *
 * The keyset loops live in the guard-free ./backfill-reference-codes-core.js (imported by both this
 * shell and any runtime caller; see that file for the race-free-by-shared-counter design, idempotency,
 * and the tsup-bundling rationale that requires the split). This file is ONLY the CLI shell.
 */

import { runDbCli, runIfMain } from "./cli.js"
import { backfillReferenceCodes } from "./backfill-reference-codes-core.js"

export { backfillReferenceCodes } from "./backfill-reference-codes-core.js"

async function main(): Promise<void> {
  await runDbCli(async (_db, sql) => {
    const { reports, cleanupJurisdictions, cleanups } = await backfillReferenceCodes(sql)
    console.log(
      `reference-codes: done — reports stamped=${reports.stamped} failed=${reports.failed}; ` +
        `cleanup jurisdictions resolved=${cleanupJurisdictions.resolved} ` +
        `still-null=${cleanupJurisdictions.stayedNull}; ` +
        `cleanups stamped=${cleanups.stamped} failed=${cleanups.failed}`,
    )
  })
}

runIfMain(import.meta.url, "backfill-reference-codes", main)
