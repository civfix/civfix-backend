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
 * Write-time Census fallback (OPTIONAL, best-effort, dep-gated): when the local resolver MISSES and a
 * `jurisdictionLookup` dep is present, resolveForPoint queries the US Census Geocoder, lazily UPSERTS the
 * most-specific place/county/state it returns as a NULL-geom jurisdiction row, and maps the report to it —
 * so the common municipal case self-maps with zero ops instead of staying "Unmapped". The lookup is best-
 * effort (it never throws and falls through to null on any failure), the upsert is idempotent and PRESERVES
 * operator contacts, and the new row carries no polygon (geom NULL, 0015) so it only ever resolves for its
 * own geoid. When the dep is ABSENT, behavior is exactly today's local-only resolution (backward
 * compatible). See src/adapters/jurisdiction-lookup.census.ts + documents/20-jurisdiction-mapping.md.
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
import { formatCityStateLabel, uspsFromGeoid } from "../adapters/geocoder.tiger.js"
import type {
  JurisdictionLookup,
  JurisdictionLookupResult,
} from "../adapters/jurisdiction-lookup.census.js"

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
  /** contact_emails text[]; null or empty means "no legacy contact". */
  contactEmails: string[] | null
  /** contact_updated_at timestamptz; null or older than CONTACT_STALE_MONTHS -> needs discovery. */
  contactUpdatedAt: Date | null
  /**
   * Phase 2: whether ANY usable jurisdiction_contacts row exists for the geoid (a category-specific OR a
   * default/category-NULL row with a non-empty email). The per-category routing model resolves
   * category-specific -> default -> legacy contact_emails[]; a present jurisdiction_contacts row means
   * the jurisdiction IS routable even if the legacy contact_emails[] column is still empty. Optional +
   * defaulting to false so the decision stays BACKWARD COMPATIBLE: when no jurisdiction_contacts rows
   * exist (the Phase 1 state), the behavior is exactly the legacy contact_emails[] check.
   */
  hasRoutingContact?: boolean
  population?: number | null
}

/**
 * PURE decision: does this jurisdiction need a (re)discovery pass as of `now`?
 *
 * Contact resolution precedence (Phase 2): a jurisdiction is "routable" when it has a per-category /
 * default jurisdiction_contacts row (`hasRoutingContact`) OR a usable legacy contact_emails[] entry.
 *   - No routable contact at all  -> needs discovery (true).
 *   - A jurisdiction_contacts row -> routable now; only the staleness clock can still flag it, and only
 *     when the legacy contact_updated_at is set + old (a fresh save sets contact_updated_at, so a
 *     just-saved contact never re-flags; a contact with no timestamp does NOT re-flag when a
 *     jurisdiction_contacts row exists, since that row is the authoritative routing signal).
 *   - Legacy emails only          -> the Phase 1 behavior: routable but re-flagged when the metadata
 *     timestamp is missing or older than CONTACT_STALE_MONTHS.
 *
 * BACKWARD COMPATIBLE: with `hasRoutingContact` absent/false the function reduces to the original legacy
 * check exactly, so an empty jurisdiction_contacts table changes nothing. No DB, no clock of its own:
 * `now` is injected so callers (and tests) control time.
 */
export function needsDiscovery(row: JurisdictionHealthRow, now: Date): boolean {
  const hasLegacyContact =
    Array.isArray(row.contactEmails) && row.contactEmails.some((e) => e.trim() !== "")
  const hasRoutingContact = row.hasRoutingContact === true

  // No routable contact via either path -> needs discovery.
  if (!hasRoutingContact && !hasLegacyContact) return true

  // A per-category / default jurisdiction_contacts row is the authoritative routing signal: the
  // jurisdiction is routable. It is only re-flagged for staleness when the legacy metadata timestamp is
  // present AND old (a just-saved contact stamps contact_updated_at, so it stays fresh; a missing
  // timestamp does NOT re-flag here, unlike the legacy-only path, because the row itself proves routing).
  if (hasRoutingContact) {
    if (!(row.contactUpdatedAt instanceof Date) || Number.isNaN(row.contactUpdatedAt.getTime())) {
      return false
    }
    const staleBefore = new Date(now)
    staleBefore.setMonth(staleBefore.getMonth() - CONTACT_STALE_MONTHS)
    return row.contactUpdatedAt.getTime() < staleBefore.getTime()
  }

  // Legacy-only path: the Phase 1 behavior (missing/old timestamp re-flags).
  if (!(row.contactUpdatedAt instanceof Date) || Number.isNaN(row.contactUpdatedAt.getTime())) {
    return true
  }
  const staleBefore = new Date(now)
  staleBefore.setMonth(staleBefore.getMonth() - CONTACT_STALE_MONTHS)
  return row.contactUpdatedAt.getTime() < staleBefore.getTime()
}

/**
 * PURE: is this jurisdiction routable RIGHT NOW? True when it has a per-category / default
 * jurisdiction_contacts row (`hasRoutingContact`) OR a usable legacy contact_emails[] entry. This is
 * the inverse of "has no contact at all" and drives the public JurisdictionDTO.routable flag (the
 * report card shows "routes to {name}" when true, vs a "new area, manual review" state when false).
 * Note this is NOT the same as `!needsDiscovery`: a routable jurisdiction can still need a refresh pass
 * when its contact metadata has gone stale, yet it is still routable today.
 */
export function isRoutable(
  row: Pick<JurisdictionHealthRow, "hasRoutingContact" | "contactEmails">,
): boolean {
  const hasLegacy =
    Array.isArray(row.contactEmails) && row.contactEmails.some((e) => e.trim() !== "")
  return row.hasRoutingContact === true || hasLegacy
}

export interface JurisdictionServiceDeps {
  /** Raw postgres-js tag (dbHandle.sql) for the spatial + scalar reads. */
  sql: Sql
  /** Reverse-geocoder seam used to derive the "City, ST" label. */
  geocoder: Geocoder
  /** Jobs seam used to enqueue discovery tasks idempotently. */
  jobs: Jobs
  /**
   * OPTIONAL write-time fallback: when the local PostGIS resolver misses, query the US Census Geocoder,
   * lazily upsert the most-specific match, and map the report. Absent -> today's local-only behavior
   * (backward compatible). Best-effort: the lookup never throws and a miss/failure leaves the point null.
   */
  jurisdictionLookup?: JurisdictionLookup
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
      if (!resolved) {
        // Local MISS. If the optional write-time Census fallback is wired, try to self-map the point;
        // otherwise (dep absent) preserve today's exact local-only behavior and return null ("Unmapped").
        return deps.jurisdictionLookup
          ? await resolveViaLookup(deps.sql, deps.jurisdictionLookup, lat, lng)
          : null
      }

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
        // Whether routing is already configured (public, no contact address exposed). Defaults false
        // when the health row could not be read, so an unknown jurisdiction reads as "manual review".
        routable: health ? isRoutable(health) : false,
      }
    },
  }
}

/**
 * Layer -> `priority` rank for an API-sourced upsert. Matches JURISDICTION_LAYER_RANK_CASE (the resolver's
 * ordering CASE: place 2, county 3, state 4) so a NULL-geom API row sorts identically to a self-hosted one
 * of the same layer. The lookup ONLY ever returns place/county/state (the Census API does not expose
 * federal/tribal ownership), so this map is exhaustive for the values that can reach here.
 */
const LAYER_PRIORITY: Record<JurisdictionLookupResult["layer"], number> = {
  place: 2,
  county: 3,
  state: 4,
}

/**
 * Write-time Census fallback on a LOCAL MISS: query the lookup, and on a hit lazily upsert the returned
 * jurisdiction (NULL geom) and map the report to it. Best-effort throughout — `lookup` never throws and a
 * miss returns null (today's "Unmapped" behavior).
 *
 * The returned DTO is NOT routable: a brand-new contact-less row has no routing configured yet. We do NOT
 * enqueue discovery here — the row simply lacks contacts, which is exactly the state `needsDiscovery` flags
 * on the NEXT resolve of this geoid; keeping the enqueue on the existing health path avoids duplicating the
 * idempotent-enqueue logic (and a fresh self-mapped report does not need its routing resolved synchronously).
 */
async function resolveViaLookup(
  sql: Sql,
  lookup: JurisdictionLookup,
  lat: number,
  lng: number,
): Promise<JurisdictionDTO | null> {
  const hit = await lookup.lookup(lat, lng)
  if (!hit) return null

  await upsertApiSourcedJurisdiction(sql, hit)

  return {
    geoid: hit.geoid,
    name: hit.name,
    layer: hit.layer,
    // "Name, ST" via the FIPS prefix of the (place/county/state) geoid; bare name when the prefix is
    // unknown. Reuses the TIGER geocoder's pure helpers so the label format matches the local-hit path.
    cityStateLabel: formatCityStateLabel(hit.name, uspsFromGeoid(hit.geoid)),
    // Not routable yet: a just-created contact-less row needs discovery before it can route.
    routable: false,
  }
}

/**
 * Lazily upsert an API-sourced jurisdiction (geoid + name + layer, NO polygon). Idempotent by geoid.
 *
 * Geometry access rule: written through the raw `sql` tag like every other jurisdiction write — even though
 * geom is NULL here so no PostGIS function appears (a plain insert), we keep the raw tag for consistency
 * with the house geometry rule (NEVER the Drizzle insert builder for this table).
 *
 * PRESERVATION on conflict (CRITICAL): the ON CONFLICT SET list updates ONLY name + layer. It deliberately
 * does NOT touch:
 *   - geom: an existing self-hosted polygon row keeps its boundary (a later real ingest is never clobbered
 *     by this null-geom fallback; and re-hitting an already-API-sourced row leaves its NULL geom as-is).
 *   - contact_emails / contact_updated_at: operator-mapped / discovered routing is never wiped.
 *   - priority: left as the existing row's value on update (only the fresh INSERT sets it from LAYER_PRIORITY).
 */
async function upsertApiSourcedJurisdiction(
  sql: Sql,
  hit: JurisdictionLookupResult,
): Promise<void> {
  await sql`
    INSERT INTO jurisdictions (geoid, name, layer, priority, geom, contact_emails)
    VALUES (${hit.geoid}, ${hit.name}, ${hit.layer}, ${LAYER_PRIORITY[hit.layer]}, NULL, NULL)
    ON CONFLICT (geoid) DO UPDATE SET
      name = EXCLUDED.name,
      layer = EXCLUDED.layer
  `
}

/**
 * Load the discovery-relevant scalar columns for a geoid. Returns null if the row vanished.
 *
 * Phase 2: also probes jurisdiction_contacts for ANY usable routing row (a category-specific OR a
 * default/category-NULL row with a non-empty email) so `needsDiscovery` consults the per-category routing
 * model (category-specific -> default -> legacy contact_emails[]). `has_routing_contact` is false when the
 * table has no row for the geoid, which keeps the legacy-only behavior unchanged (backward compatible).
 */
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
      j.contact_emails,
      j.contact_updated_at,
      j.population,
      EXISTS (
        SELECT 1 FROM jurisdiction_contacts jc
        WHERE jc.geoid = j.geoid AND jc.email IS NOT NULL AND jc.email <> ''
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

/** Enqueue exactly one idempotent discovery job for a jurisdiction (singletonKey = geoid). */
async function enqueueDiscovery(jobs: Jobs, row: JurisdictionHealthRow): Promise<void> {
  const data: JurisdictionDiscoveryJob = {
    geoid: row.geoid,
    ...(row.population !== undefined ? { population: row.population } : {}),
  }
  await jobs.enqueue(JURISDICTION_DISCOVERY_JOB, data, { singletonKey: row.geoid })
}
