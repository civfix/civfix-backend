/**
 * Read-through cache for reverse geocodes (`geocode_cache`, migration 0175).
 *
 * WHY. A reverse geocode is stable per point and the SAME point is resolved several times over one
 * creation flow: the client previews it while the host drags the pin (debounced, rounded to 5 decimals),
 * then the create path resolves it again server-side. Keying on the shared `geocodePointKey` - the same
 * 5-decimal rounding the client's preview query uses - collapses all of that onto one row, so a pin
 * fine-tune is a cache hit rather than a fresh provider call, and the create that follows a preview
 * costs zero provider calls.
 *
 * TTL IS APPLIED ON READ, never by a cron: a row past its TTL is reported as a miss and overwritten in
 * place by the fresh resolve. Two TTLs, and the difference matters:
 *
 *   - POSITIVE (180 days). Addresses do not move.
 *   - NEGATIVE (15 minutes). A null IS cached, briefly: that is what stops a dragged pin over a
 *     genuinely unaddressable point - or a provider that is down right now - from re-firing the whole
 *     chain per micro-drag. Expiring it in minutes is what stops a provider OUTAGE from poisoning those
 *     points for half a year, which is the failure mode the design spec called out.
 *
 * EVERY DB ERROR IS SWALLOWED. The cache is an optimisation on a seam whose entire contract is "best
 * effort, never blocks a submit". A cache table that is missing, locked or unreachable must degrade to
 * "no cache", never to a failed report.
 */

import type { AddressPrecision } from "@civfix/shared"
import type { Queryable } from "../db/client.js"

/** A resolved address line past this age is re-resolved (and the row overwritten) on next read. */
export const GEOCODE_CACHE_TTL_MS = 180 * 24 * 60 * 60 * 1000
/** A negative entry ("the providers had nothing") is trusted for minutes, not months. */
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

interface GeocodeCacheRowSelect {
  address: string | null
  address_precision: AddressPrecision | null
  city_state_label: string | null
  provider: string | null
  resolved_at: Date
}

/** True while the row may still be served. Negative rows (no address) expire far sooner. */
export function isFreshEntry(row: { address: string | null; resolvedAt: Date }, now: Date): boolean {
  const ttl = row.address === null ? GEOCODE_CACHE_NEGATIVE_TTL_MS : GEOCODE_CACHE_TTL_MS
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
        const sql = opts.getSql()
        const rows = await sql<GeocodeCacheRowSelect[]>`
          SELECT address, address_precision, city_state_label, provider, resolved_at
          FROM geocode_cache
          WHERE point_key = ${pointKey}
          LIMIT 1
        `
        const row = rows[0]
        if (row === undefined) return null
        if (!isFreshEntry({ address: row.address, resolvedAt: row.resolved_at }, now())) return null
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
        const sql = opts.getSql()
        await sql`
          INSERT INTO geocode_cache (
            point_key, address, address_precision, city_state_label, provider, resolved_at
          ) VALUES (
            ${pointKey},
            ${entry.address},
            ${entry.precision},
            ${entry.cityStateLabel},
            ${entry.provider},
            ${now()}
          )
          ON CONFLICT (point_key) DO UPDATE SET
            address = EXCLUDED.address,
            address_precision = EXCLUDED.address_precision,
            city_state_label = EXCLUDED.city_state_label,
            provider = EXCLUDED.provider,
            resolved_at = EXCLUDED.resolved_at
        `
      } catch {
        // See the header: a cache write can never be the reason a submit fails.
      }
    },
  }
}

/** A cache that never hits and never stores - the wiring for a process with no database. */
export const NO_GEOCODE_CACHE: GeocodeCache = {
  read: async () => null,
  write: async () => undefined,
}
