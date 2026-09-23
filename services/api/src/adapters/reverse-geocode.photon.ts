/**
 * Best-effort street-level reverse geocoder backed by the public Photon instance (the same service the
 * clients use for FORWARD address autocomplete). Turns a pin into a one-line human address
 * ("123 Imperial Hwy, Inglewood, CA") so a report or event shows a real location instead of "City, ST".
 *
 * Contract: NEVER throws and NEVER blocks. Any failure (network, HTTP error, timeout, no result, bad
 * coords) resolves to `null` so the caller falls back (to the local City, ST label) or simply stores no
 * address - report creation must not depend on an external geocoder being reachable.
 *
 * PRECISION LADDER. Photon/OSM chronically lacks house numbers, so a single "nearest feature" answer is
 * either exact or wildly overconfident. One request (limit=5, radius=50 m) buys the whole ladder:
 *
 *   street       house number + street on one feature        "123 Main St, Inglewood, CA"
 *   intersection two distinct named roads within ~40 m       "Main St & 5th Ave, Inglewood, CA"
 *                (one road only -> the bare street)          "Main St, Inglewood, CA"
 *   landmark     a named POI within ~60 m and no road        "Vista Hermosa Park, Los Angeles, CA"
 *
 * and `locality` is never produced here - that rung belongs to the local TIGER geocoder, which is
 * authoritative for it and needs no network. Returning a city name from THIS adapter would also
 * short-circuit the chain's remaining providers with the worst answer available.
 *
 * The landmark rung carries a hard guard: a residential building or `place=house` feature is skipped
 * outright. Those carry occupant or family names in OSM often enough that surfacing one would publish a
 * private residence label next to a public pin, and the line degrades to the road or to locality with no
 * loss the reader can even perceive.
 */

import type { AddressPrecision } from "@civfix/shared"
import type { ReverseGeocode, ReverseResult } from "./reverse-geocode.chain.js"
import { fetchJsonOrNull } from "./http-fetch.js"

/** Public Photon reverse endpoint. Self-host + override via the factory `url` for higher volume. */
const PHOTON_REVERSE_URL = "https://photon.komoot.io/reverse"
/** Cap the geocode so a slow/hung Photon never delays a report submit. */
const DEFAULT_TIMEOUT_MS = 4000
/** Features per request. Enough to see a cross street and a POI beside the nearest hit; still one call. */
const REVERSE_LIMIT = 5
/** Photon's search radius, in KILOMETRES. 50 m bounds the whole candidate set to "at this pin". */
const REVERSE_RADIUS_KM = 0.05
/** Two roads only compose an intersection when BOTH are essentially at the pin. */
const INTERSECTION_RADIUS_M = 40
/** A landmark may sit a little further out - a park or plaza entrance is not its centroid. */
const LANDMARK_RADIUS_M = 60

const EARTH_RADIUS_M = 6_371_000

/** OSM keys whose named features are real public landmarks worth naming beside a pin. */
const LANDMARK_KEYS = new Set([
  "amenity",
  "leisure",
  "tourism",
  "shop",
  "historic",
  "natural",
  "railway",
  "aeroway",
])

export interface PhotonReverseProps {
  name?: string
  housenumber?: string
  street?: string
  city?: string
  district?: string
  state?: string
  country?: string
  osm_key?: string
  osm_value?: string
}

interface PhotonFeature {
  properties?: PhotonReverseProps
  geometry?: { coordinates?: [number, number] }
}

/** Metres between two WGS84 points (haversine). Only ever used at sub-kilometre scale. */
export function distanceMeters(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number },
): number {
  const toRad = (d: number): number => (d * Math.PI) / 180
  const dLat = toRad(b.lat - a.lat)
  const dLng = toRad(b.lng - a.lng)
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(s)))
}

/** "<primary>, City, ST" - skips whatever is already the primary and drops a US country. */
function addressLine(p: PhotonReverseProps, primary: string): string {
  const tail = [
    p.city && p.city !== primary ? p.city : null,
    p.state,
    p.country && p.country !== "United States" && p.country !== "United States of America"
      ? p.country
      : null,
  ].filter((v): v is string => !!v)
  return [primary, ...tail].join(", ")
}

/**
 * Format a Photon reverse feature into a single human address line. Prefers a "<number> <street>" line,
 * else the place `name`/district, then appends the city/state (and country when it is not the US) -
 * skipping any part already used as the primary. Returns null when nothing usable is present.
 *
 * Kept exported and unchanged in shape: it is the formatter for a SINGLE feature, which the ladder below
 * composes with. It deliberately makes no precision claim of its own.
 */
export function formatPhotonReverse(p: PhotonReverseProps): string | null {
  const street = [p.housenumber, p.street].filter(Boolean).join(" ").trim()
  const primary = street || p.name || p.district || p.city || ""
  if (!primary) return null
  return addressLine(p, primary)
}

/** True when a feature's `name` could be a private residence label rather than a public landmark. */
export function isResidentialName(p: PhotonReverseProps): boolean {
  if (p.osm_key === "building") return true
  if (p.osm_key === "place" && (p.osm_value === "house" || p.osm_value === "farm")) return true
  return false
}

function namedRoad(p: PhotonReverseProps): string | null {
  if (p.osm_key !== "highway") return null
  const name = p.street ?? p.name ?? null
  return name && name.trim().length > 0 ? name.trim() : null
}

function landmarkName(p: PhotonReverseProps): string | null {
  if (isResidentialName(p)) return null
  if (p.osm_key === undefined || !LANDMARK_KEYS.has(p.osm_key)) return null
  const name = p.name?.trim()
  return name && name.length > 0 ? name : null
}

interface Candidate {
  props: PhotonReverseProps
  meters: number
}

/**
 * Compose the ladder from one Photon response. Exported so the rungs and their guards are unit-testable
 * without a fetch: every branch here is a product decision, not plumbing.
 */
export function composePhotonReverse(
  features: PhotonFeature[],
  at: { lat: number; lng: number },
): { line: string; precision: AddressPrecision } | null {
  const candidates: Candidate[] = []
  for (const f of features) {
    const props = f.properties
    if (!props) continue
    const coords = f.geometry?.coordinates
    const meters =
      Array.isArray(coords) && coords.length === 2 && coords.every((n) => Number.isFinite(n))
        ? distanceMeters(at, { lng: coords[0], lat: coords[1] })
        : Number.POSITIVE_INFINITY
    candidates.push({ props, meters })
  }
  candidates.sort((a, b) => a.meters - b.meters)

  const exact = candidates.find((c) => !!c.props.housenumber?.trim() && !!c.props.street?.trim())
  if (exact) {
    const line = formatPhotonReverse(exact.props)
    if (line) return { line, precision: "street" }
  }

  const roads: string[] = []
  let roadProps: PhotonReverseProps | null = null
  for (const c of candidates) {
    if (c.meters > INTERSECTION_RADIUS_M) continue
    const road = namedRoad(c.props)
    if (road === null || roads.includes(road)) continue
    roads.push(road)
    roadProps ??= c.props
  }
  if (roadProps !== null && roads[0] !== undefined) {
    const primary = roads.length >= 2 ? `${roads[0]} & ${roads[1]}` : roads[0]
    return { line: addressLine(roadProps, primary), precision: "intersection" }
  }

  for (const c of candidates) {
    if (c.meters > LANDMARK_RADIUS_M) continue
    const name = landmarkName(c.props)
    if (name === null) continue
    return { line: addressLine(c.props, name), precision: "landmark" }
  }

  return null
}

export interface PhotonReverseOptions {
  /** Override the Photon reverse base URL (e.g. a self-hosted instance). */
  url?: string
  /** Geocode timeout in ms (default 4000). */
  timeoutMs?: number
  /** Injected fetch (tests). Defaults to the global fetch. */
  fetchImpl?: typeof fetch
}

/**
 * Build a reverse geocoder returning the structured ladder result, or null on ANY failure so it is safe
 * to call in the report-create hot path (the caller treats null as "no address").
 */
export function makePhotonReverseGeocode(opts: PhotonReverseOptions = {}): ReverseGeocode {
  const baseUrl = opts.url ?? PHOTON_REVERSE_URL
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  // Left undefined when not injected so the helper resolves globalThis.fetch at CALL time.
  const doFetch = opts.fetchImpl

  return async (lat: number, lng: number): Promise<ReverseResult | null> => {
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null
    let url: string
    try {
      const u = new URL(baseUrl)
      u.searchParams.set("lat", String(lat))
      u.searchParams.set("lon", String(lng))
      u.searchParams.set("lang", "en")
      u.searchParams.set("limit", String(REVERSE_LIMIT))
      u.searchParams.set("radius", String(REVERSE_RADIUS_KM))
      url = u.toString()
    } catch {
      // A misconfigured base URL must not throw out of a best-effort geocode.
      return null
    }
    // Network / abort / non-2xx / parse failure all degrade to null (the caller falls back or stores no
    // address); redirect:"error" (the helper's default) keeps a MITM Photon from 30x-ing us internally.
    const data = await fetchJsonOrNull<{ features?: PhotonFeature[] }>(url, {
      timeoutMs,
      ...(doFetch !== undefined ? { fetchImpl: doFetch } : {}),
      init: { headers: { Accept: "application/json" } },
    })
    const composed = composePhotonReverse(data?.features ?? [], { lat, lng })
    return composed === null ? null : { ...composed, provider: "photon" }
  }
}
