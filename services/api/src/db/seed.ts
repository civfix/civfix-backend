/**
 * Seed runner: inserts the dev/test jurisdiction set (nested California / LA County / LA city boxes).
 *
 * Idempotent: each row uses ON CONFLICT (geoid) DO NOTHING, so running it repeatedly (or after a
 * partial run) is safe. Geometries are built server-side with ST_Multi(ST_MakeEnvelope(...,4326)) so
 * we never ship WKB from JS. The geometry fixtures + expected probe resolutions live in
 * seed-fixtures.ts and are shared with the spatial integration test.
 *
 * The actual insert is factored into `seedJurisdictions(sql)` so the Testcontainers harness can seed
 * a fresh database with the exact same data the CLI seed produces. Requires DATABASE_URL + live
 * Postgres when run as a CLI; not exercised by the offline unit suite.
 */

import { fileURLToPath } from "node:url"
import type { Sql } from "./client.js"
import { makeDb } from "./client.js"
import { loadEnv } from "../env.js"
import { JURISDICTION_SEEDS } from "./seed-fixtures.js"

/**
 * Insert the seed jurisdictions. Returns the number of rows actually inserted (0 if everything was
 * already present). Safe to call multiple times.
 *
 * @param sql raw postgres-js tag (e.g. dbHandle.sql).
 */
export async function seedJurisdictions(sql: Sql): Promise<number> {
  let inserted = 0
  for (const j of JURISDICTION_SEEDS) {
    const [xmin, ymin, xmax, ymax] = j.bbox
    // ST_MakeEnvelope(xmin, ymin, xmax, ymax, 4326) -> Polygon; ST_Multi(...) -> MultiPolygon(4326).
    const rows = await sql`
      INSERT INTO jurisdictions (geoid, name, layer, priority, geom, population, contact_emails)
      VALUES (
        ${j.geoid},
        ${j.name},
        ${j.layer},
        ${j.priority},
        ST_Multi(ST_MakeEnvelope(${xmin}, ${ymin}, ${xmax}, ${ymax}, 4326)),
        ${j.population},
        ${j.contactEmails}
      )
      ON CONFLICT (geoid) DO NOTHING
      RETURNING geoid
    `
    inserted += rows.length
  }
  return inserted
}

async function main(): Promise<void> {
  const env = loadEnv()
  const handle = makeDb(env.DATABASE_URL, { max: 1 })
  try {
    const inserted = await seedJurisdictions(handle.sql)
    console.log(
      `seed: jurisdictions seeded (${inserted} inserted, ${JURISDICTION_SEEDS.length - inserted} already present)`,
    )
  } finally {
    await handle.close()
  }
}

// Run only when executed directly (tsx src/db/seed.ts), not when imported by the harness/tests.
const invokedDirectly =
  process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]
if (invokedDirectly) {
  main().catch((err: unknown) => {
    console.error("seed: failed")
    console.error(err)
    process.exit(1)
  })
}
