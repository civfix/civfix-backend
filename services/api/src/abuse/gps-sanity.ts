import type { AbuseChecks } from "@civfix/shared/interfaces"
import type { LatLng } from "@civfix/shared"

export const CF_LAT_HEADER = "cf-iplatitude"
export const CF_LNG_HEADER = "cf-iplongitude"
export const CF_CITY_HEADER = "cf-ipcity"

export type HeaderBag = Record<string, string | string[] | undefined>

export function headerValue(headers: HeaderBag, name: string): string | null {
  const raw = headers[name]
  const value = Array.isArray(raw) ? raw[0] : raw
  const trimmed = value?.trim()
  return trimmed && trimmed.length > 0 ? trimmed : null
}

export function parseCfGeo(headers: HeaderBag): LatLng | null {
  const latRaw = headerValue(headers, CF_LAT_HEADER)
  const lngRaw = headerValue(headers, CF_LNG_HEADER)
  if (latRaw === null || lngRaw === null) return null

  const lat = Number.parseFloat(latRaw)
  const lng = Number.parseFloat(lngRaw)
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null
  return { lat, lng }
}

export function cfGeoFromTrustedEdge(req: { ips?: readonly string[] | undefined }): boolean {
  return Array.isArray(req.ips) && req.ips.length > 1
}

export interface GpsSanityInput {
  point: LatLng
  ipGeo: LatLng | null
}

export interface GpsSanityDeps {
  abuseChecks: AbuseChecks
  log?: (line: string, extra?: Record<string, unknown>) => void
}

export interface GpsSanityResult {
  ok: boolean
  reason: "no_signal" | "plausible" | "implausible"
}

export async function gpsSanityCheck(
  input: GpsSanityInput,
  deps: GpsSanityDeps,
): Promise<GpsSanityResult> {
  const log = deps.log ?? (() => {})

  if (input.ipGeo === null) {
    log("gps-sanity: no coarse IP geo available; passing (deferring any EXIF check to the worker)")
    return { ok: true, reason: "no_signal" }
  }

  const plausible = await deps.abuseChecks.gpsPlausible(input.point, input.ipGeo, undefined)
  return { ok: plausible, reason: plausible ? "plausible" : "implausible" }
}
