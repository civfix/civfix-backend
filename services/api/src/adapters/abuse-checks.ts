/**
 * REAL AbuseChecks adapter: Cloudflare Turnstile verification, perceptual hashing + near-duplicate
 * detection, NSFW scoring, and GPS plausibility.
 *
 * SEAM RULES honored here:
 *   - The Turnstile HTTP client (a vendor call) is confined to this file.
 *   - sharp/ffmpeg are NOT imported here (they live in the media-worker's sandbox/). The real
 *     perceptual hash is INJECTED via config.perceptualHash (the worker wires sandbox/phash.ts); with
 *     no hasher injected we fall back to a pure, dependency-free byte hash so this adapter is usable
 *     (and NEVER throws) in the API process too.
 *   - The near-duplicate lookup is INJECTED via config.findPhashDuplicate (the worker can wire a
 *     media_assets phash query); with none injected it returns the documented benign default
 *     { dup: false } rather than throwing.
 *
 * DEFAULT-FLAG PRODUCTION PUBLISHES BENIGN MEDIA. nsfwScore returns 0 (benign) by default and logs once
 * that the NSFW model is not configured. A real model is a flag-gated follow-up behind USE_REAL_NSFW
 * (config.useRealNsfw): when true AND a scorer is wired (config.nsfwModel) it scores for real; when true
 * with no scorer it logs and STILL returns benign (it does NOT throw). NSFW is fully decoupled from
 * Turnstile + gpsPlausible, which stay real regardless. This removes the old failure where nsfwScore
 * threw "not implemented", the media.checks pipeline failed CLOSED, and 100% of media was held forever
 * (so the anon hold-release never published).
 */

import { AppError } from "@civfix/shared"
import type { AbuseChecks, NearDuplicateResult } from "@civfix/shared/interfaces"
import type { LatLng } from "@civfix/shared"
import { haversineKm } from "@civfix/shared"

/** An injected real perceptual hasher (the worker wires sandbox/phash.ts perceptualHash). */
export type PerceptualHashFn = (buffer: Uint8Array) => Promise<string>

/** An injected NSFW scorer (a real model). Returns a 0..1 score. */
export type NsfwScoreFn = (buffer: Uint8Array) => Promise<number>

/**
 * Options for a near-duplicate lookup. `excludeAssetId` is the id of the asset CURRENTLY being processed
 * so the query never matches the asset against its OWN persisted row (a job re-delivery recomputes the
 * same phash, and without this exclusion the asset would be flagged a near-duplicate of itself - P0-2).
 */
export interface FindPhashDuplicateOpts {
  excludeAssetId?: string
}

/** An injected near-duplicate lookup over an existing phash index (e.g. a media_assets query). */
export type FindPhashDuplicateFn = (
  hash: string,
  opts?: FindPhashDuplicateOpts,
) => Promise<NearDuplicateResult>

export interface AbuseChecksConfig {
  turnstileSecret?: string
  /**
   * Gate for the real NSFW model. Default false: nsfwScore returns benign (0). When true AND nsfwModel
   * is provided, it scores for real; when true with no model it logs once and still returns benign.
   */
  useRealNsfw?: boolean
  /** The real NSFW scorer, wired only when a model is vendored. Absent -> benign default. */
  nsfwModel?: NsfwScoreFn
  /** Real perceptual hasher (worker injects sandbox/phash.ts). Absent -> pure byte-hash fallback. */
  perceptualHash?: PerceptualHashFn
  /** Real near-duplicate lookup. Absent -> documented benign default { dup: false }. */
  findPhashDuplicate?: FindPhashDuplicateFn
  /** Structured log sink (defaults to console.warn). Injectable for tests. */
  log?: (line: string, extra?: Record<string, unknown>) => void
}

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
  private readonly log: (line: string, extra?: Record<string, unknown>) => void
  /** One-shot guard so the "NSFW not configured" notice logs once, not per asset. */
  private nsfwNoticeLogged = false

  constructor(config: AbuseChecksConfig = {}) {
    this.config = config
    this.log = config.log ?? ((line, extra) => console.warn(line, extra ?? {}))
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

  /**
   * Perceptual hash for near-duplicate detection. Uses the injected real hasher when present (the worker
   * wires the sharp-based dHash from sandbox/phash.ts); otherwise computes a stable, dependency-free
   * 64-bit FNV-1a hash over the bytes so it ALWAYS returns a hex string and never throws. NOTE: the
   * fallback is a byte hash (not perceptual), so visually-similar images do not collide; that is fine
   * for the API process (which never calls pHash) and for a worker without sharp, and the real
   * perceptual signal is used wherever the worker injects it.
   */
  async pHash(buffer: Uint8Array): Promise<string> {
    if (this.config.perceptualHash) {
      return this.config.perceptualHash(buffer)
    }
    return fnv1a64Hex(buffer)
  }

  /**
   * Near-duplicate check. Delegates to the injected lookup (e.g. a media_assets phash query) when wired;
   * otherwise returns the documented benign default { dup: false } (fail open) rather than throwing, so
   * a missing dedupe index never blocks legitimate uploads.
   */
  async isNearDuplicate(hash: string): Promise<NearDuplicateResult> {
    if (this.config.findPhashDuplicate) {
      return this.config.findPhashDuplicate(hash)
    }
    return { dup: false }
  }

  /**
   * NSFW score (0..1; higher = more likely NSFW). DEFAULT BENIGN: returns 0 unless a real model is
   * wired AND enabled via USE_REAL_NSFW. This guarantees default-flag production PUBLISHES benign media
   * instead of holding everything. It NEVER throws (the old "not implemented" reject made the worker
   * fail closed and hold 100% of media); a "true but no model" misconfiguration logs once and still
   * returns benign.
   */
  async nsfwScore(buffer: Uint8Array): Promise<number> {
    if (this.config.useRealNsfw && this.config.nsfwModel) {
      return this.config.nsfwModel(buffer)
    }
    if (!this.nsfwNoticeLogged) {
      this.nsfwNoticeLogged = true
      this.log(
        this.config.useRealNsfw
          ? "NSFW model enabled (USE_REAL_NSFW) but not configured; scoring benign (0)"
          : "NSFW model not configured; scoring benign (0). Enable with USE_REAL_NSFW + a model.",
      )
    }
    return 0
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

/**
 * Stable 64-bit FNV-1a hash of the bytes, as a 16-char hex string. Pure + deterministic across runs and
 * platforms; computed as two 32-bit FNV-1a halves (low bytes / high bytes) to stay within JS safe
 * integers without BigInt. This is the dependency-free fallback for pHash (see pHash for the caveat).
 */
function fnv1a64Hex(buffer: Uint8Array): string {
  let lo = 0x811c9dc5
  let hi = 0x811c9dc5
  for (let i = 0; i < buffer.length; i++) {
    const b = buffer[i] ?? 0
    lo = Math.imul(lo ^ b, 0x01000193) >>> 0
    // Perturb the high half with the index so it is not identical to the low half.
    hi = Math.imul(hi ^ (b ^ (i & 0xff)), 0x01000193) >>> 0
  }
  const toHex8 = (n: number): string => (n >>> 0).toString(16).padStart(8, "0")
  return toHex8(hi) + toHex8(lo)
}
