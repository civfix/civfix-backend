/**
 * Jurisdiction service: resolve a map point to the government that owns it, and keep the routing
 * metadata fresh by queueing a discovery task whenever a resolved jurisdiction is missing contacts or
 * has gone stale.
 *
 * Spatial access rule: ALL geometry goes through the raw postgres-js tag and the single canonical
 * query in db/sql/jurisdiction.ts (resolveJurisdiction). We never map PostGIS geometry through the
 * Drizzle ORM. The follow-up "is this jurisdiction healthy?" read selects only scalar columns
 * (contact_emails, contact_updated_at), so it is safe to run through the same `sql` tag.
 *
 * Discovery-enqueue idempotency: the decision is the PURE function `needsDiscovery(row, now)` so it is
 * unit-testable with no DB. When it returns true we enqueue ONE job via the Jobs seam with
 * `singletonKey = geoid`; pg-boss collapses concurrent/duplicate enqueues for the same key into a
 * single active job, and the worker that materializes the task row is further guarded by the partial
 * UNIQUE(geoid) WHERE status <> 'done' index (0001_core.sql). So a hot point that resolves repeatedly
 * to an unconfigured jurisdiction never spawns duplicate open discovery tasks.
 */

import type { JurisdictionDTO } from "@civfix/shared"
import type { Geocoder, Jobs } from "@civfix/shared/interfaces"
import type { Sql } from "../db/client.js"
import { resolveJurisdiction } from "../db/sql/jurisdiction.js"

/** Job name for the jurisdiction-discovery queue. The worker fills in contact info for a geoid. */
export const JURISDICTION_DISCOVERY_JOB = "jurisdiction.discovery"

/** Contact metadata is considered stale once it is older than this many months. */
export const CONTACT_STALE_MONTHS = 18

/** Payload enqueued for a discovery task. Kept minimal; the worker re-reads the row by geoid. */
export interface JurisdictionDiscoveryJob {
  geoid: string
  population?: number | null
}

/**
 * The subset of a jurisdiction row the discovery decision needs. Declared structurally (not the full
 * Drizzle row) so `needsDiscovery` stays a pure function testable from a plain object.
 */
export interface JurisdictionHealthRow {
  geoid: string
  /** contact_emails text[]; null or empty means "no known contact" -> needs discovery. */
  contactEmails: string[] | null
  /** contact_updated_at timestamptz; null or older than CONTACT_STALE_MONTHS -> needs discovery. */
  contactUpdatedAt: Date | null
  population?: number | null
}

/**
 * PURE decision: does this jurisdiction need a (re)discovery pass as of `now`?
 *
 * True when EITHER it has no usable contact emails (null/empty/all-blank), OR its contact metadata is
 * missing a timestamp, OR that timestamp is older than CONTACT_STALE_MONTHS. False only for a
 * jurisdiction that both has a contact and was refreshed within the window.
 *
 * No DB, no clock of its own: `now` is injected so callers (and tests) control time.
 */
export function needsDiscovery(row: JurisdictionHealthRow, now: Date): boolean {
  const hasContact = Array.isArray(row.contactEmails) && row.contactEmails.some((e) => e.trim() !== "")
  if (!hasContact) return true

  if (!(row.contactUpdatedAt instanceof Date) || Number.isNaN(row.contactUpdatedAt.getTime())) {
    return true
  }

  const staleBefore = new Date(now)
  staleBefore.setMonth(staleBefore.getMonth() - CONTACT_STALE_MONTHS)
  return row.contactUpdatedAt.getTime() < staleBefore.getTime()
}

export interface JurisdictionServiceDeps {
  /** Raw postgres-js tag (dbHandle.sql) for the spatial + scalar reads. */
  sql: Sql
  /** Reverse-geocoder seam used to derive the "City, ST" label. */
  geocoder: Geocoder
  /** Jobs seam used to enqueue discovery tasks idempotently. */
  jobs: Jobs
  /** Injectable clock (defaults to Date.now) so staleness is deterministic in tests. */
  now?: () => Date
}

export interface JurisdictionService {
  /**
   * Resolve the jurisdiction containing (lat, lng) into a JurisdictionDTO, or null when the point is
   * outside all known coverage. As a side effect, enqueues a discovery task when the resolved
   * jurisdiction needs one. Resolution is returned regardless of the discovery outcome.
   */
  resolveForPoint(lat: number, lng: number): Promise<JurisdictionDTO | null>
}

export function makeJurisdictionService(deps: JurisdictionServiceDeps): JurisdictionService {
  const now = deps.now ?? (() => new Date())

  return {
    async resolveForPoint(lat: number, lng: number): Promise<JurisdictionDTO | null> {
      // Canonical spatial query (place -> county -> state). Note (lng, lat) order.
      const resolved = await resolveJurisdiction(deps.sql, lng, lat)
      if (!resolved) return null

      // Health read: scalar columns only, keyed by the geoid we just resolved.
      const health = await loadHealth(deps.sql, resolved.geoid)
      if (health && needsDiscovery(health, now())) {
        await enqueueDiscovery(deps.jobs, health)
      }

      // Label: prefer the geocoder seam; fall back to the jurisdiction name if it cannot produce one.
      const label = (await deps.geocoder.cityStateLabel(lat, lng)) ?? resolved.name

      return {
        geoid: resolved.geoid,
        name: resolved.name,
        layer: resolved.layer,
        cityStateLabel: label,
      }
    },
  }
}

/** Load the discovery-relevant scalar columns for a geoid. Returns null if the row vanished. */
async function loadHealth(sql: Sql, geoid: string): Promise<JurisdictionHealthRow | null> {
  const rows = await sql<
    { geoid: string; contact_emails: string[] | null; contact_updated_at: Date | null; population: number | null }[]
  >`
    SELECT geoid, contact_emails, contact_updated_at, population
    FROM jurisdictions
    WHERE geoid = ${geoid}
    LIMIT 1
  `
  const row = rows[0]
  if (!row) return null
  return {
    geoid: row.geoid,
    contactEmails: row.contact_emails,
    contactUpdatedAt: row.contact_updated_at,
    population: row.population,
  }
}

/** Enqueue exactly one idempotent discovery job for a jurisdiction (singletonKey = geoid). */
async function enqueueDiscovery(jobs: Jobs, row: JurisdictionHealthRow): Promise<void> {
  const data: JurisdictionDiscoveryJob = {
    geoid: row.geoid,
    ...(row.population !== undefined ? { population: row.population } : {}),
  }
  await jobs.enqueue(JURISDICTION_DISCOVERY_JOB, data, { singletonKey: row.geoid })
}
