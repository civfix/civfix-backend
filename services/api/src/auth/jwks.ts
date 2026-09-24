import { AppError, ErrorCode } from "@civfix/shared"
import { exposeMessage } from "../errors/exposed-message.js"
import { constantTimeStringEqual } from "./crypto.js"
import { sha256HexSync } from "../lib/hash.js"

const JWKS_CACHE_TTL_MS = 60 * 60 * 1000

/**
 * Floor between two forced refetches for an unknown `kid`, so a stream of tokens naming forged kids cannot
 * turn into a fetch storm against the provider.
 */
const JWKS_FORCE_REFRESH_FLOOR_MS = 60 * 1000

const JWKS_FETCH_TIMEOUT_MS = 5000

const ID_TOKEN_ALG = "RS256"

const RSA_SIGNATURE_ALGORITHM = "RSASSA-PKCS1-v1_5"

const JWT_SEGMENT_COUNT = 3

export interface VerifiedIdToken {
  sub: string
  email: string | null
  emailVerified: boolean
  name: string | null
  picture: string | null
}

export interface VerifyParams {
  jwksUrl: string
  issuers: string[]
  audiences: string[]
  expectedNonce?: string
  nowSeconds?: number
}

export interface JwksVerifier {
  verify(idToken: string, params: VerifyParams): Promise<VerifiedIdToken>
}

interface Jwk {
  kid?: string
  kty?: string
  alg?: string
  use?: string
  n?: string
  e?: string
}

interface JwtHeader {
  alg?: string
  kid?: string
  typ?: string
}

interface JwtClaims {
  iss?: string
  aud?: string | string[]
  sub?: string
  exp?: number
  nbf?: number
  nonce?: string
  email?: string
  email_verified?: boolean | string
  name?: string
  picture?: string
}

export type FetchLike = (url: string) => Promise<{ ok: boolean; json(): Promise<unknown> }>

export interface RemoteJwksVerifierOptions {
  fetchImpl?: FetchLike
  cacheTtlMs?: number
  now?: () => number
}

interface CachedJwks {
  keys: Jwk[]
  fetchedAtMs: number
}

export class RemoteJwksVerifier implements JwksVerifier {
  private readonly fetchImpl: FetchLike
  private readonly cacheTtlMs: number
  private readonly now: () => number
  private readonly cache = new Map<string, CachedJwks>()
  private readonly lastForceRefreshAtMs = new Map<string, number>()
  private readonly inFlight = new Map<string, Promise<Jwk[]>>()

  constructor(opts: RemoteJwksVerifierOptions = {}) {
    this.fetchImpl = opts.fetchImpl ?? defaultFetch
    this.cacheTtlMs = opts.cacheTtlMs ?? JWKS_CACHE_TTL_MS
    this.now = opts.now ?? Date.now
  }

  async verify(idToken: string, params: VerifyParams): Promise<VerifiedIdToken> {
    const parts = idToken.split(".")
    if (parts.length !== JWT_SEGMENT_COUNT) {
      throw AppError.unauthorized("Malformed identity token.")
    }
    const [headerB64, payloadB64, signatureB64] = parts as [string, string, string]

    const header = decodeJsonSegment<JwtHeader>(headerB64)
    if (!header || header.alg !== ID_TOKEN_ALG || !header.kid) {
      throw AppError.unauthorized("Unsupported identity token algorithm.")
    }

    const jwk = await this.resolveKey(params.jwksUrl, header.kid)
    const valid = await verifyRs256(jwk, `${headerB64}.${payloadB64}`, signatureB64)
    if (!valid) {
      throw AppError.unauthorized("Identity token signature is invalid.")
    }

    const claims = decodeJsonSegment<JwtClaims>(payloadB64)
    if (!claims) {
      throw AppError.unauthorized("Malformed identity token payload.")
    }
    return validateClaims(claims, params, this.now)
  }

  private async resolveKey(jwksUrl: string, kid: string): Promise<Jwk> {
    let keys = await this.getKeys(jwksUrl, false)
    let match = keys.find((k) => k.kid === kid)
    if (!match) {
      const last = this.lastForceRefreshAtMs.get(jwksUrl)
      if (last === undefined || this.now() - last >= JWKS_FORCE_REFRESH_FLOOR_MS) {
        this.lastForceRefreshAtMs.set(jwksUrl, this.now())
        keys = await this.getKeys(jwksUrl, true)
        match = keys.find((k) => k.kid === kid)
      }
    }
    if (!match) {
      throw AppError.unauthorized("Identity token key not found.")
    }
    return match
  }

  private async getKeys(jwksUrl: string, forceRefresh: boolean): Promise<Jwk[]> {
    const cached = this.cache.get(jwksUrl)
    if (!forceRefresh && cached && this.now() - cached.fetchedAtMs < this.cacheTtlMs) {
      return cached.keys
    }
    const existing = this.inFlight.get(jwksUrl)
    if (existing) return existing
    const promise = this.fetchKeys(jwksUrl).finally(() => {
      this.inFlight.delete(jwksUrl)
    })
    this.inFlight.set(jwksUrl, promise)
    return promise
  }

  private async fetchKeys(jwksUrl: string): Promise<Jwk[]> {
    const res = await this.fetchImpl(jwksUrl)
    if (!res.ok) {
      // Not 401: failing to reach Apple or Google says nothing about the presented credential. A 401 tells
      // the client to re-authenticate during a provider outage, and every retry burns another single-use
      // sign-in nonce. 503 says "retry", not "sign in again".
      // A genuinely unknown `kid` still yields 401 (resolveKey).
      throw exposeMessage(
        new AppError(ErrorCode.INTERNAL, "Could not reach the identity provider.", {
          httpStatus: 503,
        }),
      )
    }
    const body = (await res.json()) as { keys?: Jwk[] }
    const keys = Array.isArray(body.keys) ? body.keys : []
    this.cache.set(jwksUrl, { keys, fetchedAtMs: this.now() })
    return keys
  }
}

const defaultFetch: FetchLike = async (url: string) => {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), JWKS_FETCH_TIMEOUT_MS)
  try {
    const res = await fetch(url, { redirect: "error", signal: controller.signal })
    if (!res.ok) return { ok: false, json: () => Promise.resolve(null) }
    const body = await res.json()
    return { ok: true, json: () => Promise.resolve(body) }
  } catch {
    // Timeout, DNS failure and an unparseable body all mean "provider unreachable", which fetchKeys
    // answers with a retryable 503 rather than a 401 that would tell the client to sign in again.
    return { ok: false, json: () => Promise.resolve(null) }
  } finally {
    clearTimeout(timer)
  }
}

function decodeJsonSegment<T>(segment: string): T | null {
  try {
    const json = Buffer.from(segment, "base64url").toString("utf8")
    return JSON.parse(json) as T
  } catch {
    return null
  }
}

function nonceMatches(claimNonce: string | undefined, expected: string): boolean {
  if (typeof claimNonce !== "string" || claimNonce.length === 0) return false
  const expectedHash = sha256HexSync(expected)
  return (
    constantTimeStringEqual(claimNonce, expected) ||
    constantTimeStringEqual(claimNonce, expectedHash)
  )
}

async function verifyRs256(jwk: Jwk, signingInput: string, signatureB64: string): Promise<boolean> {
  if (jwk.kty !== "RSA" || !jwk.n || !jwk.e) return false
  const key = await crypto.subtle.importKey(
    "jwk",
    { kty: "RSA", n: jwk.n, e: jwk.e, alg: ID_TOKEN_ALG, ext: true },
    { name: RSA_SIGNATURE_ALGORITHM, hash: "SHA-256" },
    false,
    ["verify"],
  )
  const signature = Buffer.from(signatureB64, "base64url")
  const data = new TextEncoder().encode(signingInput)
  return crypto.subtle.verify(RSA_SIGNATURE_ALGORITHM, key, signature, data)
}

/**
 * Skew tolerance for the NOT-YET-VALID check, matching the Cloudflare Access verifier's `clockTolerance`
 * (cf-access.ts). Our clock and the provider's are not synchronized, so a token minted moments ago can
 * carry an `nbf` a second or two in OUR future; refusing it fails a sign-in for no reason other than drift
 * AND burns the caller's single-use nonce, forcing the whole platform sheet again.
 *
 * `exp` deliberately keeps ZERO tolerance: an expired credential is expired, and a token that lapses
 * in-flight costs at most one retry, so there is nothing here worth trading acceptance-after-expiry for.
 */
const NOT_YET_VALID_TOLERANCE_SECONDS = 30

function validateClaims(
  claims: JwtClaims,
  params: VerifyParams,
  now: () => number,
): VerifiedIdToken {
  const nowSec = params.nowSeconds ?? Math.floor(now() / 1000)

  if (!claims.iss || !params.issuers.includes(claims.iss)) {
    throw AppError.unauthorized("Identity token issuer mismatch.")
  }
  const auds = Array.isArray(claims.aud) ? claims.aud : claims.aud ? [claims.aud] : []
  if (!auds.some((a) => params.audiences.includes(a))) {
    throw AppError.unauthorized("Identity token audience mismatch.")
  }
  if (typeof claims.exp !== "number" || claims.exp <= nowSec) {
    throw AppError.unauthorized("Identity token has expired.")
  }
  if (typeof claims.nbf === "number" && claims.nbf > nowSec + NOT_YET_VALID_TOLERANCE_SECONDS) {
    throw AppError.unauthorized("Identity token is not yet valid.")
  }
  if (!claims.sub) {
    throw AppError.unauthorized("Identity token is missing a subject.")
  }
  if (params.expectedNonce !== undefined) {
    if (!nonceMatches(claims.nonce, params.expectedNonce)) {
      throw AppError.unauthorized("Identity token nonce mismatch.")
    }
  }

  return {
    sub: claims.sub,
    email: typeof claims.email === "string" ? claims.email : null,
    emailVerified:
      claims.email_verified === true || claims.email_verified === "true" ? true : false,
    name: typeof claims.name === "string" ? claims.name : null,
    picture: typeof claims.picture === "string" ? claims.picture : null,
  }
}
