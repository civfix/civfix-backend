/**
 * REAL AbuseChecks adapter: Cloudflare Turnstile verification, perceptual hashing + near-duplicate
 * detection, NSFW scoring, and GPS plausibility.
 *
 * SCAFFOLD: bodies throw until later steps wire Turnstile (HTTP), pHash, the dup index, and the
 * NSFW model. NSFW specifically is gated by USE_FAKE_ABUSE_NSFW.
 *
 * Seam rule: the Turnstile HTTP client and any NSFW model SDK are confined to this file.
 */

import { AppError } from "@civfix/shared"
import type { AbuseChecks, NearDuplicateResult } from "@civfix/shared/interfaces"
import type { LatLng } from "@civfix/shared"

export interface AbuseChecksConfig {
  turnstileSecret?: string
}

const NOT_IMPL = "adapter not implemented: abuse-checks"

export class RealAbuseChecks implements AbuseChecks {
  private readonly config: AbuseChecksConfig

  constructor(config: AbuseChecksConfig = {}) {
    this.config = config
  }

  verifyTurnstile(_token: string, _ip: string): Promise<boolean> {
    return Promise.reject(AppError.internal(NOT_IMPL))
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

  gpsPlausible(_point: LatLng, _ipGeo: LatLng | null, _exifGeo?: LatLng | null): Promise<boolean> {
    return Promise.reject(AppError.internal(NOT_IMPL))
  }
}
