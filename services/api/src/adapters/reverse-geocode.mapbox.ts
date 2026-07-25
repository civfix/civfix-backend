import type { ReverseGeocode } from "./reverse-geocode.chain.js"
import { fetchJsonOrNull } from "./http-fetch.js"

const MAPBOX_REVERSE_URL = "https://api.mapbox.com/search/geocode/v6/reverse"
const DEFAULT_TIMEOUT_MS = 4000

interface MapboxReverseContext {
  address?: { name?: string }
  street?: { name?: string }
  place?: { name?: string }
  region?: { name?: string; region_code?: string }
  country?: { name?: string; country_code?: string }
}
interface MapboxReverseProps {
  name?: string
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

export function redactMapboxToken(url: string): string {
  return url.replace(/([?&]access_token=)[^&#\s]*/gi, "$1[redacted]")
}

export function makeMapboxReverseGeocode(opts: MapboxReverseOptions): ReverseGeocode {
  const baseUrl = opts.url ?? MAPBOX_REVERSE_URL
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  // Left undefined when not injected so the helper resolves globalThis.fetch at CALL time.
  const doFetch = opts.fetchImpl
  return async (lat: number, lng: number): Promise<string | null> => {
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
    return props ? formatMapboxReverse(props) : null
  }
}
