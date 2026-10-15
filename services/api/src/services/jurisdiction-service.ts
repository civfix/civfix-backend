import type { JurisdictionDTO } from "@civfix/shared"
import type { Geocoder, Jobs } from "@civfix/shared/interfaces"
import type { Sql } from "../db/client.js"
import { formatCityStateLabel, uspsFromGeoid } from "../adapters/geocoder.tiger.js"
import type {
  JurisdictionLookup,
  JurisdictionLookupResult,
} from "../adapters/jurisdiction-lookup.census.js"
import { makeDrizzleJurisdictionRepository } from "./jurisdiction-repository.drizzle.js"
import type { JurisdictionRepository } from "./jurisdiction-repository.js"
import { JURISDICTION_DISCOVERY_JOB } from "../lib/queue-names.js"

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
  const jurisdictions = makeDrizzleJurisdictionRepository(deps.sql)

  return {
    async resolveForPoint(lat: number, lng: number): Promise<JurisdictionDTO | null> {
      const resolved = await jurisdictions.resolveContaining(lng, lat)
      if (!resolved) {
        return deps.jurisdictionLookup
          ? await resolveViaLookup(jurisdictions, deps.jurisdictionLookup, lat, lng)
          : null
      }

      const [health, geoLabel] = await Promise.all([
        jurisdictions.loadHealth(resolved.geoid),
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
      return jurisdictions.exists(geoid)
    },
  }
}

async function resolveViaLookup(
  jurisdictions: JurisdictionRepository,
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

  await jurisdictions.insertApiSourcedIfAbsent(hit)

  return {
    geoid: hit.geoid,
    name: hit.name,
    layer: hit.layer,
    cityStateLabel: formatCityStateLabel(hit.name, uspsFromGeoid(hit.geoid)),
    routable: false,
  }
}

async function enqueueDiscovery(jobs: Jobs, row: JurisdictionHealthRow): Promise<void> {
  const data: JurisdictionDiscoveryJob = {
    geoid: row.geoid,
    ...(row.population != null ? { population: row.population } : {}),
  }
  await jobs.enqueue(JURISDICTION_DISCOVERY_JOB, data, { singletonKey: row.geoid })
}
