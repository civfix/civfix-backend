import type { Sql } from "../db/client.js"
import { resolveJurisdiction } from "../db/sql/jurisdiction.js"
import type { JurisdictionLookupResult } from "../adapters/jurisdiction-lookup.census.js"
import { legacyContactEmailUsable } from "./admin/sql-fragments.js"
import type { JurisdictionRepository } from "./jurisdiction-repository.js"

const LAYER_PRIORITY: Record<JurisdictionLookupResult["layer"], number> = {
  place: 2,
  county: 3,
  state: 4,
}

export function makeDrizzleJurisdictionRepository(sql: Sql): JurisdictionRepository {
  return {
    resolveContaining(lng, lat) {
      return resolveJurisdiction(sql, lng, lat)
    },

    async containingStateGeoid(lng, lat) {
      const rows = await sql<{ geoid: string }[]>`
        SELECT geoid
        FROM jurisdictions
        WHERE layer = 'state'
          AND ST_Contains(geom, ST_SetSRID(ST_MakePoint(${lng}, ${lat}), 4326))
        LIMIT 1
      `
      return rows[0]?.geoid ?? null
    },

    async exists(geoid) {
      const rows = await sql`SELECT 1 FROM jurisdictions WHERE geoid = ${geoid} LIMIT 1`
      return rows.length > 0
    },

    /**
     * The lower() comparison matches the partial-unique index jurisdictions_handle_lower_key
     * (0017_report_discussion.sql).
     */
    async handleExists(handle) {
      const rows = await sql<{ one: number }[]>`
        SELECT 1 AS one
        FROM jurisdictions
        WHERE handle IS NOT NULL AND lower(handle) = lower(${handle})
        LIMIT 1
      `
      return rows.length > 0
    },

    async insertApiSourcedIfAbsent(hit) {
      await sql`
        INSERT INTO jurisdictions (geoid, name, layer, priority, geom, contact_emails, code)
        SELECT
          ${hit.geoid}, ${hit.name}, ${hit.layer}, ${LAYER_PRIORITY[hit.layer]}, NULL, NULL,
          nextval('jurisdiction_code_seq')
        WHERE NOT EXISTS (SELECT 1 FROM jurisdictions WHERE geoid = ${hit.geoid})
        ON CONFLICT (geoid) DO NOTHING
      `
    },

    async loadHealth(geoid) {
      const rows = await sql<
        {
          geoid: string
          contact_emails: string[] | null
          contact_updated_at: Date | null
          population: number | null
          has_routing_contact: boolean
        }[]
      >`
        SELECT
          j.geoid,
          -- Only legacy addresses that have not bounced since the last contact save make the
          -- jurisdiction routable, so a bounce re-triggers discovery here as it does in the job.
          ARRAY(
            SELECT e FROM unnest(j.contact_emails) AS e
            WHERE ${legacyContactEmailUsable(sql, {
              email: sql`e`,
              geoid: sql`j.geoid`,
              contactUpdatedAt: sql`j.contact_updated_at`,
            })}
          ) AS contact_emails,
          j.contact_updated_at,
          j.population,
          EXISTS (
            SELECT 1 FROM jurisdiction_contacts jc
            WHERE jc.geoid = j.geoid AND jc.email IS NOT NULL AND jc.email <> ''
              AND jc.bounced_at IS NULL
          ) AS has_routing_contact
        FROM jurisdictions j
        WHERE j.geoid = ${geoid}
        LIMIT 1
      `
      const row = rows[0]
      if (!row) return null
      return {
        geoid: row.geoid,
        contactEmails: row.contact_emails,
        contactUpdatedAt: row.contact_updated_at,
        hasRoutingContact: row.has_routing_contact,
        population: row.population,
      }
    },
  }
}
