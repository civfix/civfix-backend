import type { Sql } from "./client.js"
import { runDbCli, runIfMain } from "./cli.js"
import { JURISDICTION_SEEDS } from "./seed-fixtures.js"
import { FEDERAL_LANDS, federalLandGeoJson } from "./data/federal-lands.js"

export async function seedJurisdictions(sql: Sql): Promise<number> {
  let inserted = 0
  for (const j of JURISDICTION_SEEDS) {
    const [xmin, ymin, xmax, ymax] = j.bbox
    const rows = await sql`
      INSERT INTO jurisdictions (geoid, name, layer, priority, geom, population, contact_emails, code)
      VALUES (
        ${j.geoid},
        ${j.name},
        ${j.layer},
        ${j.priority},
        ST_Multi(ST_MakeEnvelope(${xmin}, ${ymin}, ${xmax}, ${ymax}, 4326)),
        ${j.population},
        ${j.contactEmails},
        nextval('jurisdiction_code_seq')
      )
      ON CONFLICT (geoid) DO NOTHING
      RETURNING geoid
    `
    inserted += rows.length
  }
  inserted += await seedFederalLands(sql)
  return inserted
}

export async function seedFederalLands(sql: Sql): Promise<number> {
  let inserted = 0
  for (const land of FEDERAL_LANDS) {
    const geojson = federalLandGeoJson(land.bbox)
    const priority = land.layer === "tribal" ? -1 : -2
    const rows = await sql`
      INSERT INTO jurisdictions (geoid, name, layer, priority, geom, population, contact_emails, report_form_url, code)
      VALUES (
        ${land.geoid},
        ${land.name},
        ${land.layer},
        ${priority},
        ST_Multi(ST_SetSRID(ST_GeomFromGeoJSON(${geojson}), 4326)),
        ${land.population},
        ${land.contactEmails},
        ${land.reportFormUrl},
        nextval('jurisdiction_code_seq')
      )
      ON CONFLICT (geoid) DO NOTHING
      RETURNING geoid
    `
    inserted += rows.length
  }
  return inserted
}

async function main(): Promise<void> {
  const forced = process.argv.includes("--force")
  if (process.env.NODE_ENV === "production" && !forced) {
    console.log(
      "seed: skipping, NODE_ENV=production. The dev jurisdiction fixtures (hand-made octagons + " +
        "example.* contacts) are not for production; pass --force to override deliberately.",
    )
    return
  }
  await runDbCli(async (_db, sql) => {
    const [authoritative] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM jurisdictions WHERE geoid LIKE 'PADUS-%' OR geoid LIKE 'AIANNH-%'
    `
    if ((authoritative?.n ?? 0) > 0 && !forced) {
      console.log(
        `seed: skipping, found ${authoritative?.n} authoritative (PADUS-/AIANNH-) jurisdictions ` +
          `(a real boundary load). The dev seed would inject fixtures over real data; pass --force to override.`,
      )
      return
    }
    const total = JURISDICTION_SEEDS.length + FEDERAL_LANDS.length
    const inserted = await seedJurisdictions(sql)
    console.log(
      `seed: jurisdictions seeded (${inserted} inserted, ${total - inserted} already present)`,
    )
  })
}

runIfMain(import.meta.url, "seed", main)
