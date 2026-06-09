/**
 * Seed runner: inserts the dev/test jurisdiction set - the nested California / LA County / LA city boxes
 * (seed-fixtures.ts) PLUS the curated real federal + tribal lands (data/federal-lands.ts: Yellowstone,
 * Yosemite, Grand Canyon, Joshua Tree, Angeles National Forest, Navajo Nation), each a DISTINCT unit
 * with its own routing contact.
 *
 * Idempotent: each row uses ON CONFLICT (geoid) DO NOTHING, so running it repeatedly (or after a
 * partial run) is safe. The LA boxes are built with ST_Multi(ST_MakeEnvelope(...,4326)); the federal
 * lands via ST_Multi(ST_SetSRID(ST_GeomFromGeoJSON(...),4326)) - the same path the ingest CLI
 * (db:ingest) uses to load full PAD-US/NPS boundaries. We never ship WKB from JS. The geometry fixtures
 * + expected probe resolutions live in seed-fixtures.ts / data/federal-lands.ts and are shared with the
 * spatial integration test.
 *
 * The inserts are factored into `seedJurisdictions(sql)` (which also calls `seedFederalLands`) so the
 * Testcontainers harness seeds a fresh database with the exact same data the CLI seed produces. Requires
 * DATABASE_URL + live Postgres when run as a CLI; not exercised by the offline unit suite.
 */

import { fileURLToPath } from "node:url"
import type { Sql } from "./client.js"
import { makeDb } from "./client.js"
import { loadEnv } from "../env.js"
import { JURISDICTION_SEEDS } from "./seed-fixtures.js"
import { FEDERAL_LANDS, federalLandGeoJson } from "./data/federal-lands.js"

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
  // Also seed the curated real federal + tribal lands (distinct units, each its own routing target).
  inserted += await seedFederalLands(sql)
  return inserted
}

/**
 * Insert the curated real federal + tribal jurisdictions (FEDERAL_LANDS). Each unit's real bounding
 * extent is generalized to a simplified octagonal boundary and ingested via ST_GeomFromGeoJSON - the
 * SAME PostGIS path the ingest CLI uses for full external boundaries. Idempotent (ON CONFLICT DO
 * NOTHING). `priority` mirrors the resolver's layer rank (federal/tribal are most-specific, so negative).
 */
export async function seedFederalLands(sql: Sql): Promise<number> {
  let inserted = 0
  for (const land of FEDERAL_LANDS) {
    const geojson = federalLandGeoJson(land.bbox)
    const priority = land.layer === "tribal" ? -1 : -2
    const rows = await sql`
      INSERT INTO jurisdictions (geoid, name, layer, priority, geom, population, contact_emails, report_form_url)
      VALUES (
        ${land.geoid},
        ${land.name},
        ${land.layer},
        ${priority},
        ST_Multi(ST_SetSRID(ST_GeomFromGeoJSON(${geojson}), 4326)),
        ${land.population},
        ${land.contactEmails},
        ${land.reportFormUrl}
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
    const total = JURISDICTION_SEEDS.length + FEDERAL_LANDS.length
    const inserted = await seedJurisdictions(handle.sql)
    console.log(`seed: jurisdictions seeded (${inserted} inserted, ${total - inserted} already present)`)
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
