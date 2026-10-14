/**
 * Backfill CLI: fill jurisdictions.population from the US Census ACS 5-year API.
 *
 *   pnpm db:backfill-population            # latest default ACS vintage
 *   pnpm db:backfill-population 2023       # explicit ACS5 vintage year
 *
 * Runs against the env DATABASE_URL (open your own tunnel and export it, or use
 * `pnpm db:boundaries:refresh --backfill-only`, which includes this step). Requires CENSUS_API_KEY: the
 * Census API rejects unkeyed requests. A free key: https://api.census.gov/data/key_signup.html
 */

import { EXIT_USAGE, runDbCli, runIfMain } from "./cli.js"
import { backfillPopulation } from "./backfill-population-core.js"

async function main(): Promise<void> {
  const yearArg = process.argv[2]
  const year = yearArg ? Number(yearArg) : undefined
  if (yearArg && !Number.isInteger(year)) {
    console.error(`backfill-population: vintage must be a 4-digit year (got "${yearArg}")`)
    process.exit(EXIT_USAGE)
  }
  await runDbCli(async (_db, sql) => {
    const { fetched, updated, states } = await backfillPopulation(sql, {
      ...(year !== undefined ? { year } : {}),
      log: (m) => console.log(`backfill-population: ${m}`),
    })
    console.log(
      `backfill-population: ${updated} jurisdictions updated from ${fetched} ACS rows across ${states} states`,
    )
  })
}

runIfMain(import.meta.url, "backfill-population", main)
