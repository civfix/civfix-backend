/**
 * Read-through cache for reverse geocodes (`geocode_cache`, migration 0179).
 *
 * A reverse geocode is stable per point and the SAME point is resolved several times over one
 * creation flow: the client previews it while the host drags the pin (debounced, rounded to 5 decimals),
 * then the create path resolves it again server-side. Keying on the shared `geocodePointKey` - the same
 * 5-decimal rounding the client's preview query uses - collapses all of that onto one row, so a pin
 * fine-tune is a cache hit rather than a fresh provider call, and the create that follows a preview
 * costs zero provider calls.
 *
 * ONLY A CHAIN ANSWER IS A POSITIVE ENTRY. A row earns the long TTL when the provider chain proved a
 * located rung (street | intersection | landmark). The `locality` rung never reaches this table at all:
 * it comes from a free local TIGER query, so the resolver recomputes it per request rather than letting
 * a provider blip freeze a point at city grade for half a year.
 *
 * TTL IS APPLIED ON READ, never by a cron: a row past its TTL is reported as a miss and overwritten in
 * place by the fresh resolve. Two TTLs, and the difference matters:
 *
 *   - POSITIVE (180 days), for a chain answer. Addresses do not move.
 *   - NEGATIVE (15 minutes), for everything else. A chain miss IS cached, briefly: that is what stops a
 *     dragged pin over a genuinely unaddressable point - or a provider that is down right now - from
 *     re-firing the whole chain per micro-drag. Expiring it in minutes is what lets the chain re-run,
 *     and upgrade the point, minutes after an outage ends.
 *
 * Expired rows are OVERWRITTEN, not deleted, so the table is bounded by the `geocode_cache` lane of the
 * media-worker's `retention.sweep` (docs/retention-cleanup.md) rather than by this module.
 *
 * EVERY DB ERROR IS SWALLOWED. The cache is an optimisation on a seam whose entire contract is "best
 * effort, never blocks a submit". A cache table that is missing, locked or unreachable must degrade to
 * "no cache", never to a failed report.
 */

import { isLocatedPrecision, type AddressPrecision } from "@civfix/shared"
import type { Queryable } from "../db/client.js"
import { makeDrizzleGeocodeCacheRepository } from "./geocode-cache-repository.drizzle.js"

export const GEOCODE_CACHE_TTL_MS = 180 * 24 * 60 * 60 * 1000
export const GEOCODE_CACHE_NEGATIVE_TTL_MS = 15 * 60 * 1000

export interface GeocodeCacheEntry {
  address: string | null
  precision: AddressPrecision | null
  cityStateLabel: string
  provider: string | null
}

export interface GeocodeCache {
  read(pointKey: string): Promise<GeocodeCacheEntry | null>
  write(pointKey: string, entry: GeocodeCacheEntry): Promise<void>
}

/**
 * The one definition of "worth the long TTL", read by the freshness rule here and by the resolver that
 * decides what to store.
 */
export function isChainAnswer(entry: {
  address: string | null
  precision: AddressPrecision | null
}): boolean {
  return entry.address !== null && isLocatedPrecision(entry.precision)
}

export function isFreshEntry(
  row: { address: string | null; precision: AddressPrecision | null; resolvedAt: Date },
  now: Date,
): boolean {
  const ttl = isChainAnswer(row) ? GEOCODE_CACHE_TTL_MS : GEOCODE_CACHE_NEGATIVE_TTL_MS
  return now.getTime() - row.resolvedAt.getTime() < ttl
}

export interface GeocodeCacheOptions {
  /**
   * Resolve the connection lazily and per call. It THROWS when the process has no database (the fully
   * faked offline server), which is exactly why every use here sits inside a try/catch.
   */
  getSql: () => Queryable
  now?: () => Date
}

export function makeGeocodeCache(opts: GeocodeCacheOptions): GeocodeCache {
  const now = opts.now ?? ((): Date => new Date())
  return {
    async read(pointKey: string): Promise<GeocodeCacheEntry | null> {
      try {
        const row = await makeDrizzleGeocodeCacheRepository(opts.getSql()).findByPointKey(pointKey)
        if (row === undefined) return null
        const fresh = isFreshEntry(
          { address: row.address, precision: row.address_precision, resolvedAt: row.resolved_at },
          now(),
        )
        if (!fresh) return null
        return {
          address: row.address,
          precision: row.address_precision,
          cityStateLabel: row.city_state_label ?? "",
          provider: row.provider,
        }
      } catch {
        return null
      }
    },

    async write(pointKey: string, entry: GeocodeCacheEntry): Promise<void> {
      try {
        await makeDrizzleGeocodeCacheRepository(opts.getSql()).upsert(pointKey, entry, now)
      } catch {
        return
      }
    },
  }
}

/** The wiring for a process with no database. */
export const NO_GEOCODE_CACHE: GeocodeCache = {
  read: async () => null,
  write: async () => undefined,
}
