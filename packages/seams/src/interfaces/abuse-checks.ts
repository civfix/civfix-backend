import type { LatLng } from "@civfix/contract"

/**
 * Abuse / integrity checks behind a vendor-neutral interface: Turnstile, perceptual hashing,
 * near-duplicate detection, NSFW scoring, and GPS plausibility.
 */

export interface NearDuplicateResult {
  dup: boolean
  ofReportId?: string
}

export interface AbuseChecks {
  verifyTurnstile(token: string, ip: string, expect?: { action?: string }): Promise<boolean>
  pHash(buffer: Uint8Array): Promise<string>
  isNearDuplicate(hash: string): Promise<NearDuplicateResult>
  /** Returns a 0..1 score; higher means more likely NSFW. */
  nsfwScore(buffer: Uint8Array): Promise<number>
  gpsPlausible(point: LatLng, ipGeo: LatLng | null, exifGeo?: LatLng | null): Promise<boolean>
}
