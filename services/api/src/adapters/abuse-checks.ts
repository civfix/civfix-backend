import { AppError } from "@civfix/shared"
import type { AbuseChecks, NearDuplicateResult } from "@civfix/shared/interfaces"
import type { LatLng } from "@civfix/shared"
import { haversineKm } from "@civfix/shared"
import { fetchJsonWithTimeout, type FetchJsonResult } from "./http-fetch.js"

export type PerceptualHashFn = (buffer: Uint8Array) => Promise<string>

export type NsfwScoreFn = (buffer: Uint8Array) => Promise<number>

export interface FindPhashDuplicateOpts {
  excludeAssetId?: string
  excludeReportId?: string
}

export type FindPhashDuplicateFn = (
  hash: string,
  opts?: FindPhashDuplicateOpts,
) => Promise<NearDuplicateResult>

export interface AbuseChecksConfig {
  turnstileSecret?: string
  turnstileHostnames?: readonly string[]
  useRealNsfw?: boolean
  nsfwModel?: NsfwScoreFn
  perceptualHash?: PerceptualHashFn
  findPhashDuplicate?: FindPhashDuplicateFn
  log?: (line: string, extra?: Record<string, unknown>) => void
}

const TURNSTILE_VERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify"

const TURNSTILE_TIMEOUT_MS = 4000

const GPS_MAX_KM = 50

const FNV1A_32_OFFSET_BASIS = 0x811c9dc5
const FNV1A_32_PRIME = 0x01000193

interface TurnstileVerifyResponse {
  success?: boolean
  hostname?: string
  action?: string
}

export interface TurnstileExpectation {
  action?: string
}

export class RealAbuseChecks implements AbuseChecks {
  private readonly config: AbuseChecksConfig
  private readonly log: (line: string, extra?: Record<string, unknown>) => void
  private nsfwNoticeLogged = false
  private turnstileHostNoticeLogged = false
  private turnstileActionNoticeLogged = false

  constructor(config: AbuseChecksConfig = {}) {
    this.config = config
    this.log = config.log ?? ((line, extra) => console.warn(line, extra ?? {}))
  }

  async verifyTurnstile(
    token: string,
    ip: string,
    expect?: TurnstileExpectation,
  ): Promise<boolean> {
    const secret = this.config.turnstileSecret
    if (!secret) {
      throw AppError.internal("Turnstile secret not configured (CF_TURNSTILE_SECRET)")
    }

    const body = new URLSearchParams()
    body.set("secret", secret)
    body.set("response", token)
    if (ip && ip.length > 0) body.set("remoteip", ip)

    const result = await fetchJsonWithTimeout<TurnstileVerifyResponse>(TURNSTILE_VERIFY_URL, {
      timeoutMs: TURNSTILE_TIMEOUT_MS,
      init: {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body,
      },
    })
    if (!result.ok) throw turnstileFailure(result)

    const json = result.json
    if (json.success !== true) return false

    if (!this.hostnameAccepted(json.hostname)) {
      this.log("Turnstile token rejected: unexpected hostname", { hostname: json.hostname })
      return false
    }
    return expect?.action === undefined || this.actionAccepted(json.action, expect.action)
  }

  private actionAccepted(actual: string | undefined, expected: string): boolean {
    if (actual === undefined || actual === "") {
      if (!this.turnstileActionNoticeLogged) {
        this.turnstileActionNoticeLogged = true
        this.log("Turnstile token carried no action; binding not enforced (soft-enforce)", {
          expected,
        })
      }
      return true
    }
    if (actual === expected) return true
    this.log("Turnstile token rejected: action mismatch", { expected, actual })
    return false
  }

  private hostnameAccepted(hostname: string | undefined): boolean {
    const allowed = this.config.turnstileHostnames
    if (!allowed || allowed.length === 0) {
      if (!this.turnstileHostNoticeLogged) {
        this.turnstileHostNoticeLogged = true
        this.log(
          "Turnstile hostname binding not configured; siteverify hostname is not asserted (L16). Set the expected web origins.",
        )
      }
      return true
    }
    if (hostname === undefined || hostname.length === 0) return false
    const normalized = hostname.trim().toLowerCase()
    return allowed.some((h) => h.trim().toLowerCase() === normalized)
  }

  async pHash(buffer: Uint8Array): Promise<string> {
    if (this.config.perceptualHash) {
      return this.config.perceptualHash(buffer)
    }
    return fnv1a64Hex(buffer)
  }

  async isNearDuplicate(hash: string, opts?: FindPhashDuplicateOpts): Promise<NearDuplicateResult> {
    if (this.config.findPhashDuplicate) {
      return opts === undefined
        ? this.config.findPhashDuplicate(hash)
        : this.config.findPhashDuplicate(hash, opts)
    }
    return { dup: false }
  }

  hasNsfwScorer(): boolean {
    return this.config.useRealNsfw === true && this.config.nsfwModel !== undefined
  }

  async nsfwScore(buffer: Uint8Array): Promise<number> {
    if (this.config.useRealNsfw && this.config.nsfwModel) {
      return this.config.nsfwModel(buffer)
    }
    if (!this.nsfwNoticeLogged) {
      this.nsfwNoticeLogged = true
      this.log(
        this.config.useRealNsfw
          ? "NSFW model enabled (USE_REAL_NSFW) but not configured; NO VERDICT; anon media will be held for review"
          : "NSFW model not configured; NO VERDICT; anon media will be held for review. Enable with USE_REAL_NSFW + a model.",
      )
    }
    return 0
  }

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

function turnstileFailure(result: Exclude<FetchJsonResult<unknown>, { ok: true }>): AppError {
  const wrapped = AppError.internal(
    result.kind === "http"
      ? `Turnstile verification returned HTTP ${result.status}`
      : result.kind === "body"
        ? "Turnstile verification returned a non-JSON body"
        : "Turnstile verification request failed",
  )
  if (result.kind !== "http") (wrapped as { cause?: unknown }).cause = result.error
  return wrapped
}

function fnv1a64Hex(buffer: Uint8Array): string {
  let lo = FNV1A_32_OFFSET_BASIS
  let hi = FNV1A_32_OFFSET_BASIS
  for (let i = 0; i < buffer.length; i++) {
    const b = buffer[i] ?? 0
    lo = Math.imul(lo ^ b, FNV1A_32_PRIME) >>> 0
    hi = Math.imul(hi ^ (b ^ (i & 0xff)), FNV1A_32_PRIME) >>> 0
  }
  const toHex8 = (n: number): string => (n >>> 0).toString(16).padStart(8, "0")
  return toHex8(hi) + toHex8(lo)
}
