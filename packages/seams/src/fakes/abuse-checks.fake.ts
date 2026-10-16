import type { AbuseChecks, NearDuplicateResult } from "../interfaces/abuse-checks.js"
import type { LatLng } from "@civfix/contract"
import { haversineKm } from "@civfix/contract"

/** Bytes containing this marker (0x4E 0x53 0x46 0x57 = "NSFW") score as unsafe. */
const NSFW_MARKER = [0x4e, 0x53, 0x46, 0x57]

/** Max plausible distance between two location signals before we flag it. */
const GPS_MAX_KM = 50

function containsMarker(buffer: Uint8Array, marker: number[]): boolean {
  if (marker.length === 0) return false
  for (let i = 0; i + marker.length <= buffer.length; i++) {
    let match = true
    for (let j = 0; j < marker.length; j++) {
      if (buffer[i + j] !== marker[j]) {
        match = false
        break
      }
    }
    if (match) return true
  }
  return false
}

/**
 * In-memory AbuseChecks. Deterministic and dependency-free.
 * - verifyTurnstile: true unless token === "fail"
 * - pHash: deterministic FNV-1a hex of the bytes
 * - isNearDuplicate: tracks hashes seen via markSeen()/pHash() and reports repeats
 * - nsfwScore: 0 unless the bytes contain the "NSFW" marker (then 1)
 * - gpsPlausible: false when any two provided signals are > ~50km apart
 */
export class FakeAbuseChecks implements AbuseChecks {
  private readonly seen = new Map<string, string>() // hash -> first reportId (or hash itself)

  /** The last `expect` arg passed to verifyTurnstile, so tests can assert action propagation. */
  lastVerifyExpect: { action?: string } | undefined

  verifyTurnstile(token: string, _ip: string, expect?: { action?: string }): Promise<boolean> {
    this.lastVerifyExpect = expect
    return Promise.resolve(token !== "fail")
  }

  pHash(buffer: Uint8Array): Promise<string> {
    // FNV-1a 32-bit over the bytes; stable across runs and platforms.
    let h = 0x811c9dc5
    for (let i = 0; i < buffer.length; i++) {
      h ^= buffer[i] ?? 0
      h = Math.imul(h, 0x01000193)
    }
    const hex = (h >>> 0).toString(16).padStart(8, "0")
    return Promise.resolve(`phash_${hex}`)
  }

  isNearDuplicate(hash: string): Promise<NearDuplicateResult> {
    const existing = this.seen.get(hash)
    if (existing !== undefined) {
      return Promise.resolve({ dup: true, ofReportId: existing })
    }
    this.seen.set(hash, hash)
    return Promise.resolve({ dup: false })
  }

  nsfwScore(buffer: Uint8Array): Promise<number> {
    return Promise.resolve(containsMarker(buffer, NSFW_MARKER) ? 1 : 0)
  }

  gpsPlausible(point: LatLng, ipGeo: LatLng | null, exifGeo?: LatLng | null): Promise<boolean> {
    const others: LatLng[] = []
    if (ipGeo) others.push(ipGeo)
    if (exifGeo) others.push(exifGeo)
    for (const other of others) {
      if (haversineKm(point, other) > GPS_MAX_KM) return Promise.resolve(false)
    }
    return Promise.resolve(true)
  }

  /** Test helper: associate a hash with a specific report id for near-dup attribution. */
  markSeen(hash: string, reportId: string): void {
    this.seen.set(hash, reportId)
  }

  reset(): void {
    this.seen.clear()
  }
}
