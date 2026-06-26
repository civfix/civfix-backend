/** A street-level reverse geocoder: coords -> one-line address, or null. Photon + Mapbox conform. */
export type ReverseGeocode = (lat: number, lng: number) => Promise<string | null>

/**
 * Compose reverse geocoders into one that tries each in order and returns the first non-null result.
 * null/undefined entries are skipped, so callers can pass `cond ? make() : null` inline.
 */
export function chainReverse(...providers: Array<ReverseGeocode | null | undefined>): ReverseGeocode {
  const active = providers.filter((p): p is ReverseGeocode => typeof p === "function")
  return async (lat: number, lng: number): Promise<string | null> => {
    for (const p of active) {
      const r = await p(lat, lng)
      if (r) return r
    }
    return null
  }
}
