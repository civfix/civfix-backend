/**
 * Never throws: any failure resolves to `null` so report creation does not depend on an external geocoder
 * being reachable.
 *
 * Precision ladder. Photon/OSM chronically lacks house numbers, so a single "nearest feature" answer is
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

const PHOTON_REVERSE_URL = "https://photon.komoot.io/reverse"
const DEFAULT_TIMEOUT_MS = 4000
/** Enough to see a cross street and a POI beside the nearest hit in one call. */
const REVERSE_LIMIT = 5
/** Photon takes the radius in KILOMETRES. */
const REVERSE_RADIUS_KM = 0.05
/** Two roads only compose an intersection when BOTH are essentially at the pin. */
const INTERSECTION_RADIUS_M = 40
/** A park or plaza entrance is not its centroid, so a landmark may sit a little further out. */
const LANDMARK_RADIUS_M = 60

const EARTH_RADIUS_M = 6_371_000

const PROVIDER_NAME = "photon"
const RESPONSE_LANGUAGE = "en"

const HOME_COUNTRY_NAMES: ReadonlySet<string> = new Set([
  "United States",
  "United States of America",
])

const RESIDENTIAL_PLACE_VALUES: ReadonlySet<string> = new Set(["house", "farm"])

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

function addressLine(p: PhotonReverseProps, primary: string): string {
  const tail = [
    p.city && p.city !== primary ? p.city : null,
    p.state,
    p.country && !HOME_COUNTRY_NAMES.has(p.country) ? p.country : null,
  ].filter((v): v is string => !!v)
  return [primary, ...tail].join(", ")
}

export function formatPhotonReverse(p: PhotonReverseProps): string | null {
  const street = [p.housenumber, p.street].filter(Boolean).join(" ").trim()
  const primary = street || p.name || p.district || p.city || ""
  if (!primary) return null
  return addressLine(p, primary)
}

export function isResidentialName(p: PhotonReverseProps): boolean {
  if (p.osm_key === "building") return true
  return (
    p.osm_key === "place" && p.osm_value !== undefined && RESIDENTIAL_PLACE_VALUES.has(p.osm_value)
  )
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

export type ComposedLine = { line: string; precision: AddressPrecision }

export function composePhotonReverse(
  features: PhotonFeature[],
  at: { lat: number; lng: number },
): ComposedLine | null {
  const candidates = nearestFirst(features, at)
  return exactAddress(candidates) ?? nearbyRoads(candidates) ?? nearbyLandmark(candidates)
}

function nearestFirst(features: PhotonFeature[], at: { lat: number; lng: number }): Candidate[] {
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
  return candidates.sort((a, b) => a.meters - b.meters)
}

function exactAddress(candidates: Candidate[]): ComposedLine | null {
  const exact = candidates.find((c) => !!c.props.housenumber?.trim() && !!c.props.street?.trim())
  if (!exact) return null
  const line = formatPhotonReverse(exact.props)
  return line ? { line, precision: "street" } : null
}

function nearbyRoads(candidates: Candidate[]): ComposedLine | null {
  const roads: string[] = []
  let roadProps: PhotonReverseProps | null = null
  for (const c of candidates) {
    if (c.meters > INTERSECTION_RADIUS_M) continue
    const road = namedRoad(c.props)
    if (road === null || roads.includes(road)) continue
    roads.push(road)
    roadProps ??= c.props
  }
  if (roadProps === null || roads[0] === undefined) return null
  const primary = roads.length >= 2 ? `${roads[0]} & ${roads[1]}` : roads[0]
  return { line: addressLine(roadProps, primary), precision: "intersection" }
}

function nearbyLandmark(candidates: Candidate[]): ComposedLine | null {
  for (const c of candidates) {
    if (c.meters > LANDMARK_RADIUS_M) continue
    const name = landmarkName(c.props)
    if (name === null) continue
    return { line: addressLine(c.props, name), precision: "landmark" }
  }
  return null
}

export interface PhotonReverseOptions {
  url?: string
  timeoutMs?: number
  fetchImpl?: typeof fetch
}

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
      u.searchParams.set("lang", RESPONSE_LANGUAGE)
      u.searchParams.set("limit", String(REVERSE_LIMIT))
      u.searchParams.set("radius", String(REVERSE_RADIUS_KM))
      url = u.toString()
    } catch {
      // A misconfigured base URL must not throw out of a best-effort geocode.
      return null
    }
    // redirect:"error" (the helper's default) keeps a MITM Photon from 30x-ing us to an internal host.
    const data = await fetchJsonOrNull<{ features?: PhotonFeature[] }>(url, {
      timeoutMs,
      ...(doFetch !== undefined ? { fetchImpl: doFetch } : {}),
      init: { headers: { Accept: "application/json" } },
    })
    const composed = composePhotonReverse(data?.features ?? [], { lat, lng })
    return composed === null ? null : { ...composed, provider: PROVIDER_NAME }
  }
}
