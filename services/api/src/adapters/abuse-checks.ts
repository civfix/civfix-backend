/**
 * REAL AbuseChecks adapter: Cloudflare Turnstile verification, perceptual hashing + near-duplicate
 * detection, NSFW scoring, and GPS plausibility.
 *
 * Seam rule: the Turnstile HTTP client (the only vendor call here) is confined to this file. The NSFW
 * model + perceptual-dup index are a flag-gated pre-launch follow-up (plan sections 3/20) that swap the
 * pHash/isNearDuplicate/nsfwScore bodies only; in dev / when USE_FAKE_ABUSE_NSFW is on, the DI selects
 * FakeAbuseChecks so those scaffolded bodies are never hit. verifyTurnstile (this step) and gpsPlausible
 * (a pure distance check) are fully implemented.
 */

import { AppError } from "@civfix/shared"
import type { AbuseChecks, NearDuplicateResult } from "@civfix/shared/interfaces"
import type { LatLng } from "@civfix/shared"
import { haversineKm } from "@civfix/shared"

export interface AbuseChecksConfig {
  turnstileSecret?: string
}

const NOT_IMPL = "adapter not implemented: abuse-checks"

/** Cloudflare Turnstile server-side verification endpoint. */
const TURNSTILE_VERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify"

/** Max plausible distance (km) between two independent location signals before we flag the point. */
const GPS_MAX_KM = 50

/** Shape of the Turnstile siteverify JSON response (only the field we consume is typed). */
interface TurnstileVerifyResponse {
  success?: boolean
}

export class RealAbuseChecks implements AbuseChecks {
  private readonly config: AbuseChecksConfig

  constructor(config: AbuseChecksConfig = {}) {
    this.config = config
  }

  /**
   * Verify a Turnstile token against Cloudflare's siteverify endpoint. The secret + token + (optional)
   * client IP are POSTed as form-encoded fields; Cloudflare returns `{ success: boolean, ... }`. We
   * return that boolean and DO NOT throw on a "not successful" outcome (a failed challenge is a normal,
   * expected result the caller maps to AppError.turnstileFailed). A missing secret is a configuration
   * error (this adapter is only selected when USE_FAKE_ABUSE_NSFW is OFF, i.e. production), so we throw
   * INTERNAL. A network/transport failure also throws INTERNAL (fail closed: we cannot confirm a human).
   */
  async verifyTurnstile(token: string, ip: string): Promise<boolean> {
    const secret = this.config.turnstileSecret
    if (!secret) {
      throw AppError.internal("Turnstile secret not configured (CF_TURNSTILE_SECRET)")
    }

    const body = new URLSearchParams()
    body.set("secret", secret)
    body.set("response", token)
    // remoteip is optional but recommended; only send a real value.
    if (ip && ip.length > 0) body.set("remoteip", ip)

    let res: Response
    try {
      res = await fetch(TURNSTILE_VERIFY_URL, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body,
      })
    } catch (err) {
      // Transport failure: we cannot confirm a human, so fail closed by surfacing an error. (Preserve
      // the cause on the Error chain without depending on the AppError factory accepting options.)
      const wrapped = AppError.internal("Turnstile verification request failed")
      ;(wrapped as { cause?: unknown }).cause = err
      throw wrapped
    }

    if (!res.ok) {
      throw AppError.internal(`Turnstile verification returned HTTP ${res.status}`)
    }

    const json = (await res.json()) as TurnstileVerifyResponse
    return json.success === true
  }

  pHash(_buffer: Uint8Array): Promise<string> {
    return Promise.reject(AppError.internal(NOT_IMPL))
  }

  isNearDuplicate(_hash: string): Promise<NearDuplicateResult> {
    return Promise.reject(AppError.internal(NOT_IMPL))
  }

  nsfwScore(_buffer: Uint8Array): Promise<number> {
    return Promise.reject(AppError.internal(NOT_IMPL))
  }

  /**
   * Plausibility of a submitted point against independent signals (coarse IP geo, EXIF GPS). Pure
   * great-circle distance: the point is implausible when it sits more than ~50 km from ANY provided
   * signal. A null/omitted signal is simply not compared (no signal cannot make a point implausible),
   * so with no signals at all the point is plausible. Mirrors FakeAbuseChecks so "plausible" means the
   * same thing in dev and prod.
   */
  gpsPlausible(point: LatLng, ipGeo: LatLng | null, exifGeo?: LatLng | null): Promise<boolean> {
    const signals: LatLng[] = []
    if (ipGeo) signals.push(ipGeo)
    if (exifGeo) signals.push(exifGeo)
    for (const signal of signals) {
      if (haversineKm(point, signal) > GPS_MAX_KM) return Promise.resolve(false)
    }
    return Promise.resolve(true)
  }
}
