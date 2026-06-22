/**
 * GPS sanity check for a submitted report point.
 *
 * The submitted lat/lng is compared against whatever independent location signals we have:
 *   (a) a COARSE IP geolocation, read here from Cloudflare-provided request headers when present, and
 *   (b) the EXIF GPS of the attached media - but EXIF lives in the untrusted bytes, which only the
 *       media-worker decodes, so the EXIF cross-check is DEFERRED to the worker's release gate (see
 *       releaseAnonHoldIfReady). This module does the IP-geo check at submit time.
 *
 * TRUSTED-EDGE GATE (P1-2): CF-IPLatitude/CF-IPLongitude are authentic ONLY when Cloudflare set them.
 * A client that can reach the API by any path OTHER than the CF/trusted-proxy edge can forge those
 * headers to equal its submitted point, defeating the check. So we honor the CF geo headers ONLY when
 * the request demonstrably arrived through a trusted upstream (see `cfGeoFromTrustedEdge`, which keys
 * off Fastify's own trusted-proxy determination). From an UNTRUSTED source the headers are IGNORED, and
 * the check then has no contradicting signal -> it PASSES ("no_signal"). That fail-open is an explicit,
 * logged decision: GPS sanity is one of several anon controls and held reports stay hidden, so a missing
 * coarse signal must not block a legitimate report. It is documented here so a re-reviewer sees the
 * trade is intentional, not an oversight.
 *
 * The actual distance decision is delegated to AbuseChecks.gpsPlausible (threshold ~50 km, shared with
 * the worker so "plausible" means the same thing everywhere). This module's job is to (1) parse the
 * coarse IP geo out of the (trusted) Cloudflare headers, and (2) when NO geo source is available, PASS
 * with a logged note rather than blocking a legitimate report on missing data (fail-open on absent signal).
 *
 * `parseCfGeo` is pure (header bag -> LatLng | null); `gpsSanityCheck` is the thin async wrapper over
 * the AbuseChecks seam, so both are unit-testable with a plain object + FakeAbuseChecks.
 */

import type { AbuseChecks } from "@civfix/shared/interfaces"
import type { LatLng } from "@civfix/shared"

// Cloudflare's "Add visitor location headers" transform sets these (city-level coarse — the right
// granularity for a ~50 km gate). Node/Fastify lowercase header names, so we read the lowercase forms.
export const CF_LAT_HEADER = "cf-iplatitude"
export const CF_LNG_HEADER = "cf-iplongitude"
export const CF_COUNTRY_HEADER = "cf-ipcountry"

/** A minimal case-insensitive header bag (the subset of FastifyRequest.headers we read). */
export type HeaderBag = Record<string, string | string[] | undefined>

function header(headers: HeaderBag, name: string): string | null {
  const raw = headers[name]
  const value = Array.isArray(raw) ? raw[0] : raw
  const trimmed = value?.trim()
  return trimmed && trimmed.length > 0 ? trimmed : null
}

/**
 * Parse the coarse IP geolocation from Cloudflare request headers. PURE. Returns a LatLng when BOTH a
 * finite, in-range latitude and longitude headers are present, else null (e.g. when not fronted by
 * Cloudflare, or when CF only set the country). CF-IPCountry alone does not yield a point; it is read
 * only so a caller can log/observe coverage.
 */
export function parseCfGeo(headers: HeaderBag): LatLng | null {
  const latRaw = header(headers, CF_LAT_HEADER)
  const lngRaw = header(headers, CF_LNG_HEADER)
  if (latRaw === null || lngRaw === null) return null

  const lat = Number.parseFloat(latRaw)
  const lng = Number.parseFloat(lngRaw)
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null
  return { lat, lng }
}

/**
 * Whether a request demonstrably arrived through a TRUSTED upstream proxy/edge, so its forwarded CF geo
 * headers can be believed (P1-2). PURE.
 *
 * We key off Fastify's own trusted-proxy determination: `request.ips` is the X-Forwarded-For chain
 * Fastify TRUSTED (leftmost original client first, the direct peer last) - it is only longer than one
 * entry when Fastify trusted at least one forwarding hop for this request. With our env trustProxy
 * configured to trust ONLY the internal proxy ranges (see plugins/trust-proxy), `ips.length > 1` means
 * a trusted proxy forwarded the request; a direct/untrusted client yields a single entry (its own
 * address), so its CF-* headers are NOT believed. When trustProxy is off entirely, `ips` is undefined
 * and we treat the edge as untrusted.
 *
 * Accepts a minimal shape so it is unit-testable with a plain object (no live Fastify request).
 */
export function cfGeoFromTrustedEdge(req: { ips?: readonly string[] | undefined }): boolean {
  return Array.isArray(req.ips) && req.ips.length > 1
}

export interface GpsSanityInput {
  /** The point the client submitted. */
  point: LatLng
  /** Coarse IP geo (from parseCfGeo), or null when unavailable. */
  ipGeo: LatLng | null
}

export interface GpsSanityDeps {
  abuseChecks: AbuseChecks
  /** Structured log sink for the "no geo source" pass note (defaults to a no-op). */
  log?: (line: string, extra?: Record<string, unknown>) => void
}

export interface GpsSanityResult {
  /** True when the point is plausible (or there was no signal to contradict it). */
  ok: boolean
  /** Why it passed/failed (for logs + the timeline/abuse note). */
  reason: "no_signal" | "plausible" | "implausible"
}

/**
 * Run the submit-time GPS sanity check. When no coarse IP geo is available we PASS with reason
 * "no_signal" (and log it) rather than penalizing a legitimate report for missing data. When IP geo IS
 * available we defer the distance decision to AbuseChecks.gpsPlausible (~50 km). The EXIF cross-check
 * is intentionally NOT done here (the bytes are not decoded at the API layer); the worker performs it
 * before releasing a hold. Never throws; returns a decision object the caller maps to its policy.
 */
export async function gpsSanityCheck(
  input: GpsSanityInput,
  deps: GpsSanityDeps,
): Promise<GpsSanityResult> {
  const log = deps.log ?? (() => {})

  if (input.ipGeo === null) {
    log("gps-sanity: no coarse IP geo available; passing (deferring any EXIF check to the worker)", {
      lat: input.point.lat,
      lng: input.point.lng,
    })
    return { ok: true, reason: "no_signal" }
  }

  // EXIF is deferred to the worker (undefined here), so only the IP-geo signal is compared at submit.
  const plausible = await deps.abuseChecks.gpsPlausible(input.point, input.ipGeo, undefined)
  return { ok: plausible, reason: plausible ? "plausible" : "implausible" }
}
