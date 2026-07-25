/**
 * Route-level wiring for the jurisdiction + reverse-geocode seams.
 *
 * The reports, anon, cleanups and map plugins all need the same two things: "which government owns this
 * point" and "what address is at this point". Each used to build the closures inline, so the wiring drifted
 * — map.routes silently omitted `jurisdictionLookup`, which made POST /map/resolve-jurisdiction answer
 * "not covered" for a point that self-maps via the Census fallback the moment the same user submits a
 * report there. One builder per seam keeps the coverage answer consistent across every surface.
 *
 * Everything here touches `container.getDb()` INSIDE the returned closure: a route may build a resolver at
 * mount time, and merely mounting a plugin must never open a DB connection.
 */

import type { Container } from "../di.js"
import {
  CachedJurisdictionLookup,
  type JurisdictionLookup,
} from "../adapters/jurisdiction-lookup.census.js"
import { makeJurisdictionService, type JurisdictionService } from "./jurisdiction-service.js"

/** Coords -> geoid (or null outside coverage) / one-line address (or null). Matches the service deps. */
export type PointToString = (lat: number, lng: number) => Promise<string | null>

/**
 * ONE memoizing lookup wrapper per container, kept at module scope because the SERVICE is rebuilt per
 * request (a per-service cache would never see a second call). Keyed by container — not a bare module
 * singleton — so a process holding several containers (the test suites do) never serves one container's
 * cached coverage answers to another, and so the cache is collected with the container.
 */
const CACHED_LOOKUPS = new WeakMap<Container, JurisdictionLookup>()

function cachedLookupFor(container: Container): JurisdictionLookup {
  const existing = CACHED_LOOKUPS.get(container)
  if (existing !== undefined) return existing
  const wrapped = new CachedJurisdictionLookup(container.jurisdictionLookup)
  CACHED_LOOKUPS.set(container, wrapped)
  return wrapped
}

export interface RouteJurisdictionServiceOptions {
  /**
   * Wrap the Census lookup in the process-local TTL memo (CachedJurisdictionLookup) instead of calling it
   * per request. OFF by default; see makeRouteJurisdictionService for which surfaces opt in and why.
   */
  cacheLookup?: boolean
}

/**
 * The JurisdictionService as every route wires it, INCLUDING the write-time Census fallback: on a local
 * PostGIS miss the point self-maps to the most specific Census place instead of staying "Unmapped"
 * (fake/no-op outside production). Census spend is bounded by the callers' per-route rate limits.
 *
 * `cacheLookup` does NOT change the coverage answer — same resolver, same fallback, same lazily-inserted
 * row; it only stops the SAME point from re-fetching Census on every request (the fallback's row has a NULL
 * geom, so it never becomes a local hit — see jurisdiction-service's header). It is opted into by the
 * anon-ok read surface (POST /map/resolve-jurisdiction: unauthenticated, csrf-less, IP-keyed, and a pure
 * question about a coordinate) and deliberately NOT by the report/anon/cleanup SUBMIT paths, which write a
 * row whose jurisdiction_geoid is an FK into `jurisdictions` and must therefore observe live coverage
 * rather than a memo (an ops boundary prune between two submits would otherwise fail the insert).
 */
export function makeRouteJurisdictionService(
  container: Container,
  options: RouteJurisdictionServiceOptions = {},
): JurisdictionService {
  return makeJurisdictionService({
    sql: container.getDb().sql,
    geocoder: container.geocoder,
    jobs: container.jobs,
    jurisdictionLookup:
      options.cacheLookup === true ? cachedLookupFor(container) : container.jurisdictionLookup,
  })
}

/** resolveJurisdictionGeoid dep: the owning jurisdiction's geoid for a point, or null when uncovered. */
export function makeGeoidResolver(container: Container): PointToString {
  return async (lat, lng) => {
    const resolved = await makeRouteJurisdictionService(container).resolveForPoint(lat, lng)
    return resolved?.geoid ?? null
  }
}

/**
 * reverseGeocode dep: street-level first (Mapbox/Photon chain), falling back to the local "City, ST"
 * label. Best-effort by contract — null leaves the address empty and never blocks a submit.
 */
export function makeReverseGeocoder(container: Container): PointToString {
  return async (lat, lng) =>
    (await container.streetReverseGeocode(lat, lng)) ?? container.geocoder.cityStateLabel(lat, lng)
}
