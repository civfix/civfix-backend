/**
 * The one place a coordinate becomes an address, so reports, events and the preview endpoint can never
 * disagree about what is at a point.
 *
 * THE LADDER, top rung first:
 *
 *   street | intersection | landmark   whatever the provider chain proved (Mapbox when configured, then
 *                                      Photon). The adapters never claim a rung they did not reach.
 *   locality                           the local TIGER "City, ST" label. Always computed, because the
 *                                      contract promises `cityStateLabel` on every response and the
 *                                      creation flows show it as a hint even when the ladder came up
 *                                      empty. Callers treat this rung as NOT LOCATED
 *                                      (@civfix/shared `isLocatedPrecision`).
 *   null                               nothing at all: outside TIGER coverage with a chain miss.
 *
 * A `landmark` line is stored and returned RAW ("Vista Hermosa Park, Los Angeles, CA"). The "Near "
 * prefix is added by the display layer, which is the only one that knows the viewer's language.
 *
 * ONLY A CHAIN ANSWER IS CACHED. The `locality` rung is recomputed on every request - it is a free local
 * PostGIS query, and storing it would give a transient provider outage the 180-day positive TTL and lock
 * every point it touched at city grade for half a year. A chain miss writes the 15-minute NEGATIVE entry
 * instead: it still stops a dragged pin from re-firing the chain per micro-drag, and the chain re-runs
 * (and can upgrade the point) minutes after the outage ends.
 *
 * NEVER BLOCKS, NEVER THROWS. Both halves are best-effort by seam contract, and this is called on the
 * report-create path where a geocoder outage must not cost a filing. A provider that throws, a cache
 * that is unreachable, a TIGER query that fails - each degrades one rung, never into an error.
 */

import {
  geocodePointKey,
  MAX_REPORT_ADDR_LENGTH,
  type AddressPrecision,
  type ReportAddressSource,
} from "@civfix/shared"
import type { Geocoder } from "@civfix/shared"
import type { ReverseGeocode } from "../adapters/reverse-geocode.chain.js"
import { isChainAnswer, NO_GEOCODE_CACHE, type GeocodeCache } from "./geocode-cache.js"

export interface ResolvedAddress {
  /** The display line, or null when nothing resolved. Landmarks are raw - no "Near " prefix. */
  address: string | null
  precision: AddressPrecision | null
  /** ALWAYS a string ("" when even TIGER has nothing) - the contract promises it unconditionally. */
  cityStateLabel: string
}

export type AddressResolver = (lat: number, lng: number) => Promise<ResolvedAddress>

export interface AddressResolverDeps {
  streetReverseGeocode: ReverseGeocode
  geocoder: Pick<Geocoder, "cityStateLabel">
  /** Defaults to no caching, which is correct for a process with no database. */
  cache?: GeocodeCache
}

const NOT_RESOLVED: ResolvedAddress = { address: null, precision: null, cityStateLabel: "" }

async function orNull<T>(p: Promise<T | null>): Promise<T | null> {
  try {
    return await p
  } catch {
    return null
  }
}

function topRung(
  hit: { line: string; precision: AddressPrecision } | null,
  cityStateLabel: string,
): ResolvedAddress {
  if (hit !== null) return { address: hit.line, precision: hit.precision, cityStateLabel }
  if (cityStateLabel.length > 0) {
    return { address: cityStateLabel, precision: "locality", cityStateLabel }
  }
  return { address: null, precision: null, cityStateLabel }
}

export function makeAddressResolver(deps: AddressResolverDeps): AddressResolver {
  const cache = deps.cache ?? NO_GEOCODE_CACHE

  return async (lat: number, lng: number): Promise<ResolvedAddress> => {
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return NOT_RESOLVED

    const pointKey = geocodePointKey({ lat, lng })
    const cached = await orNull(cache.read(pointKey))
    if (cached !== null && isChainAnswer(cached)) {
      return {
        address: cached.address,
        precision: cached.precision,
        cityStateLabel: cached.cityStateLabel,
      }
    }
    const chainAlreadyMissed = cached !== null

    const [hit, label] = await Promise.all([
      chainAlreadyMissed ? null : orNull(deps.streetReverseGeocode(lat, lng)),
      orNull(deps.geocoder.cityStateLabel(lat, lng)),
    ])

    const cityStateLabel = label ?? ""
    const resolved = topRung(hit, cityStateLabel)

    if (hit !== null || !chainAlreadyMissed) {
      await orNull(
        cache.write(pointKey, {
          address: hit?.line ?? null,
          precision: hit?.precision ?? null,
          cityStateLabel,
          provider: hit?.provider ?? null,
        }),
      )
    }

    return resolved
  }
}

export interface ReportAddressWrite {
  addr: string | null
  addrSource: ReportAddressSource | null
  addrPrecision: AddressPrecision | null
}

/**
 * Shared by the signed-in and anonymous create paths so the two can never drift: they write the same
 * column and are read by the same DTO.
 *
 * The reporter's own text always wins and is marked 'user' with NO precision: a provider rung would be a
 * claim about text no provider produced. Otherwise the server's resolve is stored as 'resolved' with the
 * rung it actually reached - INCLUDING `locality`, which is the behavior reports have always had (a
 * "City, ST" line beat an empty one at the curb) and is now merely labelled honestly instead of being
 * indistinguishable from a street address.
 */
export function addressProvenance(
  suppliedAddr: string,
  resolved: ResolvedAddress | null,
): ReportAddressWrite {
  if (suppliedAddr.length > 0) {
    return { addr: suppliedAddr, addrSource: "user", addrPrecision: null }
  }
  if (resolved === null || resolved.address === null) {
    return { addr: null, addrSource: null, addrPrecision: null }
  }
  return {
    addr: resolved.address.slice(0, MAX_REPORT_ADDR_LENGTH),
    addrSource: "resolved",
    addrPrecision: resolved.precision,
  }
}

/**
 * Call a resolver on the report-create path. `makeAddressResolver` already fails open, but this is the
 * ONE place where an address is optional and a filing is not, so the guarantee is re-stated at the call
 * site rather than inherited: an injected resolver that rejects (a test double, a future wrapper, a dep
 * someone swaps in) must cost the address, never the report.
 */
export async function resolveAddressOrNull(
  resolve: AddressResolver | undefined,
  lat: number,
  lng: number,
): Promise<ResolvedAddress | null> {
  if (resolve === undefined) return null
  try {
    return await resolve(lat, lng)
  } catch {
    return null
  }
}
