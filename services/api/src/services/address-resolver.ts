/**
 * The one place a coordinate becomes an address.
 *
 * Before this existed there were two answers to "what is at this point" and they disagreed: reports got
 * the street-level chain collapsed to a bare string, events got nothing at all, and the only
 * client-callable endpoint returned TIGER's "City, ST". This composes all of it once, honestly, and
 * hands every caller the same shape.
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

/** Coords -> the resolved address. The dep every service and route takes. */
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
      chainAlreadyMissed ? Promise.resolve(null) : orNull(deps.streetReverseGeocode(lat, lng)),
      orNull(Promise.resolve(deps.geocoder.cityStateLabel(lat, lng))),
    ])

    const cityStateLabel = label ?? ""
    const resolved: ResolvedAddress =
      hit !== null
        ? { address: hit.line, precision: hit.precision, cityStateLabel }
        : cityStateLabel.length > 0
          ? { address: cityStateLabel, precision: "locality", cityStateLabel }
          : { address: null, precision: null, cityStateLabel }

    if (hit !== null) {
      await orNull(
        cache.write(pointKey, {
          address: hit.line,
          precision: hit.precision,
          cityStateLabel,
          provider: hit.provider,
        }),
      )
    } else if (!chainAlreadyMissed) {
      await orNull(
        cache.write(pointKey, {
          address: null,
          precision: null,
          cityStateLabel,
          provider: null,
        }),
      )
    }

    return resolved
  }
}

/** What a report row records about its address: the text, where it came from, and how exact it is. */
export interface ReportAddressWrite {
  addr: string | null
  addrSource: ReportAddressSource | null
  addrPrecision: AddressPrecision | null
}

/**
 * Decide a report's address provenance at creation. Shared by the signed-in and anonymous paths so the
 * two can never drift - they already write the same column and are read by the same DTO.
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
