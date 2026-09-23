/**
 * Opt-in primary, selected only when MAPBOX_TOKEN is set: Mapbox interpolates rooftop addresses where OSM
 * has no house number, but it is a spend decision, so nothing requires it. Never throws; null on any
 * failure.
 *
 * Mapbox answers a coordinate in the middle of nowhere with the city name. Returning that would claim a
 * rung this adapter did not reach and short-circuit the rest of the chain with the least specific line,
 * so only `street` (a house number is present) and `intersection` (a named street, no number) are
 * returned; anything coarser goes to the next provider.
 */

import type { AddressPrecision } from "@civfix/shared"
import type { ReverseGeocode, ReverseResult } from "./reverse-geocode.chain.js"
import { fetchJsonOrNull } from "./http-fetch.js"

const MAPBOX_REVERSE_URL = "https://api.mapbox.com/search/geocode/v6/reverse"
const DEFAULT_TIMEOUT_MS = 4000

interface MapboxReverseContext {
  address?: { name?: string; address_number?: string; street_name?: string }
  street?: { name?: string }
  place?: { name?: string }
  region?: { name?: string; region_code?: string }
  country?: { name?: string; country_code?: string }
}
export interface MapboxReverseProps {
  name?: string
  feature_type?: string
  full_address?: string
  place_formatted?: string
  context?: MapboxReverseContext
}

export interface MapboxReverseOptions {
  token: string
  url?: string
  timeoutMs?: number
  fetchImpl?: typeof fetch
}

export function formatMapboxReverse(p: MapboxReverseProps): string | null {
  const ctx = p.context ?? {}
  const primary = p.name || ctx.address?.name || ctx.street?.name || ctx.place?.name || ""
  if (!primary) return null
  const region = ctx.region?.region_code ?? ctx.region?.name ?? null
  const cc = ctx.country?.country_code
  const tail = [
    ctx.place?.name && ctx.place.name !== primary ? ctx.place.name : null,
    region,
    cc && cc.toUpperCase() !== "US" ? (ctx.country?.name ?? cc.toUpperCase()) : null,
  ].filter((v): v is string => !!v)
  return [primary, ...tail].join(", ")
}

/**
 * A leading house number earns the `street` rung, but ONLY on a label the response itself calls an
 * address. A digit can lead any POI name ("24 Hour Fitness"), and a POI is not a rooftop.
 */
function startsWithHouseNumber(name: string | undefined): boolean {
  return name !== undefined && /^\d/.test(name.trim())
}

export function mapboxPrecision(p: MapboxReverseProps): AddressPrecision | null {
  const ctx = p.context ?? {}
  const hasNumber =
    (ctx.address?.address_number?.trim().length ?? 0) > 0 ||
    startsWithHouseNumber(ctx.address?.name) ||
    (p.feature_type === "address" && startsWithHouseNumber(p.name))
  if (hasNumber) return "street"
  const named = ctx.street?.name ?? ctx.address?.street_name ?? null
  if (named !== null && named.trim().length > 0) return "intersection"
  return null
}

export function makeMapboxReverseGeocode(opts: MapboxReverseOptions): ReverseGeocode {
  const baseUrl = opts.url ?? MAPBOX_REVERSE_URL
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  // Left undefined when not injected so the helper resolves globalThis.fetch at CALL time.
  const doFetch = opts.fetchImpl
  return async (lat: number, lng: number): Promise<ReverseResult | null> => {
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null
    let url: string
    try {
      const u = new URL(baseUrl)
      u.searchParams.set("longitude", String(lng))
      u.searchParams.set("latitude", String(lat))
      u.searchParams.set("access_token", opts.token)
      u.searchParams.set("limit", "1")
      u.searchParams.set("types", "address")
      u.searchParams.set("language", "en")
      url = u.toString()
    } catch {
      return null
    }
    const data = await fetchJsonOrNull<{ features?: { properties?: MapboxReverseProps }[] }>(url, {
      timeoutMs,
      ...(doFetch !== undefined ? { fetchImpl: doFetch } : {}),
      init: { headers: { Accept: "application/json" } },
    })
    const props = data?.features?.[0]?.properties
    if (!props) return null
    const precision = mapboxPrecision(props)
    if (precision === null) return null
    const line = formatMapboxReverse(props)
    return line === null ? null : { line, precision, provider: "mapbox" }
  }
}
