import type { ReverseGeocode } from "./reverse-geocode.chain.js"

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
  const doFetch = opts.fetchImpl ?? fetch
  return async (lat: number, lng: number): Promise<string | null> => {
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const url = new URL(baseUrl)
      url.searchParams.set("longitude", String(lng))
      url.searchParams.set("latitude", String(lat))
      url.searchParams.set("access_token", opts.token)
      url.searchParams.set("limit", "1")
      url.searchParams.set("types", "address")
      url.searchParams.set("language", "en")
      const res = await doFetch(url.toString(), {
        signal: controller.signal,
        headers: { Accept: "application/json" },
        redirect: "error",
      })
      if (!res.ok) return null
      const data = (await res.json()) as { features?: { properties?: MapboxReverseProps }[] }
      const props = data.features?.[0]?.properties
      return props ? formatMapboxReverse(props) : null
    } catch {
      return null
    } finally {
      clearTimeout(timer)
    }
  }
}
