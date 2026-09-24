import type { JurisdictionDTO } from "@civfix/shared"
import type { Geocoder, Jobs } from "@civfix/shared/interfaces"
import type { Sql } from "../db/client.js"
import { resolveJurisdiction } from "../db/sql/jurisdiction.js"
import { legacyContactEmailUsable } from "./admin/sql-fragments.js"
import { formatCityStateLabel, uspsFromGeoid } from "../adapters/geocoder.tiger.js"
import type {
  JurisdictionLookup,
  JurisdictionLookupResult,
} from "../adapters/jurisdiction-lookup.census.js"

export const JURISDICTION_DISCOVERY_JOB = "jurisdiction.discovery"

const CONTACT_STALE_MONTHS = 18

export interface JurisdictionDiscoveryJob {
  geoid: string
  population?: number | null
}

export interface JurisdictionHealthRow {
  geoid: string
  contactEmails: string[] | null
  contactUpdatedAt: Date | null
  hasRoutingContact?: boolean
  population?: number | null
}

function hasUsableLegacyContact(row: Pick<JurisdictionHealthRow, "contactEmails">): boolean {
  return Array.isArray(row.contactEmails) && row.contactEmails.some((e) => e.trim() !== "")
}

function isValidDate(value: Date | null): value is Date {
  return value instanceof Date && !Number.isNaN(value.getTime())
}

function isStale(updatedAt: Date | null, now: Date): boolean {
  if (!isValidDate(updatedAt)) return true
  const staleBefore = new Date(now)
  staleBefore.setMonth(staleBefore.getMonth() - CONTACT_STALE_MONTHS)
  return updatedAt.getTime() < staleBefore.getTime()
}

export function needsDiscovery(row: JurisdictionHealthRow, now: Date): boolean {
  if (row.hasRoutingContact === true) {
    return isValidDate(row.contactUpdatedAt) && isStale(row.contactUpdatedAt, now)
  }
  return !hasUsableLegacyContact(row) || isStale(row.contactUpdatedAt, now)
}

export function isRoutable(
  row: Pick<JurisdictionHealthRow, "hasRoutingContact" | "contactEmails">,
): boolean {
  return row.hasRoutingContact === true || hasUsableLegacyContact(row)
}

export interface JurisdictionServiceDeps {
  sql: Sql
  geocoder: Geocoder
  jobs: Jobs
  jurisdictionLookup?: JurisdictionLookup
  now?: () => Date
}

export interface JurisdictionService {
  resolveForPoint(lat: number, lng: number): Promise<JurisdictionDTO | null>
  exists(geoid: string): Promise<boolean>
}

export function makeJurisdictionService(deps: JurisdictionServiceDeps): JurisdictionService {
  const now = deps.now ?? (() => new Date())

  return {
    async resolveForPoint(lat: number, lng: number): Promise<JurisdictionDTO | null> {
      const resolved = await resolveJurisdiction(deps.sql, lng, lat)
      if (!resolved) {
        return deps.jurisdictionLookup
          ? await resolveViaLookup(deps.sql, deps.jurisdictionLookup, lat, lng)
          : null
      }

      const [health, geoLabel] = await Promise.all([
        loadHealth(deps.sql, resolved.geoid),
        deps.geocoder.cityStateLabel(lat, lng),
      ])
      if (health && needsDiscovery(health, now())) {
        await enqueueDiscovery(deps.jobs, health)
      }

      const label = geoLabel ?? resolved.name

      return {
        geoid: resolved.geoid,
        name: resolved.name,
        layer: resolved.layer,
        cityStateLabel: label,
        routable: health ? isRoutable(health) : false,
      }
    },

    async exists(geoid: string): Promise<boolean> {
      const rows = await deps.sql`SELECT 1 FROM jurisdictions WHERE geoid = ${geoid} LIMIT 1`
      return rows.length > 0
    },
  }
}

const LAYER_PRIORITY: Record<JurisdictionLookupResult["layer"], number> = {
  place: 2,
  county: 3,
  state: 4,
}

async function resolveViaLookup(
  sql: Sql,
  lookup: JurisdictionLookup,
  lat: number,
  lng: number,
): Promise<JurisdictionDTO | null> {
  let hit: JurisdictionLookupResult | null
  try {
    hit = await lookup.lookup(lat, lng)
  } catch {
    // Census is only the fallback after a local miss: its outage leaves the point unmapped and must never
    // fail the report, anon report or cleanup being filed.
    return null
  }
  if (!hit) return null

  await insertApiSourcedJurisdictionIfAbsent(sql, hit)

  return {
    geoid: hit.geoid,
    name: hit.name,
    layer: hit.layer,
    cityStateLabel: formatCityStateLabel(hit.name, uspsFromGeoid(hit.geoid)),
    routable: false,
  }
}

async function insertApiSourcedJurisdictionIfAbsent(
  sql: Sql,
  hit: JurisdictionLookupResult,
): Promise<void> {
  await sql`
    INSERT INTO jurisdictions (geoid, name, layer, priority, geom, contact_emails, code)
    SELECT
      ${hit.geoid}, ${hit.name}, ${hit.layer}, ${LAYER_PRIORITY[hit.layer]}, NULL, NULL,
      nextval('jurisdiction_code_seq')
    WHERE NOT EXISTS (SELECT 1 FROM jurisdictions WHERE geoid = ${hit.geoid})
    ON CONFLICT (geoid) DO NOTHING
  `
}

async function loadHealth(sql: Sql, geoid: string): Promise<JurisdictionHealthRow | null> {
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
}

async function enqueueDiscovery(jobs: Jobs, row: JurisdictionHealthRow): Promise<void> {
  const data: JurisdictionDiscoveryJob = {
    geoid: row.geoid,
    ...(row.population != null ? { population: row.population } : {}),
  }
  await jobs.enqueue(JURISDICTION_DISCOVERY_JOB, data, { singletonKey: row.geoid })
}
