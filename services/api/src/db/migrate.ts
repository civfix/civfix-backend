/**
 * Migration runner. Applies SQL migrations from ./drizzle against DATABASE_URL using drizzle's
 * postgres-js migrator. Run with `pnpm db:migrate`.
 *
 * No migrations exist yet in the scaffold; this runs cleanly against an empty ./drizzle folder once
 * a DB is reachable. It requires DATABASE_URL and a live Postgres, so it is NOT exercised by unit
 * tests (those run with fakes and no DB).
 */

import { migrate } from "drizzle-orm/postgres-js/migrator"
import { loadEnv } from "../env.js"
import { makeDb } from "./client.js"

async function main(): Promise<void> {
  const env = loadEnv()
  const handle = makeDb(env.DATABASE_URL, { max: 1 })
  try {
    await migrate(handle.db, { migrationsFolder: "./drizzle" })
    console.log("migrations applied")
  } finally {
    await handle.close()
  }
}

main().catch((err: unknown) => {
  console.error("migrate: failed")
  console.error(err)
  process.exit(1)
})
