/**
 * Best-effort street-level reverse geocoder backed by the public Photon instance (the same service the
 * clients use for FORWARD address autocomplete). Turns a report's pin into a one-line human address
 * ("123 Imperial Hwy, Inglewood, CA") so the report list/detail show a location label even when the
 * reporter never typed an address.
 *
 * Contract: NEVER throws and NEVER blocks. Any failure (network, HTTP error, timeout, no result, bad
 * coords) resolves to `null` so the caller falls back (to the local City, ST label) or simply stores no
 * address - report creation must not depend on an external geocoder being reachable.
 */

/** Public Photon reverse endpoint. Self-host + override via the factory `url` for higher volume. */
const PHOTON_REVERSE_URL = "https://photon.komoot.io/reverse"
/** Cap the geocode so a slow/hung Photon never delays a report submit. */
const DEFAULT_TIMEOUT_MS = 4000

interface PhotonReverseProps {
  name?: string
  housenumber?: string
  street?: string
  city?: string
  district?: string
  state?: string
  country?: string
}

/**
 * Format a Photon reverse feature into a single human address line. Prefers a "<number> <street>" line,
 * else the place `name`/district, then appends the city/state (and country when it is not the US) -
 * skipping any part already used as the primary. Returns null when nothing usable is present.
 */
export function formatPhotonReverse(p: PhotonReverseProps): string | null {
  const street = [p.housenumber, p.street].filter(Boolean).join(" ").trim()
  const primary = street || p.name || p.district || p.city || ""
  if (!primary) return null
  const tail = [
    p.city && p.city !== primary ? p.city : null,
    p.state,
    p.country && p.country !== "United States" && p.country !== "United States of America"
      ? p.country
      : null,
  ].filter((v): v is string => !!v)
  return [primary, ...tail].join(", ")
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
 * Build a `(lat, lng) => Promise<string | null>` reverse geocoder. Returns null on ANY failure so it is
 * safe to call in the report-create hot path (the caller treats null as "no address").
 */
export function makePhotonReverseGeocode(
  opts: PhotonReverseOptions = {},
): (lat: number, lng: number) => Promise<string | null> {
  const baseUrl = opts.url ?? PHOTON_REVERSE_URL
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const doFetch = opts.fetchImpl ?? fetch

  return async (lat: number, lng: number): Promise<string | null> => {
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const url = new URL(baseUrl)
      url.searchParams.set("lat", String(lat))
      url.searchParams.set("lon", String(lng))
      url.searchParams.set("lang", "en")
      const res = await doFetch(url.toString(), {
        signal: controller.signal,
        headers: { Accept: "application/json" },
      })
      if (!res.ok) return null
      const data = (await res.json()) as { features?: { properties?: PhotonReverseProps }[] }
      const props = data.features?.[0]?.properties
      return props ? formatPhotonReverse(props) : null
    } catch {
      // Network / abort / parse failure: degrade to null (the caller falls back or stores no address).
      return null
    } finally {
      clearTimeout(timer)
    }
  }
}
